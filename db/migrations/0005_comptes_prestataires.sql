-- 0005 — Comptes prestataires par invitation ; vision complète de l'administrateur sur son organisation.
--
-- Principe : un prestataire n'est rattaché à l'annuaire d'un client qu'avec son propre consentement.
-- Le dispatcheur invite une adresse e-mail depuis la fiche d'annuaire ; l'acceptation crée l'organisation
-- prestataire (administrateur = l'invité) et pose seulement alors prestataire_org_id.

ALTER TABLE invitation ADD COLUMN annuaire_id uuid REFERENCES prestataire_annuaire (id);
CREATE INDEX invitation_annuaire_idx ON invitation (annuaire_id) WHERE annuaire_id IS NOT NULL;

ALTER TABLE prestataire_annuaire
  ADD COLUMN invitation_email text,
  ADD COLUMN invitation_envoyee_le timestamptz;

-- Le rattachement direct par identifiant est fermé à l'API : nova_app n'a plus aucun droit d'écriture sur
-- prestataire_org_id. La colonne ne change que par acceptation d'invitation (fonctions app.invitation_accept_*,
-- exécutées sous nova_owner) ou par le back-office (connexion propriétaire).
REVOKE INSERT, UPDATE ON prestataire_annuaire FROM nova_app;
GRANT INSERT (org_id, nom, contact_nom, contact_email, contact_telephone, zone, statut, assurance_expire_le, notes, deleted_at)
  ON prestataire_annuaire TO nova_app;
GRANT UPDATE (nom, contact_nom, contact_email, contact_telephone, zone, statut, assurance_expire_le, notes, deleted_at, updated_at)
  ON prestataire_annuaire TO nova_app;

-- Les fonctions SECURITY DEFINER s'exécutent sous nova_owner (RLS forcée) : l'acceptation d'invitation pose le rattachement.
CREATE POLICY annuaire_interne ON prestataire_annuaire FOR ALL TO nova_owner USING (true) WITH CHECK (true);

-- Invitation d'un prestataire depuis une fiche d'annuaire du client courant.
-- Crée (ou réutilise) l'organisation prestataire en attente, révoque l'invitation précédente de la fiche.
CREATE FUNCTION app.inviter_prestataire(p_annuaire uuid, p_email text, p_token_hash text, p_expires timestamptz)
RETURNS uuid
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public, app AS $$
DECLARE
  v_client uuid := app.current_org();
  v_user uuid := app.current_user_id();
  a public.prestataire_annuaire%ROWTYPE;
  v_org uuid;
BEGIN
  IF v_client IS NULL OR NOT EXISTS (SELECT 1 FROM public.organisation WHERE id = v_client AND type = 'property_manager' AND statut = 'actif') THEN
    RAISE EXCEPTION 'seul un property manager invite un prestataire' USING ERRCODE = '42501';
  END IF;
  SELECT * INTO a FROM public.prestataire_annuaire WHERE id = p_annuaire AND org_id = v_client AND deleted_at IS NULL FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'fiche introuvable' USING ERRCODE = 'P0002';
  END IF;
  IF a.prestataire_org_id IS NOT NULL THEN
    RAISE EXCEPTION 'prestataire déjà rattaché' USING ERRCODE = '23505';
  END IF;
  SELECT org_id INTO v_org FROM public.invitation
   WHERE annuaire_id = p_annuaire AND accepted_at IS NULL ORDER BY created_at DESC LIMIT 1;
  UPDATE public.invitation SET revoked_at = now()
   WHERE annuaire_id = p_annuaire AND accepted_at IS NULL AND revoked_at IS NULL;
  IF v_org IS NULL THEN
    INSERT INTO public.organisation (type, nom) VALUES ('prestataire', a.nom) RETURNING id INTO v_org;
  END IF;
  INSERT INTO public.invitation (org_id, email, role, token_hash, expires_at, invited_by, annuaire_id)
  VALUES (v_org, lower(p_email), 'admin_org', p_token_hash, p_expires, v_user, p_annuaire);
  UPDATE public.prestataire_annuaire SET invitation_email = lower(p_email), invitation_envoyee_le = now() WHERE id = p_annuaire;
  RETURN v_org;
END $$;

-- L'acceptation rattache la fiche d'annuaire à l'organisation prestataire.
CREATE OR REPLACE FUNCTION app.invitation_accept_new(p_token_hash text, p_password_hash text, p_nom text) RETURNS uuid
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public, app AS $$
DECLARE i public.invitation%ROWTYPE; v_user uuid;
BEGIN
  SELECT * INTO i FROM public.invitation WHERE token_hash = p_token_hash FOR UPDATE;
  IF NOT FOUND OR i.accepted_at IS NOT NULL OR i.revoked_at IS NOT NULL OR i.expires_at <= now() THEN
    RAISE EXCEPTION 'invitation invalide ou expirée' USING ERRCODE = '42501';
  END IF;
  IF EXISTS (SELECT 1 FROM public.utilisateur WHERE lower(email) = lower(i.email)) THEN
    RAISE EXCEPTION 'compte existant : connectez-vous pour accepter' USING ERRCODE = '23505';
  END IF;
  INSERT INTO public.utilisateur (email, nom) VALUES (lower(i.email), p_nom) RETURNING id INTO v_user;
  INSERT INTO public.credential (utilisateur_id, password_hash) VALUES (v_user, p_password_hash);
  INSERT INTO public.appartenance (utilisateur_id, org_id, role) VALUES (v_user, i.org_id, i.role);
  UPDATE public.invitation SET accepted_at = now() WHERE id = i.id;
  IF i.annuaire_id IS NOT NULL THEN
    UPDATE public.prestataire_annuaire SET prestataire_org_id = i.org_id WHERE id = i.annuaire_id AND prestataire_org_id IS NULL;
  END IF;
  RETURN v_user;
END $$;

CREATE OR REPLACE FUNCTION app.invitation_accept_existing(p_token_hash text, p_user uuid) RETURNS uuid
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public, app AS $$
DECLARE i public.invitation%ROWTYPE; v_email text;
BEGIN
  SELECT * INTO i FROM public.invitation WHERE token_hash = p_token_hash FOR UPDATE;
  IF NOT FOUND OR i.accepted_at IS NOT NULL OR i.revoked_at IS NOT NULL OR i.expires_at <= now() THEN
    RAISE EXCEPTION 'invitation invalide ou expirée' USING ERRCODE = '42501';
  END IF;
  SELECT email INTO v_email FROM public.utilisateur WHERE id = p_user AND statut = 'actif';
  IF v_email IS NULL OR lower(v_email) <> lower(i.email) THEN
    RAISE EXCEPTION 'cette invitation est destinée à une autre adresse' USING ERRCODE = '42501';
  END IF;
  INSERT INTO public.appartenance (utilisateur_id, org_id, role) VALUES (p_user, i.org_id, i.role)
  ON CONFLICT (utilisateur_id, org_id) DO UPDATE SET role = EXCLUDED.role, actif = true;
  UPDATE public.invitation SET accepted_at = now() WHERE id = i.id;
  IF i.annuaire_id IS NOT NULL THEN
    UPDATE public.prestataire_annuaire SET prestataire_org_id = i.org_id WHERE id = i.annuaire_id AND prestataire_org_id IS NULL;
  END IF;
  RETURN i.org_id;
END $$;

-- Vision de l'administrateur : membres de l'organisation courante (identité = table non lisible par nova_app).
CREATE FUNCTION app.org_membres()
RETURNS TABLE (utilisateur_id uuid, email text, nom text, role text, actif boolean, mfa_active boolean, depuis timestamptz, derniere_connexion timestamptz)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, public, app AS $$
  SELECT u.id, u.email, u.nom, a.role, a.actif,
         COALESCE((SELECT c.mfa_enabled FROM public.credential c WHERE c.utilisateur_id = u.id), false),
         a.created_at,
         (SELECT max(s.created_at) FROM public.session_refresh s WHERE s.utilisateur_id = u.id)
    FROM public.appartenance a
    JOIN public.utilisateur u ON u.id = a.utilisateur_id
   WHERE a.org_id = app.current_org() $$;

REVOKE ALL ON FUNCTION app.inviter_prestataire(uuid, text, text, timestamptz), app.org_membres() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.inviter_prestataire(uuid, text, text, timestamptz), app.org_membres() TO nova_app;

-- Le type d'organisation accompagne l'appartenance : le bailleur est en lecture seule sur le dispatch
-- (règle appliquée par OrgGuard, voir permissions.ts).
DROP FUNCTION app.resolve_membership(uuid, uuid);
CREATE FUNCTION app.resolve_membership(p_user uuid, p_org uuid)
RETURNS TABLE (role text, mfa_obligatoire boolean, org_type text)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, public, app AS $$
  SELECT a.role, r.mfa_obligatoire, o.type
    FROM public.appartenance a
    JOIN public.organisation o ON o.id = a.org_id AND o.statut = 'actif'
    JOIN public.utilisateur u ON u.id = a.utilisateur_id AND u.statut = 'actif'
    JOIN public.role r ON r.code = a.role
   WHERE a.utilisateur_id = p_user AND a.org_id = p_org AND a.actif $$;
REVOKE ALL ON FUNCTION app.resolve_membership(uuid, uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.resolve_membership(uuid, uuid) TO nova_app;

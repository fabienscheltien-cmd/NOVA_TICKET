-- 0002 — Identité : rôles, identifiants, sessions, invitations, appartenance vérifiée.
-- Les opérations d'authentification s'exécutent SANS espace de travail (l'utilisateur n'en a pas
-- encore choisi) : elles passent uniquement par des fonctions SECURITY DEFINER, jamais par des
-- lectures directes. Les tables sensibles n'ont aucune politique pour nova_app (0 ligne, aucun droit).

ALTER TABLE organisation ADD COLUMN statut text NOT NULL DEFAULT 'actif' CHECK (statut IN ('actif', 'desactive'));
ALTER TABLE utilisateur  ADD COLUMN statut text NOT NULL DEFAULT 'actif' CHECK (statut IN ('actif', 'desactive'));
CREATE UNIQUE INDEX utilisateur_email_lower_uq ON utilisateur (lower(email));

-- Les fonctions SECURITY DEFINER s'exécutent sous nova_owner (soumis à la RLS forcée) :
-- politique dédiée à ce rôle NOLOGIN sur les tables d'identité.
CREATE POLICY organisation_interne ON organisation FOR ALL TO nova_owner USING (true) WITH CHECK (true);
CREATE POLICY utilisateur_interne ON utilisateur FOR ALL TO nova_owner USING (true) WITH CHECK (true);
CREATE POLICY appartenance_interne ON appartenance FOR ALL TO nova_owner USING (true) WITH CHECK (true);

-- Rôles (référentiel global). Les permissions sont portées par le code (apps/api/src/auth/permissions.ts).
CREATE TABLE role (
  code            text PRIMARY KEY,
  libelle         text NOT NULL,
  org_types       text[] NOT NULL,
  mfa_obligatoire boolean NOT NULL DEFAULT false
);
INSERT INTO role (code, libelle, org_types, mfa_obligatoire) VALUES
  ('admin_org',            'Administrateur d''organisation', ARRAY['bailleur','property_manager','prestataire'], true),
  ('gestionnaire_fm',      'Gestionnaire FM / dispatcheur',  ARRAY['property_manager','prestataire'], true),
  ('accueil',              'Accueil / hotline',              ARRAY['property_manager'], false),
  ('responsable_site',     'Responsable de site',            ARRAY['bailleur','property_manager'], false),
  ('asset_manager',        'Asset manager / direction',      ARRAY['bailleur','property_manager'], true),
  ('technicien',           'Technicien',                     ARRAY['prestataire'], false),
  ('prestataire_externe',  'Prestataire externe (invité)',   ARRAY['property_manager'], false),
  ('support',              'Support plateforme',             ARRAY['editeur'], true),
  ('super_admin',          'Super-administrateur plateforme', ARRAY['editeur'], true);
ALTER TABLE role ENABLE ROW LEVEL SECURITY;
ALTER TABLE role FORCE ROW LEVEL SECURITY;
CREATE POLICY role_lecture ON role FOR SELECT USING (true);
GRANT SELECT ON role TO nova_app;

ALTER TABLE appartenance ADD CONSTRAINT appartenance_role_fk FOREIGN KEY (role) REFERENCES role (code);

CREATE FUNCTION app.assert_role_for_org(p_role text, p_org uuid) RETURNS void
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = pg_catalog, public, app AS $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM public.role r JOIN public.organisation o ON o.id = p_org
                 WHERE r.code = p_role AND o.type = ANY (r.org_types)) THEN
    RAISE EXCEPTION 'le rôle % n''est pas autorisé pour ce type d''organisation', p_role USING ERRCODE = '23514';
  END IF;
END $$;

CREATE FUNCTION app.trg_appartenance_role() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public, app AS $$
BEGIN
  PERFORM app.assert_role_for_org(NEW.role, NEW.org_id);
  RETURN NEW;
END $$;
CREATE TRIGGER appartenance_role_ck BEFORE INSERT OR UPDATE OF role, org_id ON appartenance
  FOR EACH ROW EXECUTE FUNCTION app.trg_appartenance_role();

-- Tables d'authentification : aucune politique pour nova_app.
CREATE TABLE credential (
  utilisateur_id uuid PRIMARY KEY REFERENCES utilisateur (id),
  password_hash  text NOT NULL,
  mfa_secret_enc text,
  mfa_enabled    boolean NOT NULL DEFAULT false,
  failed_logins  int NOT NULL DEFAULT 0,
  locked_until   timestamptz,
  updated_at     timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE code_secours (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  utilisateur_id uuid NOT NULL REFERENCES utilisateur (id),
  code_hash      text NOT NULL,
  utilise_at     timestamptz
);
CREATE INDEX code_secours_user_idx ON code_secours (utilisateur_id);
CREATE TABLE session_refresh (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  utilisateur_id uuid NOT NULL REFERENCES utilisateur (id),
  famille        uuid NOT NULL,
  token_hash     text NOT NULL UNIQUE,
  expires_at     timestamptz NOT NULL,
  revoked_at     timestamptz,
  created_at     timestamptz NOT NULL DEFAULT now(),
  user_agent     text
);
CREATE INDEX session_refresh_user_idx ON session_refresh (utilisateur_id);
CREATE INDEX session_refresh_famille_idx ON session_refresh (famille);

CREATE TABLE invitation (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id      uuid NOT NULL REFERENCES organisation (id),
  email       text NOT NULL,
  role        text NOT NULL REFERENCES role (code),
  token_hash  text NOT NULL UNIQUE,
  expires_at  timestamptz NOT NULL,
  accepted_at timestamptz,
  revoked_at  timestamptz,
  invited_by  uuid REFERENCES utilisateur (id),
  created_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX invitation_org_idx ON invitation (org_id, created_at DESC);

DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['credential','code_secours','session_refresh','invitation'] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format('CREATE POLICY %I ON %I FOR ALL TO nova_owner USING (true) WITH CHECK (true)', t || '_interne', t);
  END LOOP;
END $$;

CREATE POLICY invitation_org ON invitation FOR ALL
  USING (org_id = app.current_org()) WITH CHECK (org_id = app.current_org());
GRANT SELECT, INSERT, UPDATE ON invitation TO nova_app;
-- credential, code_secours, session_refresh : aucun GRANT à nova_app.

-- Fonctions d'authentification (SECURITY DEFINER, liste figée par test) -----------------------------
CREATE FUNCTION app.auth_lookup(p_email text)
RETURNS TABLE (user_id uuid, password_hash text, mfa_enabled boolean, mfa_secret_enc text, statut text, locked_until timestamptz)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, public, app AS $$
  SELECT u.id, c.password_hash, c.mfa_enabled, c.mfa_secret_enc, u.statut, c.locked_until
    FROM public.utilisateur u JOIN public.credential c ON c.utilisateur_id = u.id
   WHERE lower(u.email) = lower(p_email) $$;

CREATE FUNCTION app.auth_get_user(p_user uuid)
RETURNS TABLE (user_id uuid, mfa_enabled boolean, mfa_secret_enc text, statut text, locked_until timestamptz, email text)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, public, app AS $$
  SELECT u.id, c.mfa_enabled, c.mfa_secret_enc, u.statut, c.locked_until, u.email
    FROM public.utilisateur u JOIN public.credential c ON c.utilisateur_id = u.id WHERE u.id = p_user $$;

-- Verrouillage après 5 échecs consécutifs : 15 minutes.
CREATE FUNCTION app.auth_register_failure(p_user uuid) RETURNS timestamptz
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public, app AS $$
DECLARE v_locked timestamptz;
BEGIN
  UPDATE public.credential
     SET failed_logins = CASE WHEN failed_logins + 1 >= 5 THEN 0 ELSE failed_logins + 1 END,
         locked_until = CASE WHEN failed_logins + 1 >= 5 THEN now() + interval '15 minutes' ELSE locked_until END,
         updated_at = now()
   WHERE utilisateur_id = p_user RETURNING locked_until INTO v_locked;
  RETURN v_locked;
END $$;

CREATE FUNCTION app.auth_register_success(p_user uuid) RETURNS void
LANGUAGE sql SECURITY DEFINER SET search_path = pg_catalog, public, app AS $$
  UPDATE public.credential SET failed_logins = 0, locked_until = NULL, updated_at = now() WHERE utilisateur_id = p_user $$;

CREATE FUNCTION app.mfa_begin(p_user uuid, p_secret_enc text) RETURNS void
LANGUAGE sql SECURITY DEFINER SET search_path = pg_catalog, public, app AS $$
  UPDATE public.credential SET mfa_secret_enc = p_secret_enc, mfa_enabled = false, updated_at = now()
   WHERE utilisateur_id = p_user AND NOT mfa_enabled $$;

CREATE FUNCTION app.mfa_confirm(p_user uuid, p_code_hashes text[]) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public, app AS $$
BEGIN
  UPDATE public.credential SET mfa_enabled = true, updated_at = now()
   WHERE utilisateur_id = p_user AND mfa_secret_enc IS NOT NULL AND NOT mfa_enabled;
  IF NOT FOUND THEN RAISE EXCEPTION 'MFA non initialisée ou déjà active'; END IF;
  DELETE FROM public.code_secours WHERE utilisateur_id = p_user;
  INSERT INTO public.code_secours (utilisateur_id, code_hash) SELECT p_user, unnest(p_code_hashes);
END $$;

CREATE FUNCTION app.mfa_use_backup(p_user uuid, p_hash text) RETURNS boolean
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public, app AS $$
BEGIN
  UPDATE public.code_secours SET utilise_at = now()
   WHERE utilisateur_id = p_user AND code_hash = p_hash AND utilise_at IS NULL;
  RETURN FOUND;
END $$;

CREATE FUNCTION app.session_create(p_user uuid, p_hash text, p_famille uuid, p_expires timestamptz, p_ua text) RETURNS void
LANGUAGE sql SECURITY DEFINER SET search_path = pg_catalog, public, app AS $$
  INSERT INTO public.session_refresh (utilisateur_id, famille, token_hash, expires_at, user_agent)
  VALUES (p_user, p_famille, p_hash, p_expires, p_ua) $$;

-- Rotation avec détection de réutilisation : un jeton déjà révoqué qui revient = vol probable,
-- toute la famille de sessions est révoquée.
CREATE FUNCTION app.session_rotate(p_old_hash text, p_new_hash text, p_expires timestamptz, p_ua text) RETURNS uuid
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public, app AS $$
DECLARE s public.session_refresh%ROWTYPE; v_statut text;
BEGIN
  SELECT * INTO s FROM public.session_refresh WHERE token_hash = p_old_hash FOR UPDATE;
  IF NOT FOUND THEN RETURN NULL; END IF;
  IF s.revoked_at IS NOT NULL THEN
    UPDATE public.session_refresh SET revoked_at = now() WHERE famille = s.famille AND revoked_at IS NULL;
    RETURN NULL;
  END IF;
  SELECT statut INTO v_statut FROM public.utilisateur WHERE id = s.utilisateur_id;
  IF s.expires_at <= now() OR v_statut IS DISTINCT FROM 'actif' THEN
    UPDATE public.session_refresh SET revoked_at = now() WHERE id = s.id;
    RETURN NULL;
  END IF;
  UPDATE public.session_refresh SET revoked_at = now() WHERE id = s.id;
  INSERT INTO public.session_refresh (utilisateur_id, famille, token_hash, expires_at, user_agent)
  VALUES (s.utilisateur_id, s.famille, p_new_hash, p_expires, p_ua);
  RETURN s.utilisateur_id;
END $$;

CREATE FUNCTION app.session_revoke(p_hash text) RETURNS void
LANGUAGE sql SECURITY DEFINER SET search_path = pg_catalog, public, app AS $$
  UPDATE public.session_refresh SET revoked_at = now()
   WHERE famille = (SELECT famille FROM public.session_refresh WHERE token_hash = p_hash) AND revoked_at IS NULL $$;

CREATE FUNCTION app.session_revoke_user(p_user uuid) RETURNS void
LANGUAGE sql SECURITY DEFINER SET search_path = pg_catalog, public, app AS $$
  UPDATE public.session_refresh SET revoked_at = now() WHERE utilisateur_id = p_user AND revoked_at IS NULL $$;

CREATE FUNCTION app.workspaces_of(p_user uuid)
RETURNS TABLE (org_id uuid, nom text, type text, role text, mfa_obligatoire boolean)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, public, app AS $$
  SELECT o.id, o.nom, o.type, a.role, r.mfa_obligatoire
    FROM public.appartenance a
    JOIN public.organisation o ON o.id = a.org_id AND o.statut = 'actif'
    JOIN public.utilisateur u ON u.id = a.utilisateur_id AND u.statut = 'actif'
    JOIN public.role r ON r.code = a.role
   WHERE a.utilisateur_id = p_user AND a.actif
   ORDER BY o.nom $$;

-- Vérifie l'appartenance avant toute pose de contexte (aucune ligne = refus).
CREATE FUNCTION app.resolve_membership(p_user uuid, p_org uuid)
RETURNS TABLE (role text, mfa_obligatoire boolean)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, public, app AS $$
  SELECT a.role, r.mfa_obligatoire
    FROM public.appartenance a
    JOIN public.organisation o ON o.id = a.org_id AND o.statut = 'actif'
    JOIN public.utilisateur u ON u.id = a.utilisateur_id AND u.statut = 'actif'
    JOIN public.role r ON r.code = a.role
   WHERE a.utilisateur_id = p_user AND a.org_id = p_org AND a.actif $$;

-- Invitations -------------------------------------------------------------------------------
CREATE FUNCTION app.invitation_accept_new(p_token_hash text, p_password_hash text, p_nom text) RETURNS uuid
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
  RETURN v_user;
END $$;

CREATE FUNCTION app.invitation_accept_existing(p_token_hash text, p_user uuid) RETURNS uuid
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
  RETURN i.org_id;
END $$;

-- Opérations d'administration plateforme : PAS de droit pour nova_app (back-office / CLI uniquement).
CREATE FUNCTION app.user_deactivate(p_user uuid) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public, app AS $$
BEGIN
  UPDATE public.utilisateur SET statut = 'desactive' WHERE id = p_user;
  UPDATE public.appartenance SET actif = false WHERE utilisateur_id = p_user;
  UPDATE public.session_refresh SET revoked_at = now() WHERE utilisateur_id = p_user AND revoked_at IS NULL;
END $$;

CREATE FUNCTION app.org_deactivate(p_org uuid) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public, app AS $$
BEGIN
  UPDATE public.organisation SET statut = 'desactive' WHERE id = p_org;
  UPDATE public.appartenance SET actif = false WHERE org_id = p_org;
  UPDATE public.invitation SET revoked_at = now() WHERE org_id = p_org AND accepted_at IS NULL AND revoked_at IS NULL;
  -- Sessions des utilisateurs qui n'ont plus aucune appartenance active.
  UPDATE public.session_refresh s SET revoked_at = now()
   WHERE s.revoked_at IS NULL
     AND s.utilisateur_id IN (SELECT a.utilisateur_id FROM public.appartenance a WHERE a.org_id = p_org)
     AND NOT EXISTS (SELECT 1 FROM public.appartenance a2 WHERE a2.utilisateur_id = s.utilisateur_id AND a2.actif);
END $$;

REVOKE ALL ON FUNCTION
  app.assert_role_for_org(text, uuid), app.auth_lookup(text), app.auth_get_user(uuid),
  app.auth_register_failure(uuid), app.auth_register_success(uuid), app.mfa_begin(uuid, text),
  app.mfa_confirm(uuid, text[]), app.mfa_use_backup(uuid, text),
  app.session_create(uuid, text, uuid, timestamptz, text), app.session_rotate(text, text, timestamptz, text),
  app.session_revoke(text), app.session_revoke_user(uuid), app.workspaces_of(uuid),
  app.resolve_membership(uuid, uuid), app.invitation_accept_new(text, text, text),
  app.invitation_accept_existing(text, uuid), app.user_deactivate(uuid), app.org_deactivate(uuid)
FROM PUBLIC;
REVOKE ALL ON FUNCTION app.trg_appartenance_role() FROM PUBLIC;

GRANT EXECUTE ON FUNCTION
  app.auth_lookup(text), app.auth_get_user(uuid),
  app.auth_register_failure(uuid), app.auth_register_success(uuid), app.mfa_begin(uuid, text),
  app.mfa_confirm(uuid, text[]), app.mfa_use_backup(uuid, text),
  app.session_create(uuid, text, uuid, timestamptz, text), app.session_rotate(text, text, timestamptz, text),
  app.session_revoke(text), app.session_revoke_user(uuid), app.workspaces_of(uuid),
  app.resolve_membership(uuid, uuid), app.invitation_accept_new(text, text, text),
  app.invitation_accept_existing(text, uuid)
TO nova_app;
-- assert_role_for_org, trg_appartenance_role, user_deactivate, org_deactivate : aucun droit pour nova_app.

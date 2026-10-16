-- 0006 — Mot de passe oublié : jeton à usage unique, court, haché ; toutes les sessions sont révoquées à la réinitialisation.

CREATE TABLE password_reset (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  utilisateur_id uuid NOT NULL REFERENCES utilisateur (id),
  token_hash     text NOT NULL UNIQUE,
  expires_at     timestamptz NOT NULL,
  used_at        timestamptz,
  created_at     timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX password_reset_user_idx ON password_reset (utilisateur_id, created_at DESC);
ALTER TABLE password_reset ENABLE ROW LEVEL SECURITY;
ALTER TABLE password_reset FORCE ROW LEVEL SECURITY;
CREATE POLICY password_reset_interne ON password_reset FOR ALL TO nova_owner USING (true) WITH CHECK (true);
-- Aucun GRANT à nova_app : seules les fonctions ci-dessous y accèdent.

-- Crée une demande pour l'adresse donnée. Renvoie l'adresse enregistrée si une demande a été créée, NULL sinon
-- (compte inconnu, désactivé, ou demande déjà faite il y a moins d'une minute) : l'API répond de la même façon dans tous les cas.
CREATE FUNCTION app.password_reset_create(p_email text, p_token_hash text, p_expires timestamptz) RETURNS text
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public, app AS $$
DECLARE v_user uuid; v_email text;
BEGIN
  SELECT u.id, u.email INTO v_user, v_email FROM public.utilisateur u
    JOIN public.credential c ON c.utilisateur_id = u.id
   WHERE lower(u.email) = lower(p_email) AND u.statut = 'actif';
  IF v_user IS NULL THEN RETURN NULL; END IF;
  IF EXISTS (SELECT 1 FROM public.password_reset WHERE utilisateur_id = v_user AND created_at > now() - interval '1 minute') THEN
    RETURN NULL;
  END IF;
  UPDATE public.password_reset SET used_at = now() WHERE utilisateur_id = v_user AND used_at IS NULL;
  INSERT INTO public.password_reset (utilisateur_id, token_hash, expires_at) VALUES (v_user, p_token_hash, p_expires);
  RETURN v_email;
END $$;

-- Consomme le jeton : nouveau mot de passe, compte déverrouillé, toutes les sessions révoquées.
-- La double authentification reste exigée à la connexion suivante (un mot de passe oublié ne la contourne pas).
CREATE FUNCTION app.password_reset_consume(p_token_hash text, p_password_hash text) RETURNS uuid
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public, app AS $$
DECLARE r public.password_reset%ROWTYPE;
BEGIN
  SELECT * INTO r FROM public.password_reset WHERE token_hash = p_token_hash FOR UPDATE;
  IF NOT FOUND OR r.used_at IS NOT NULL OR r.expires_at <= now()
     OR NOT EXISTS (SELECT 1 FROM public.utilisateur WHERE id = r.utilisateur_id AND statut = 'actif') THEN
    RAISE EXCEPTION 'lien invalide ou expiré' USING ERRCODE = '42501';
  END IF;
  UPDATE public.credential SET password_hash = p_password_hash, failed_logins = 0, locked_until = NULL, updated_at = now()
   WHERE utilisateur_id = r.utilisateur_id;
  UPDATE public.password_reset SET used_at = now() WHERE utilisateur_id = r.utilisateur_id AND used_at IS NULL;
  UPDATE public.session_refresh SET revoked_at = now() WHERE utilisateur_id = r.utilisateur_id AND revoked_at IS NULL;
  RETURN r.utilisateur_id;
END $$;

REVOKE ALL ON FUNCTION app.password_reset_create(text, text, timestamptz), app.password_reset_consume(text, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.password_reset_create(text, text, timestamptz), app.password_reset_consume(text, text) TO nova_app;

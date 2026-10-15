-- 0001 — Fondations : identité, organisations, RLS, partage, fils.
-- Exécutée par le rôle nova_owner (voir apps/api/src/db/cli.ts). Tables minimales :
-- elles seront étendues par les incréments suivants (voir docs/phase1/02-erd.md).

CREATE SCHEMA app;
GRANT USAGE ON SCHEMA app, public TO nova_app;

-- Variables de session posées par transaction (SET LOCAL) par TenantDb.
CREATE FUNCTION app.current_org() RETURNS uuid LANGUAGE sql STABLE AS
$$ SELECT NULLIF(current_setting('app.org_id', true), '')::uuid $$;

CREATE FUNCTION app.current_user_id() RETURNS uuid LANGUAGE sql STABLE AS
$$ SELECT NULLIF(current_setting('app.user_id', true), '')::uuid $$;

-- Périmètre : '*' ou absent = tout l'espace actif ; sinon liste d'identifiants de sites.
CREATE FUNCTION app.in_scope(p_site uuid) RETURNS boolean LANGUAGE sql STABLE AS
$$ SELECT CASE
     WHEN coalesce(current_setting('app.scope_site_ids', true), '*') IN ('', '*') THEN true
     ELSE p_site = ANY (string_to_array(current_setting('app.scope_site_ids', true), ',')::uuid[])
   END $$;

CREATE TABLE organisation (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  type       text NOT NULL CHECK (type IN ('bailleur', 'property_manager', 'prestataire', 'editeur')),
  nom        text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE utilisateur (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  email      text NOT NULL UNIQUE,
  nom        text,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE appartenance (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  utilisateur_id uuid NOT NULL REFERENCES utilisateur (id),
  org_id         uuid NOT NULL REFERENCES organisation (id),
  role           text NOT NULL,
  actif          boolean NOT NULL DEFAULT true,
  created_at     timestamptz NOT NULL DEFAULT now(),
  UNIQUE (utilisateur_id, org_id)
);
CREATE INDEX appartenance_org_idx ON appartenance (org_id, role);

CREATE TABLE site (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id     uuid NOT NULL REFERENCES organisation (id),
  nom        text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX site_org_idx ON site (org_id);

CREATE TABLE ticket (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  owner_org_id    uuid NOT NULL REFERENCES organisation (id),
  managing_org_id uuid REFERENCES organisation (id),
  site_id         uuid NOT NULL REFERENCES site (id),
  titre           text NOT NULL,
  statut          text NOT NULL DEFAULT 'nouveau',
  created_at      timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX ticket_owner_idx ON ticket (owner_org_id, statut, created_at DESC);
CREATE INDEX ticket_site_idx ON ticket (site_id, statut);

CREATE TABLE acces_objet (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  objet_type      text NOT NULL CHECK (objet_type IN ('ticket', 'ordre_travail')),
  objet_id        uuid NOT NULL,
  org_id          uuid NOT NULL REFERENCES organisation (id),
  cree_par_org_id uuid NOT NULL REFERENCES organisation (id),
  created_at      timestamptz NOT NULL DEFAULT now(),
  revoque_at      timestamptz
);
CREATE INDEX acces_objet_org_idx ON acces_objet (org_id, objet_type, objet_id);
CREATE INDEX acces_objet_objet_idx ON acces_objet (objet_type, objet_id);
CREATE UNIQUE INDEX acces_objet_actif_uq ON acces_objet (objet_type, objet_id, org_id) WHERE revoque_at IS NULL;

CREATE TABLE fil (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  ticket_id          uuid NOT NULL REFERENCES ticket (id),
  type               text NOT NULL CHECK (type IN ('partage_ticket', 'interne', 'principal_soustraitant')),
  cree_par_org_id    uuid NOT NULL REFERENCES organisation (id),
  created_at         timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX fil_ticket_idx ON fil (ticket_id);

CREATE TABLE fil_participant (
  fil_id uuid NOT NULL REFERENCES fil (id),
  org_id uuid NOT NULL REFERENCES organisation (id),
  PRIMARY KEY (fil_id, org_id)
);
CREATE INDEX fil_participant_org_idx ON fil_participant (org_id, fil_id);

CREATE TABLE message (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  fil_id          uuid NOT NULL REFERENCES fil (id),
  auteur_org_id   uuid NOT NULL REFERENCES organisation (id),
  auteur_id       uuid REFERENCES utilisateur (id),
  corps           text NOT NULL,
  created_at      timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX message_fil_idx ON message (fil_id, created_at);

-- RLS activée ET forcée partout.
DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['organisation','utilisateur','appartenance','site','ticket',
                           'acces_objet','fil','fil_participant','message']
  LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
  END LOOP;
END $$;

-- Politiques ---------------------------------------------------------------------------
CREATE POLICY organisation_self ON organisation FOR SELECT USING (id = app.current_org());

CREATE POLICY utilisateur_membres ON utilisateur FOR SELECT USING (
  EXISTS (SELECT 1 FROM appartenance a
          WHERE a.utilisateur_id = utilisateur.id AND a.org_id = app.current_org() AND a.actif));

CREATE POLICY appartenance_org ON appartenance FOR ALL
  USING (org_id = app.current_org()) WITH CHECK (org_id = app.current_org());

CREATE POLICY site_org ON site FOR ALL
  USING (org_id = app.current_org() AND app.in_scope(id))
  WITH CHECK (org_id = app.current_org());

CREATE POLICY ticket_select ON ticket FOR SELECT USING (
  ((owner_org_id = app.current_org() OR managing_org_id = app.current_org()) AND app.in_scope(site_id))
  OR EXISTS (SELECT 1 FROM acces_objet a
             WHERE a.objet_type = 'ticket' AND a.objet_id = ticket.id
               AND a.org_id = app.current_org() AND a.revoque_at IS NULL));
CREATE POLICY ticket_insert ON ticket FOR INSERT WITH CHECK (
  owner_org_id = app.current_org() OR managing_org_id = app.current_org());
CREATE POLICY ticket_update ON ticket FOR UPDATE
  USING (owner_org_id = app.current_org() OR managing_org_id = app.current_org())
  WITH CHECK (owner_org_id = app.current_org() OR managing_org_id = app.current_org());

CREATE POLICY acces_objet_cible ON acces_objet FOR SELECT USING (org_id = app.current_org());
CREATE POLICY fil_participant_self ON fil_participant FOR SELECT USING (org_id = app.current_org());

CREATE POLICY fil_participant_visible ON fil FOR SELECT USING (
  EXISTS (SELECT 1 FROM fil_participant p WHERE p.fil_id = fil.id AND p.org_id = app.current_org()));

CREATE POLICY message_select ON message FOR SELECT USING (
  EXISTS (SELECT 1 FROM fil_participant p WHERE p.fil_id = message.fil_id AND p.org_id = app.current_org()));
CREATE POLICY message_insert ON message FOR INSERT WITH CHECK (
  auteur_org_id = app.current_org()
  AND EXISTS (SELECT 1 FROM fil_participant p WHERE p.fil_id = message.fil_id AND p.org_id = app.current_org()));

-- Les écritures de partage passent uniquement par les fonctions SECURITY DEFINER ci-dessous,
-- exécutées par nova_owner (rôle NOLOGIN) : politique dédiée à ce rôle.
CREATE POLICY acces_objet_interne ON acces_objet FOR ALL TO nova_owner USING (true) WITH CHECK (true);
CREATE POLICY fil_interne ON fil FOR ALL TO nova_owner USING (true) WITH CHECK (true);
CREATE POLICY fil_participant_interne ON fil_participant FOR ALL TO nova_owner USING (true) WITH CHECK (true);

-- Droits de nova_app : le strict nécessaire, rien par défaut.
GRANT SELECT ON organisation, utilisateur, acces_objet, fil, fil_participant TO nova_app;
GRANT SELECT, INSERT, UPDATE ON appartenance, ticket TO nova_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON site TO nova_app;
GRANT SELECT, INSERT ON message TO nova_app;

-- Fonctions SECURITY DEFINER (liste figée, contrôlée par test de catalogue) ---------------
CREATE FUNCTION app.assert_ticket_manager(p_ticket uuid) RETURNS void
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = pg_catalog, public, app AS $$
BEGIN
  IF app.current_org() IS NULL THEN
    RAISE EXCEPTION 'espace de travail absent' USING ERRCODE = '42501';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM public.ticket t WHERE t.id = p_ticket
                 AND (t.owner_org_id = app.current_org() OR t.managing_org_id = app.current_org())) THEN
    RAISE EXCEPTION 'ticket inaccessible ou non gérable par cette organisation' USING ERRCODE = '42501';
  END IF;
END $$;

-- TODO incrément 3 : exiger un contrat de service actif entre l'organisation et le prestataire.
CREATE FUNCTION app.share_ticket(p_ticket uuid, p_org uuid) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public, app AS $$
BEGIN
  PERFORM app.assert_ticket_manager(p_ticket);
  INSERT INTO public.acces_objet (objet_type, objet_id, org_id, cree_par_org_id)
  VALUES ('ticket', p_ticket, p_org, app.current_org())
  ON CONFLICT (objet_type, objet_id, org_id) WHERE revoque_at IS NULL DO NOTHING;
END $$;

CREATE FUNCTION app.revoke_ticket_share(p_ticket uuid, p_org uuid) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public, app AS $$
BEGIN
  PERFORM app.assert_ticket_manager(p_ticket);
  UPDATE public.acces_objet SET revoque_at = now()
   WHERE objet_type = 'ticket' AND objet_id = p_ticket AND org_id = p_org AND revoque_at IS NULL;
END $$;

-- Types gérés ici : 'partage_ticket' (participants = organisations ayant accès au ticket)
-- et 'interne' (l'organisation appelante seule). 'principal_soustraitant' : incrément 6.
CREATE FUNCTION app.create_fil(p_ticket uuid, p_type text, p_orgs uuid[]) RETURNS uuid
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public, app AS $$
DECLARE v_fil uuid; v_org uuid;
BEGIN
  PERFORM app.assert_ticket_manager(p_ticket);
  IF p_type NOT IN ('partage_ticket', 'interne') THEN
    RAISE EXCEPTION 'type de fil non pris en charge: %', p_type;
  END IF;
  IF NOT (app.current_org() = ANY (p_orgs)) THEN
    RAISE EXCEPTION 'l''organisation appelante doit être participante' USING ERRCODE = '42501';
  END IF;
  IF p_type = 'interne' AND array_length(p_orgs, 1) <> 1 THEN
    RAISE EXCEPTION 'un fil interne n''a qu''un participant';
  END IF;
  FOREACH v_org IN ARRAY p_orgs LOOP
    IF NOT EXISTS (
      SELECT 1 FROM public.ticket t WHERE t.id = p_ticket AND (t.owner_org_id = v_org OR t.managing_org_id = v_org)
      UNION ALL
      SELECT 1 FROM public.acces_objet a
       WHERE a.objet_type = 'ticket' AND a.objet_id = p_ticket AND a.org_id = v_org AND a.revoque_at IS NULL
    ) THEN
      RAISE EXCEPTION 'organisation sans accès au ticket: %', v_org USING ERRCODE = '42501';
    END IF;
  END LOOP;
  INSERT INTO public.fil (ticket_id, type, cree_par_org_id) VALUES (p_ticket, p_type, app.current_org())
  RETURNING id INTO v_fil;
  INSERT INTO public.fil_participant (fil_id, org_id) SELECT v_fil, unnest(p_orgs);
  RETURN v_fil;
END $$;

REVOKE ALL ON FUNCTION app.assert_ticket_manager(uuid), app.share_ticket(uuid, uuid),
  app.revoke_ticket_share(uuid, uuid), app.create_fil(uuid, text, uuid[]) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.share_ticket(uuid, uuid), app.revoke_ticket_share(uuid, uuid),
  app.create_fil(uuid, text, uuid[]) TO nova_app;

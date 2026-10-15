-- 0003 — Patrimoine : portefeuilles, sites, bâtiments, niveaux, locaux, occupants, occupations,
-- mandats de gestion. La visibilité d'un property manager découle de ses mandats actifs.
--
-- Principe : app.visible_sites() calcule, une fois par requête, l'ensemble des sites visibles pour
-- l'espace actif (sites propres + sites couverts par un mandat actif), filtré par le périmètre de
-- l'utilisateur. Toutes les tables enfants portent org_id (bailleur propriétaire) et site_id
-- dénormalisés, avec des clés étrangères composites qui interdisent toute incohérence.

CREATE EXTENSION IF NOT EXISTS btree_gist;

-- Mandats de gestion -------------------------------------------------------------------------
CREATE TABLE portefeuille (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id     uuid NOT NULL REFERENCES organisation (id),
  nom        text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (id, org_id)
);
CREATE INDEX portefeuille_org_idx ON portefeuille (org_id);

CREATE TABLE mandat_gestion (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  bailleur_org_id uuid NOT NULL REFERENCES organisation (id),
  pm_org_id       uuid NOT NULL REFERENCES organisation (id),
  -- Périmètre : les deux nuls = tout le patrimoine du bailleur ; sinon un portefeuille OU un site.
  portefeuille_id uuid,
  site_id         uuid,
  debut           date NOT NULL DEFAULT current_date,
  fin             date,
  created_by      uuid REFERENCES utilisateur (id),
  created_at      timestamptz NOT NULL DEFAULT now(),
  CHECK (fin IS NULL OR fin > debut),
  CHECK (portefeuille_id IS NULL OR site_id IS NULL),
  CHECK (bailleur_org_id <> pm_org_id),
  FOREIGN KEY (portefeuille_id, bailleur_org_id) REFERENCES portefeuille (id, org_id)
);
CREATE INDEX mandat_pm_idx ON mandat_gestion (pm_org_id, bailleur_org_id);
CREATE INDEX mandat_bailleur_idx ON mandat_gestion (bailleur_org_id);

-- Sites -------------------------------------------------------------------------------------
ALTER TABLE site
  ADD COLUMN portefeuille_id uuid,
  ADD COLUMN reference   text,
  ADD COLUMN adresse     text,
  ADD COLUMN code_postal text,
  ADD COLUMN ville       text,
  ADD COLUMN pays        text NOT NULL DEFAULT 'FR',
  ADD COLUMN latitude    double precision CHECK (latitude BETWEEN -90 AND 90),
  ADD COLUMN longitude   double precision CHECK (longitude BETWEEN -180 AND 180),
  ADD COLUMN fuseau      text NOT NULL DEFAULT 'Europe/Paris',
  ADD COLUMN usage       text,
  ADD COLUMN surface_m2  numeric(12,2) CHECK (surface_m2 IS NULL OR surface_m2 >= 0),
  ADD COLUMN deleted_at  timestamptz,
  ADD CONSTRAINT site_id_org_uq UNIQUE (id, org_id),
  ADD CONSTRAINT site_portefeuille_fk FOREIGN KEY (portefeuille_id, org_id) REFERENCES portefeuille (id, org_id);
CREATE UNIQUE INDEX site_reference_uq ON site (org_id, reference) WHERE reference IS NOT NULL AND deleted_at IS NULL;
CREATE INDEX site_portefeuille_idx ON site (portefeuille_id);

ALTER TABLE mandat_gestion
  ADD CONSTRAINT mandat_site_fk FOREIGN KEY (site_id, bailleur_org_id) REFERENCES site (id, org_id);

ALTER TABLE ticket
  ADD CONSTRAINT ticket_site_owner_fk FOREIGN KEY (site_id, owner_org_id) REFERENCES site (id, org_id);

CREATE TABLE batiment (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id     uuid NOT NULL,
  site_id    uuid NOT NULL,
  nom        text NOT NULL,
  reference  text,
  surface_m2 numeric(12,2) CHECK (surface_m2 IS NULL OR surface_m2 >= 0),
  deleted_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (id, org_id, site_id),
  FOREIGN KEY (site_id, org_id) REFERENCES site (id, org_id)
);
CREATE INDEX batiment_site_idx ON batiment (site_id);

CREATE TABLE niveau (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id      uuid NOT NULL,
  site_id     uuid NOT NULL,
  batiment_id uuid NOT NULL,
  nom         text NOT NULL,
  ordre       int NOT NULL DEFAULT 0,
  deleted_at  timestamptz,
  created_at  timestamptz NOT NULL DEFAULT now(),
  UNIQUE (id, org_id, site_id),
  FOREIGN KEY (batiment_id, org_id, site_id) REFERENCES batiment (id, org_id, site_id)
);
CREATE INDEX niveau_batiment_idx ON niveau (batiment_id);

CREATE TABLE local (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id      uuid NOT NULL,
  site_id     uuid NOT NULL,
  niveau_id   uuid NOT NULL,
  reference   text,
  nom         text NOT NULL,
  type        text NOT NULL DEFAULT 'bureau'
              CHECK (type IN ('bureau','logement','commerce','local_technique','partie_commune','parking','stockage','autre')),
  surface_m2  numeric(12,2) CHECK (surface_m2 IS NULL OR surface_m2 >= 0),
  qr_code     text NOT NULL UNIQUE,
  deleted_at  timestamptz,
  created_at  timestamptz NOT NULL DEFAULT now(),
  UNIQUE (id, org_id, site_id),
  FOREIGN KEY (niveau_id, org_id, site_id) REFERENCES niveau (id, org_id, site_id)
);
CREATE INDEX local_niveau_idx ON local (niveau_id);
CREATE INDEX local_site_idx ON local (site_id);
CREATE UNIQUE INDEX local_reference_uq ON local (site_id, reference) WHERE reference IS NOT NULL AND deleted_at IS NULL;

-- Occupants : sans compte, appartiennent au bailleur propriétaire du patrimoine ---------------
CREATE TABLE occupant (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id          uuid NOT NULL REFERENCES organisation (id),
  cree_par_org_id uuid NOT NULL REFERENCES organisation (id),
  nom             text NOT NULL,
  type            text NOT NULL DEFAULT 'societe' CHECK (type IN ('societe', 'particulier')),
  deleted_at      timestamptz,
  created_at      timestamptz NOT NULL DEFAULT now(),
  UNIQUE (id, org_id)
);
CREATE INDEX occupant_org_idx ON occupant (org_id);

CREATE TABLE contact (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id      uuid NOT NULL,
  occupant_id uuid NOT NULL,
  nom         text NOT NULL,
  email       text,
  telephone   text,
  fonction    text,
  deleted_at  timestamptz,
  created_at  timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (occupant_id, org_id) REFERENCES occupant (id, org_id)
);
CREATE INDEX contact_occupant_idx ON contact (occupant_id);

CREATE TABLE occupation (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id      uuid NOT NULL,
  site_id     uuid NOT NULL,
  local_id    uuid NOT NULL,
  occupant_id uuid NOT NULL,
  debut       date NOT NULL DEFAULT current_date,
  fin         date,
  type        text NOT NULL DEFAULT 'locataire' CHECK (type IN ('locataire', 'proprietaire', 'autre')),
  surface_m2  numeric(12,2) CHECK (surface_m2 IS NULL OR surface_m2 >= 0),
  created_at  timestamptz NOT NULL DEFAULT now(),
  CHECK (fin IS NULL OR fin > debut),
  FOREIGN KEY (local_id, org_id, site_id) REFERENCES local (id, org_id, site_id),
  FOREIGN KEY (occupant_id, org_id) REFERENCES occupant (id, org_id),
  -- Plusieurs occupants simultanés dans un local : autorisé. Même occupant, même local, périodes
  -- qui se chevauchent : interdit.
  EXCLUDE USING gist (occupant_id WITH =, local_id WITH =, daterange(debut, COALESCE(fin, 'infinity'::date), '[)') WITH &&)
);
CREATE INDEX occupation_local_idx ON occupation (local_id) WHERE fin IS NULL;
CREATE INDEX occupation_occupant_idx ON occupation (occupant_id);
CREATE INDEX occupation_site_idx ON occupation (site_id);

-- RLS activée et forcée -----------------------------------------------------------------------
DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['portefeuille','mandat_gestion','batiment','niveau','local','occupant','contact','occupation']
  LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
  END LOOP;
END $$;

-- Politiques propres au rôle interne (fonctions SECURITY DEFINER uniquement).
CREATE POLICY site_interne ON site FOR ALL TO nova_owner USING (true) WITH CHECK (true);
CREATE POLICY mandat_interne ON mandat_gestion FOR ALL TO nova_owner USING (true) WITH CHECK (true);
CREATE POLICY portefeuille_interne ON portefeuille FOR ALL TO nova_owner USING (true) WITH CHECK (true);

-- Fonctions de visibilité ---------------------------------------------------------------------
CREATE FUNCTION app.visible_sites() RETURNS SETOF uuid
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, public, app AS $$
  SELECT s.id FROM public.site s
   WHERE s.org_id = app.current_org() AND app.in_scope(s.id)
  UNION
  SELECT s.id FROM public.site s
    JOIN public.mandat_gestion m ON m.bailleur_org_id = s.org_id AND m.pm_org_id = app.current_org()
   WHERE m.debut <= current_date AND (m.fin IS NULL OR m.fin > current_date)
     AND ((m.portefeuille_id IS NULL AND m.site_id IS NULL) OR m.site_id = s.id OR m.portefeuille_id = s.portefeuille_id)
     AND app.in_scope(s.id) $$;

-- Un mandat actif couvrant tout le bailleur, ou le portefeuille donné, autorise la création.
CREATE FUNCTION app.has_mandate_for(p_owner uuid, p_portefeuille uuid) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, public, app AS $$
  SELECT EXISTS (
    SELECT 1 FROM public.mandat_gestion m
     WHERE m.bailleur_org_id = p_owner AND m.pm_org_id = app.current_org()
       AND m.debut <= current_date AND (m.fin IS NULL OR m.fin > current_date)
       AND m.site_id IS NULL
       AND (m.portefeuille_id IS NULL OR m.portefeuille_id = p_portefeuille)) $$;

CREATE FUNCTION app.trg_mandat_check() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public, app AS $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM public.organisation WHERE id = NEW.bailleur_org_id AND type = 'bailleur' AND statut = 'actif') THEN
    RAISE EXCEPTION 'le mandant doit être un bailleur actif' USING ERRCODE = '23514';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM public.organisation WHERE id = NEW.pm_org_id AND type = 'property_manager' AND statut = 'actif') THEN
    RAISE EXCEPTION 'le mandataire doit être un property manager actif' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER mandat_gestion_ck BEFORE INSERT ON mandat_gestion
  FOR EACH ROW EXECUTE FUNCTION app.trg_mandat_check();

-- Le bailleur propriétaire d'une ligne ne change jamais (réversibilité : l'historique lui reste).
CREATE FUNCTION app.trg_org_immutable() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.org_id IS DISTINCT FROM OLD.org_id THEN
    RAISE EXCEPTION 'le bailleur propriétaire ne peut pas être modifié' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END $$;
DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['site','portefeuille','batiment','niveau','local','occupant','contact','occupation']
  LOOP
    EXECUTE format('CREATE TRIGGER %I BEFORE UPDATE ON %I FOR EACH ROW EXECUTE FUNCTION app.trg_org_immutable()', t || '_org_immutable', t);
  END LOOP;
END $$;

-- Politiques : organisation ---------------------------------------------------------------------
DROP POLICY organisation_self ON organisation;
CREATE POLICY organisation_visible ON organisation FOR SELECT USING (
  id = app.current_org()
  OR EXISTS (SELECT 1 FROM mandat_gestion m
              WHERE m.debut <= current_date AND (m.fin IS NULL OR m.fin > current_date)
                AND ((m.bailleur_org_id = organisation.id AND m.pm_org_id = app.current_org())
                  OR (m.pm_org_id = organisation.id AND m.bailleur_org_id = app.current_org()))));

-- Politiques : mandats (le bailleur crée et clôt ; le PM lit les siens) -------------------------
CREATE POLICY mandat_select ON mandat_gestion FOR SELECT
  USING (bailleur_org_id = app.current_org() OR pm_org_id = app.current_org());
CREATE POLICY mandat_insert ON mandat_gestion FOR INSERT WITH CHECK (bailleur_org_id = app.current_org());
CREATE POLICY mandat_update ON mandat_gestion FOR UPDATE
  USING (bailleur_org_id = app.current_org()) WITH CHECK (bailleur_org_id = app.current_org());

-- Politiques : portefeuilles ----------------------------------------------------------------------
CREATE POLICY portefeuille_select ON portefeuille FOR SELECT USING (
  org_id = app.current_org()
  OR EXISTS (SELECT 1 FROM mandat_gestion m
              WHERE m.bailleur_org_id = portefeuille.org_id AND m.pm_org_id = app.current_org()
                AND m.debut <= current_date AND (m.fin IS NULL OR m.fin > current_date)
                AND m.site_id IS NULL AND (m.portefeuille_id IS NULL OR m.portefeuille_id = portefeuille.id)));
CREATE POLICY portefeuille_insert ON portefeuille FOR INSERT
  WITH CHECK (org_id = app.current_org() OR app.has_mandate_for(org_id, NULL));
CREATE POLICY portefeuille_update ON portefeuille FOR UPDATE
  USING (org_id = app.current_org() OR app.has_mandate_for(org_id, id))
  WITH CHECK (org_id = app.current_org() OR app.has_mandate_for(org_id, id));

-- Politiques : sites ----------------------------------------------------------------------------
DROP POLICY site_org ON site;
-- Les deux premières branches rendent visible la ligne qu'une instruction INSERT ... RETURNING vient
-- de créer (la sous-requête visible_sites() ne voit pas les lignes de la même instruction).
CREATE POLICY site_select ON site FOR SELECT USING (
  (org_id = app.current_org() AND app.in_scope(id))
  OR (app.has_mandate_for(org_id, portefeuille_id) AND app.in_scope(id))
  OR id IN (SELECT app.visible_sites()));
CREATE POLICY site_insert ON site FOR INSERT
  WITH CHECK (org_id = app.current_org() OR app.has_mandate_for(org_id, portefeuille_id));
CREATE POLICY site_update ON site FOR UPDATE
  USING (id IN (SELECT app.visible_sites()))
  WITH CHECK (org_id = app.current_org() OR app.has_mandate_for(org_id, portefeuille_id)
              OR EXISTS (SELECT 1 FROM mandat_gestion m WHERE m.bailleur_org_id = site.org_id AND m.pm_org_id = app.current_org()
                          AND m.debut <= current_date AND (m.fin IS NULL OR m.fin > current_date) AND m.site_id = site.id));

-- Politiques : enfants du site ---------------------------------------------------------------------
DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['batiment','niveau','local','occupation']
  LOOP
    EXECUTE format('CREATE POLICY %I ON %I FOR ALL USING (site_id IN (SELECT app.visible_sites())) WITH CHECK (site_id IN (SELECT app.visible_sites()))',
                   t || '_site', t);
  END LOOP;
END $$;

-- Occupants : visibles du bailleur propriétaire, de leur créateur, et du PM qui voit un site occupé.
CREATE POLICY occupant_select ON occupant FOR SELECT USING (
  org_id = app.current_org()
  OR cree_par_org_id = app.current_org()
  OR EXISTS (SELECT 1 FROM occupation o WHERE o.occupant_id = occupant.id));
CREATE POLICY occupant_insert ON occupant FOR INSERT WITH CHECK (
  cree_par_org_id = app.current_org() AND (org_id = app.current_org() OR app.has_mandate_for(org_id, NULL)));
CREATE POLICY occupant_update ON occupant FOR UPDATE
  USING (org_id = app.current_org() OR cree_par_org_id = app.current_org() OR EXISTS (SELECT 1 FROM occupation o WHERE o.occupant_id = occupant.id))
  WITH CHECK (org_id = app.current_org() OR cree_par_org_id = app.current_org() OR EXISTS (SELECT 1 FROM occupation o WHERE o.occupant_id = occupant.id));

CREATE POLICY contact_all ON contact FOR ALL
  USING (occupant_id IN (SELECT id FROM occupant)) WITH CHECK (occupant_id IN (SELECT id FROM occupant));

-- Tickets : la visibilité d'un PM découle de ses mandats (l'ancien gestionnaire perd l'accès,
-- le nouveau hérite de l'historique, le bailleur reste propriétaire).
DROP POLICY ticket_select ON ticket;
DROP POLICY ticket_insert ON ticket;
DROP POLICY ticket_update ON ticket;
CREATE POLICY ticket_select ON ticket FOR SELECT USING (
  site_id IN (SELECT app.visible_sites())
  OR EXISTS (SELECT 1 FROM acces_objet a
             WHERE a.objet_type = 'ticket' AND a.objet_id = ticket.id
               AND a.org_id = app.current_org() AND a.revoque_at IS NULL));
CREATE POLICY ticket_insert ON ticket FOR INSERT WITH CHECK (
  site_id IN (SELECT app.visible_sites()) AND (owner_org_id = app.current_org() OR managing_org_id = app.current_org()));
CREATE POLICY ticket_update ON ticket FOR UPDATE
  USING (site_id IN (SELECT app.visible_sites()) AND (owner_org_id = app.current_org() OR managing_org_id = app.current_org()))
  WITH CHECK (site_id IN (SELECT app.visible_sites()) AND (owner_org_id = app.current_org() OR managing_org_id = app.current_org()));

-- Droits ------------------------------------------------------------------------------------------
GRANT SELECT, INSERT, UPDATE ON portefeuille, batiment, niveau, local, occupant, contact, occupation TO nova_app;
GRANT SELECT, INSERT, UPDATE ON mandat_gestion TO nova_app;
REVOKE DELETE ON site FROM nova_app;
REVOKE ALL ON FUNCTION app.visible_sites(), app.has_mandate_for(uuid, uuid), app.trg_mandat_check(), app.trg_org_immutable() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.visible_sites(), app.has_mandate_for(uuid, uuid) TO nova_app;

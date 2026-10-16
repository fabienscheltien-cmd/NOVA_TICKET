-- 0007 — Contrats de service, calendriers ouvrés, règles et instances SLA.
--
-- Tout est propre à l'organisation qui dispatche (le client du prestataire) : strictement RLS org_id = organisation courante.
-- Le prestataire ne lit ni contrat, ni règle, ni instance (visibilité côté prestataire : incrément ultérieur, avec les OT).
-- Les jours fériés ne sont PAS fournis : le client saisit ses fermetures (liste applicable par site à valider, doc 06).

ALTER TABLE organisation ADD COLUMN exiger_contrat boolean NOT NULL DEFAULT false;

CREATE TABLE calendrier_ouvre (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id     uuid NOT NULL REFERENCES organisation (id),
  nom        text NOT NULL CHECK (length(btrim(nom)) > 0),
  fuseau     text NOT NULL DEFAULT 'Europe/Paris',
  -- [{"jours":[1,2,3,4,5],"debut":"08:00","fin":"18:00"}] ; jours ISO 1 (lundi) à 7 ; validé par l'API (luxon) et le CHECK de forme
  plages     jsonb NOT NULL CHECK (jsonb_typeof(plages) = 'array' AND jsonb_array_length(plages) BETWEEN 1 AND 50),
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (id, org_id),
  UNIQUE (org_id, nom)
);

CREATE TABLE calendrier_fermeture (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id        uuid NOT NULL,
  calendrier_id uuid NOT NULL,
  du            date NOT NULL,
  au            date NOT NULL,
  libelle       text,
  CHECK (au >= du),
  FOREIGN KEY (calendrier_id, org_id) REFERENCES calendrier_ouvre (id, org_id) ON DELETE CASCADE
);
CREATE INDEX calendrier_fermeture_idx ON calendrier_fermeture (calendrier_id, du);

CREATE TABLE contrat_service (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id        uuid NOT NULL REFERENCES organisation (id),
  annuaire_id   uuid NOT NULL,
  libelle       text NOT NULL CHECK (length(btrim(libelle)) > 0),
  date_debut    date NOT NULL,
  date_fin      date,
  statut        text NOT NULL DEFAULT 'actif' CHECK (statut IN ('actif', 'suspendu')),
  calendrier_id uuid,
  notes         text,
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now(),
  CHECK (date_fin IS NULL OR date_fin >= date_debut),
  UNIQUE (id, org_id),
  FOREIGN KEY (annuaire_id, org_id) REFERENCES prestataire_annuaire (id, org_id),
  FOREIGN KEY (calendrier_id, org_id) REFERENCES calendrier_ouvre (id, org_id)
);
CREATE INDEX contrat_annuaire_idx ON contrat_service (org_id, annuaire_id);

CREATE TABLE contrat_perimetre (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id     uuid NOT NULL,
  contrat_id uuid NOT NULL,
  site_id    uuid NOT NULL REFERENCES site (id),
  famille_id uuid,                       -- NULL = toutes les familles
  FOREIGN KEY (contrat_id, org_id) REFERENCES contrat_service (id, org_id) ON DELETE CASCADE,
  FOREIGN KEY (famille_id, org_id) REFERENCES famille_ticket (id, org_id),
  UNIQUE NULLS NOT DISTINCT (contrat_id, site_id, famille_id)
);
CREATE INDEX contrat_perimetre_site_idx ON contrat_perimetre (org_id, site_id);

CREATE TABLE sla_regle (
  id                        uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id                    uuid NOT NULL,
  contrat_id                uuid NOT NULL,
  priorite                  text NOT NULL CHECK (priorite IN ('p1', 'p2', 'p3', 'p4')),
  delai_prise_en_compte_min int NOT NULL CHECK (delai_prise_en_compte_min > 0),
  delai_resolution_min      int NOT NULL CHECK (delai_resolution_min > 0),
  calendrier_id             uuid,        -- NULL = calendrier du contrat ; 24/7 si le contrat n'en a pas
  CHECK (delai_resolution_min >= delai_prise_en_compte_min),
  UNIQUE (contrat_id, priorite),
  FOREIGN KEY (contrat_id, org_id) REFERENCES contrat_service (id, org_id) ON DELETE CASCADE,
  FOREIGN KEY (calendrier_id, org_id) REFERENCES calendrier_ouvre (id, org_id)
);

CREATE TABLE sla_instance (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id          uuid NOT NULL,
  ticket_id       uuid NOT NULL REFERENCES ticket (id),
  affectation_id  uuid NOT NULL REFERENCES affectation_ticket (id),
  contrat_id      uuid NOT NULL,
  type            text NOT NULL CHECK (type IN ('prise_en_compte', 'resolution')),
  depart_at       timestamptz NOT NULL,
  delai_minutes   int NOT NULL CHECK (delai_minutes > 0),
  echeance_at     timestamptz NOT NULL,
  remplace_at     timestamptz,           -- renseigné lors d'une réaffectation : l'instance n'est plus suivie
  created_at      timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (contrat_id, org_id) REFERENCES contrat_service (id, org_id)
);
CREATE INDEX sla_instance_ticket_idx ON sla_instance (ticket_id) WHERE remplace_at IS NULL;
CREATE INDEX sla_instance_echeance_idx ON sla_instance (echeance_at) WHERE remplace_at IS NULL;

-- RLS : strictement l'organisation courante ----------------------------------------------------------------
DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['calendrier_ouvre', 'calendrier_fermeture', 'contrat_service', 'contrat_perimetre', 'sla_regle', 'sla_instance'] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format('CREATE POLICY %I ON %I FOR ALL USING (org_id = app.current_org()) WITH CHECK (org_id = app.current_org())', t || '_org', t);
    EXECUTE format('CREATE POLICY %I ON %I FOR ALL TO nova_owner USING (true) WITH CHECK (true)', t || '_interne', t);
  END LOOP;
  FOREACH t IN ARRAY ARRAY['calendrier_ouvre', 'contrat_service', 'contrat_perimetre', 'sla_regle'] LOOP
    EXECUTE format('CREATE TRIGGER %I BEFORE UPDATE ON %I FOR EACH ROW EXECUTE FUNCTION app.trg_org_immutable()', t || '_org_immutable', t);
  END LOOP;
END $$;

GRANT SELECT, INSERT, UPDATE, DELETE ON calendrier_ouvre, calendrier_fermeture, contrat_service, contrat_perimetre, sla_regle TO nova_app;
GRANT SELECT, INSERT, UPDATE ON sla_instance TO nova_app;

-- Un périmètre ne peut viser qu'un site que l'organisation voit (les clés étrangères ne passent pas par la RLS).
-- SECURITY INVOKER : le SELECT s'exécute sous la RLS de l'appelant.
CREATE FUNCTION app.trg_perimetre_check() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, public, app AS $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM public.site WHERE id = NEW.site_id) THEN
    RAISE EXCEPTION 'site inconnu ou non visible' USING ERRCODE = '23503';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER perimetre_check BEFORE INSERT OR UPDATE OF site_id ON contrat_perimetre
  FOR EACH ROW EXECUTE FUNCTION app.trg_perimetre_check();

-- Paramètre de dispatch de l'organisation courante (la table organisation n'est pas modifiable par nova_app).
CREATE FUNCTION app.set_exiger_contrat(p_valeur boolean) RETURNS boolean
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public, app AS $$
BEGIN
  IF app.current_org() IS NULL OR NOT EXISTS (SELECT 1 FROM public.organisation WHERE id = app.current_org() AND type = 'property_manager') THEN
    RAISE EXCEPTION 'réservé à un property manager' USING ERRCODE = '42501';
  END IF;
  UPDATE public.organisation SET exiger_contrat = p_valeur WHERE id = app.current_org();
  RETURN p_valeur;
END $$;
REVOKE ALL ON FUNCTION app.trg_perimetre_check(), app.set_exiger_contrat(boolean) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.set_exiger_contrat(boolean) TO nova_app;

-- Éligibilité : nouveau motif « sans_contrat » (miroir de packages/shared/src/eligibilite.ts).
-- Si l'organisation exige un contrat, un prestataire n'est éligible que s'il a un contrat actif, en cours à la date
-- du jour (Paris), dont le périmètre couvre le site du ticket et sa famille (famille NULL = toutes).
CREATE OR REPLACE FUNCTION app.prestataires_eligibles(p_ticket uuid)
RETURNS TABLE (annuaire_id uuid, nom text, priorite int, eligible boolean, raison text)
LANGUAGE sql STABLE SET search_path = pg_catalog, public, app AS $$
  SELECT x.annuaire_id, x.nom, x.priorite, x.raison = 'ok' AS eligible, x.raison
    FROM (
      SELECT a.id AS annuaire_id, a.nom, pf.priorite,
             CASE
               WHEN a.statut <> 'actif' THEN 'suspendu'
               WHEN a.prestataire_org_id IS NULL THEN 'non_rattache'
               WHEN a.assurance_expire_le IS NOT NULL
                    AND a.assurance_expire_le < (now() AT TIME ZONE 'Europe/Paris')::date THEN 'assurance_expiree'
               WHEN (SELECT o.exiger_contrat FROM public.organisation o WHERE o.id = a.org_id)
                    AND NOT EXISTS (
                      SELECT 1 FROM public.contrat_service c
                        JOIN public.contrat_perimetre p ON p.contrat_id = c.id AND p.org_id = c.org_id
                       WHERE c.annuaire_id = a.id AND c.org_id = a.org_id AND c.statut = 'actif'
                         AND c.date_debut <= (now() AT TIME ZONE 'Europe/Paris')::date
                         AND (c.date_fin IS NULL OR c.date_fin >= (now() AT TIME ZONE 'Europe/Paris')::date)
                         AND p.site_id = t.site_id AND (p.famille_id IS NULL OR p.famille_id = t.famille_id)
                    ) THEN 'sans_contrat'
               ELSE 'ok'
             END AS raison
        FROM public.ticket t
        JOIN public.prestataire_famille pf ON pf.famille_id = t.famille_id
        JOIN public.prestataire_annuaire a ON a.id = pf.annuaire_id AND a.org_id = pf.org_id
       WHERE t.id = p_ticket AND a.org_id = app.current_org() AND a.deleted_at IS NULL
    ) x
   ORDER BY (x.raison = 'ok') DESC, x.priorite, x.nom COLLATE "C" $$;

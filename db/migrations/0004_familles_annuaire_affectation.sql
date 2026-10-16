-- 0004 — Familles de tickets, annuaire des prestataires, éligibilité et affectation.
--
-- Le catalogue de familles et l'annuaire appartiennent à l'organisation qui dispatche (property manager ou
-- bailleur). Un ticket est dispatché par l'organisation qui l'a créé : sa famille est issue de son catalogue.
-- La règle d'éligibilité vit dans la base (app.prestataires_eligibles) et l'affectation la ré-applique :
-- aucun chemin d'API ne peut affecter un prestataire non éligible.

CREATE TABLE famille_ticket (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id     uuid NOT NULL REFERENCES organisation (id),
  code       text NOT NULL,
  libelle    text NOT NULL,
  actif      boolean NOT NULL DEFAULT true,
  ordre      int NOT NULL DEFAULT 0,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (id, org_id),
  UNIQUE (org_id, code)
);

CREATE TABLE prestataire_annuaire (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id             uuid NOT NULL REFERENCES organisation (id),
  nom                text NOT NULL,
  contact_nom        text,
  contact_email      text,
  contact_telephone  text,
  zone               text,
  statut             text NOT NULL DEFAULT 'actif' CHECK (statut IN ('actif', 'suspendu')),
  assurance_expire_le date,
  -- Compte prestataire sur la plateforme ; NULL = pas encore rattaché (aucune affectation possible).
  prestataire_org_id uuid REFERENCES organisation (id),
  notes              text,
  deleted_at         timestamptz,
  created_at         timestamptz NOT NULL DEFAULT now(),
  updated_at         timestamptz NOT NULL DEFAULT now(),
  UNIQUE (id, org_id),
  CHECK (prestataire_org_id IS NULL OR prestataire_org_id <> org_id)
);
CREATE UNIQUE INDEX annuaire_prestataire_uq ON prestataire_annuaire (org_id, prestataire_org_id)
  WHERE prestataire_org_id IS NOT NULL AND deleted_at IS NULL;
CREATE INDEX annuaire_org_idx ON prestataire_annuaire (org_id, nom);

CREATE TABLE prestataire_famille (
  org_id      uuid NOT NULL,
  annuaire_id uuid NOT NULL,
  famille_id  uuid NOT NULL,
  priorite    int NOT NULL DEFAULT 1 CHECK (priorite BETWEEN 1 AND 99),
  PRIMARY KEY (annuaire_id, famille_id),
  FOREIGN KEY (annuaire_id, org_id) REFERENCES prestataire_annuaire (id, org_id),
  FOREIGN KEY (famille_id, org_id) REFERENCES famille_ticket (id, org_id)
);
CREATE INDEX prestataire_famille_famille_idx ON prestataire_famille (famille_id, priorite);

-- Tickets : famille, description, local, priorité, statuts contrôlés.
ALTER TABLE ticket
  ADD COLUMN famille_id  uuid REFERENCES famille_ticket (id),
  ADD COLUMN description text,
  ADD COLUMN local_id    uuid,
  ADD COLUMN priorite    text NOT NULL DEFAULT 'p3' CHECK (priorite IN ('p1', 'p2', 'p3', 'p4')),
  ADD CONSTRAINT ticket_statut_ck CHECK (statut IN
    ('nouveau', 'qualifie', 'affecte', 'planifie', 'en_cours', 'en_attente', 'resolu', 'clos', 'rejete', 'annule')),
  ADD CONSTRAINT ticket_local_fk FOREIGN KEY (local_id, owner_org_id, site_id) REFERENCES local (id, org_id, site_id);
CREATE INDEX ticket_famille_idx ON ticket (famille_id);

CREATE TABLE affectation_ticket (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  rang               bigint GENERATED ALWAYS AS IDENTITY,
  org_id             uuid NOT NULL REFERENCES organisation (id),
  ticket_id          uuid NOT NULL REFERENCES ticket (id),
  annuaire_id        uuid NOT NULL,
  prestataire_org_id uuid NOT NULL REFERENCES organisation (id),
  prestataire_nom    text NOT NULL,
  famille_id         uuid NOT NULL REFERENCES famille_ticket (id),
  affecte_par        uuid REFERENCES utilisateur (id),
  affecte_at         timestamptz NOT NULL DEFAULT now(),
  fin_at             timestamptz,
  motif              text,
  FOREIGN KEY (annuaire_id, org_id) REFERENCES prestataire_annuaire (id, org_id)
);
CREATE UNIQUE INDEX affectation_courante_uq ON affectation_ticket (ticket_id) WHERE fin_at IS NULL;
CREATE INDEX affectation_ticket_idx ON affectation_ticket (ticket_id, affecte_at DESC, rang DESC);

DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['famille_ticket', 'prestataire_annuaire', 'prestataire_famille', 'affectation_ticket'] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
  END LOOP;
  FOREACH t IN ARRAY ARRAY['famille_ticket', 'prestataire_annuaire', 'prestataire_famille'] LOOP
    EXECUTE format('CREATE TRIGGER %I BEFORE UPDATE ON %I FOR EACH ROW EXECUTE FUNCTION app.trg_org_immutable()', t || '_org_immutable', t);
  END LOOP;
END $$;

-- Familles : celles de l'organisation, plus celles des tickets qu'elle peut voir (bailleur d'un ticket créé par
-- son PM, prestataire auquel il est confié) pour afficher leur libellé.
CREATE POLICY famille_select ON famille_ticket FOR SELECT USING (
  org_id = app.current_org()
  OR EXISTS (SELECT 1 FROM ticket t WHERE t.famille_id = famille_ticket.id));
CREATE POLICY famille_insert ON famille_ticket FOR INSERT WITH CHECK (org_id = app.current_org());
CREATE POLICY famille_update ON famille_ticket FOR UPDATE
  USING (org_id = app.current_org()) WITH CHECK (org_id = app.current_org());

-- Annuaire : strictement propre à l'organisation (deux prestataires concurrents ne se voient jamais).
CREATE POLICY annuaire_org ON prestataire_annuaire FOR ALL
  USING (org_id = app.current_org()) WITH CHECK (org_id = app.current_org());
CREATE POLICY annuaire_famille_org ON prestataire_famille FOR ALL
  USING (org_id = app.current_org()) WITH CHECK (org_id = app.current_org());

-- Affectations : lisibles de l'organisation qui a affecté seulement (le motif peut contenir une note interne) ;
-- écrites uniquement par app.affecter_ticket.
CREATE POLICY affectation_select ON affectation_ticket FOR SELECT USING (org_id = app.current_org());
CREATE POLICY affectation_interne ON affectation_ticket FOR ALL TO nova_owner USING (true) WITH CHECK (true);

-- Le compte rattaché doit être une organisation prestataire active.
CREATE FUNCTION app.trg_annuaire_check() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public, app AS $$
BEGIN
  IF NEW.prestataire_org_id IS NOT NULL AND NOT EXISTS (
       SELECT 1 FROM public.organisation WHERE id = NEW.prestataire_org_id AND type = 'prestataire' AND statut = 'actif') THEN
    RAISE EXCEPTION 'le compte rattaché doit être un prestataire actif' USING ERRCODE = '23514';
  END IF;
  NEW.updated_at := now();
  RETURN NEW;
END $$;
CREATE TRIGGER annuaire_check BEFORE INSERT OR UPDATE ON prestataire_annuaire
  FOR EACH ROW EXECUTE FUNCTION app.trg_annuaire_check();

-- Règle d'éligibilité (miroir de packages/shared/src/eligibilite.ts ; un test de contrat commun garde les deux alignées).
-- Candidats : prestataires référencés sur la famille du ticket. Éligible : actif, rattaché, assurance non échue
-- (échéance incluse, date du jour à Paris). Tri : éligibles, priorité, nom (ordre des codes).
CREATE FUNCTION app.prestataires_eligibles(p_ticket uuid)
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
               ELSE 'ok'
             END AS raison
        FROM public.ticket t
        JOIN public.prestataire_famille pf ON pf.famille_id = t.famille_id
        JOIN public.prestataire_annuaire a ON a.id = pf.annuaire_id AND a.org_id = pf.org_id
       WHERE t.id = p_ticket AND a.org_id = app.current_org() AND a.deleted_at IS NULL
    ) x
   ORDER BY (x.raison = 'ok') DESC, x.priorite, x.nom COLLATE "C" $$;

-- Affectation (ou réaffectation) : éligibilité ré-évaluée, accès partagé au prestataire, ancien accès révoqué.
-- Erreurs : NV001 non éligible (DETAIL = raison), NV002 déjà affecté, NV003 statut incompatible.
CREATE FUNCTION app.affecter_ticket(p_ticket uuid, p_annuaire uuid, p_motif text) RETURNS uuid
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public, app AS $$
DECLARE
  v_org uuid := app.current_org();
  v_statut text; v_famille uuid;
  v_el record; v_prest uuid; v_nom text; v_prev record; v_id uuid;
BEGIN
  PERFORM app.assert_ticket_manager(p_ticket);
  SELECT statut, famille_id INTO v_statut, v_famille FROM public.ticket WHERE id = p_ticket;
  IF v_famille IS NULL THEN
    RAISE EXCEPTION 'ticket sans famille' USING ERRCODE = '23514';
  END IF;
  IF v_statut NOT IN ('nouveau', 'qualifie', 'affecte') THEN
    RAISE EXCEPTION 'un ticket « % » ne peut plus être affecté', v_statut USING ERRCODE = 'NV003';
  END IF;
  SELECT * INTO v_el FROM app.prestataires_eligibles(p_ticket) e WHERE e.annuaire_id = p_annuaire;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'prestataire non référencé sur la famille du ticket' USING ERRCODE = 'NV001', DETAIL = 'famille_non_referencee';
  END IF;
  IF NOT v_el.eligible THEN
    RAISE EXCEPTION 'prestataire non éligible' USING ERRCODE = 'NV001', DETAIL = v_el.raison;
  END IF;
  SELECT prestataire_org_id, nom INTO v_prest, v_nom FROM public.prestataire_annuaire WHERE id = p_annuaire AND org_id = v_org;
  SELECT * INTO v_prev FROM public.affectation_ticket WHERE ticket_id = p_ticket AND fin_at IS NULL FOR UPDATE;
  IF FOUND THEN
    IF v_prev.annuaire_id = p_annuaire THEN
      RAISE EXCEPTION 'ce prestataire est déjà affecté à ce ticket' USING ERRCODE = 'NV002';
    END IF;
    UPDATE public.affectation_ticket SET fin_at = now() WHERE id = v_prev.id;
    UPDATE public.acces_objet SET revoque_at = now()
     WHERE objet_type = 'ticket' AND objet_id = p_ticket AND org_id = v_prev.prestataire_org_id AND revoque_at IS NULL;
  END IF;
  INSERT INTO public.acces_objet (objet_type, objet_id, org_id, cree_par_org_id)
  VALUES ('ticket', p_ticket, v_prest, v_org)
  ON CONFLICT (objet_type, objet_id, org_id) WHERE revoque_at IS NULL DO NOTHING;
  INSERT INTO public.affectation_ticket (org_id, ticket_id, annuaire_id, prestataire_org_id, prestataire_nom, famille_id, affecte_par, motif)
  VALUES (v_org, p_ticket, p_annuaire, v_prest, v_nom, v_famille, app.current_user_id(), NULLIF(btrim(p_motif), ''))
  RETURNING id INTO v_id;
  UPDATE public.ticket SET statut = 'affecte' WHERE id = p_ticket;
  RETURN v_id;
END $$;

REVOKE ALL ON FUNCTION app.trg_annuaire_check(), app.prestataires_eligibles(uuid), app.affecter_ticket(uuid, uuid, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.prestataires_eligibles(uuid), app.affecter_ticket(uuid, uuid, text) TO nova_app;

GRANT SELECT, INSERT, UPDATE ON famille_ticket, prestataire_annuaire TO nova_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON prestataire_famille TO nova_app;
GRANT SELECT ON affectation_ticket TO nova_app;

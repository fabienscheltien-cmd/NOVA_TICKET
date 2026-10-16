import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import type pg from 'pg';
import { ID, adminClient, appPool, seed, tenantDb } from './helpers.js';

const fk = /foreign key|violates/;

describe('annuaire, familles, éligibilité et affectation — base de données', () => {
  let admin: pg.Client;
  const pool = appPool();
  const db = tenantDb(pool);
  const as = (orgId: string) => ({ orgId, userId: ID.uPM1 });
  const q = <T = Record<string, unknown>>(ctx: ReturnType<typeof as>, sql: string, p: unknown[] = []) =>
    db.withTenant(ctx, async (c) => (await c.query(sql, p)).rows as T[]);
  const sql = (s: string, p: unknown[] = []) => admin.query(s, p).then((r) => r.rows);

  let fPlomb: string; let fElec: string;
  let aHydro: string; let aAqua: string; let aSusp: string; let aOrphelin: string; let aExpire: string;
  let ticket: string;

  before(async () => {
    admin = await adminClient();
    await seed(admin);
    fPlomb = (await q<{ id: string }>(as(ID.PM1), "INSERT INTO famille_ticket (org_id, code, libelle) VALUES ($1, 'plomberie', 'Plomberie') RETURNING id", [ID.PM1]))[0]!.id;
    fElec = (await q<{ id: string }>(as(ID.PM1), "INSERT INTO famille_ticket (org_id, code, libelle) VALUES ($1, 'electricite', 'Électricité') RETURNING id", [ID.PM1]))[0]!.id;
    const ann = async (nom: string, org: string | null, o: { statut?: string; assurance?: string } = {}) =>
      (await q<{ id: string }>(as(ID.PM1),
        'INSERT INTO prestataire_annuaire (org_id, nom, prestataire_org_id, statut, assurance_expire_le) VALUES ($1,$2,$3,$4,$5) RETURNING id',
        [ID.PM1, nom, org, o.statut ?? 'actif', o.assurance ?? '2099-01-01']))[0]!.id;
    aHydro = await ann('Hydro', ID.P1);
    aAqua = await ann('Aqua', ID.P2);
    aSusp = await ann('Suspendu', ID.P3, { statut: 'suspendu' });
    aOrphelin = await ann('Orphelin', null);
    aExpire = await ann('Expire', ID.S1, { assurance: '2000-01-01' });
    const ref = (a: string, f: string, prio: number) =>
      q(as(ID.PM1), 'INSERT INTO prestataire_famille (org_id, annuaire_id, famille_id, priorite) VALUES ($1,$2,$3,$4)', [ID.PM1, a, f, prio]);
    await ref(aHydro, fPlomb, 1); await ref(aAqua, fPlomb, 2); await ref(aSusp, fPlomb, 1); await ref(aOrphelin, fPlomb, 3); await ref(aExpire, fPlomb, 1);
    await ref(aHydro, fElec, 5);
    ticket = (await q<{ id: string }>(as(ID.PM1),
      "INSERT INTO ticket (owner_org_id, managing_org_id, site_id, titre, famille_id) VALUES ($1, $2, $3, 'Fuite', $4) RETURNING id", [ID.B1, ID.PM1, ID.siteB1a, fPlomb]))[0]!.id;
  });
  after(async () => { await admin.end(); await pool.end(); });

  it('1. annuaire et familles : strictement propres à l\'organisation (concurrents, bailleur, prestataires, éditeur)', async () => {
    for (const org of [ID.PM2, ID.B1, ID.B2, ID.P1, ID.P2, ID.S1, ID.ED]) {
      assert.deepEqual(await q(as(org), 'SELECT id FROM prestataire_annuaire'), [], `annuaire vu par ${org}`);
      assert.deepEqual(await q(as(org), 'SELECT annuaire_id FROM prestataire_famille'), [], `référencements vus par ${org}`);
    }
    assert.equal((await q(as(ID.PM1), 'SELECT id FROM prestataire_annuaire')).length, 5);
    assert.deepEqual(await q(as(ID.PM2), 'SELECT id FROM famille_ticket'), []);
  });

  it('2. un référencement ne peut pas croiser deux organisations (famille ou prestataire d\'un autre)', async () => {
    const autreFamille = (await q<{ id: string }>(as(ID.PM2), "INSERT INTO famille_ticket (org_id, code, libelle) VALUES ($1, 'plomberie', 'Plomberie PM2') RETURNING id", [ID.PM2]))[0]!.id;
    await assert.rejects(q(as(ID.PM1), 'INSERT INTO prestataire_famille (org_id, annuaire_id, famille_id) VALUES ($1,$2,$3)', [ID.PM1, aAqua, autreFamille]), fk);
    await assert.rejects(q(as(ID.PM2), 'INSERT INTO prestataire_famille (org_id, annuaire_id, famille_id) VALUES ($1,$2,$3)', [ID.PM2, aAqua, autreFamille]), /row-level security|foreign key/);
    await assert.rejects(q(as(ID.PM2), 'INSERT INTO prestataire_annuaire (org_id, nom) VALUES ($1, \'x\')', [ID.PM1]), /row-level security/);
  });

  it('3. le compte rattaché doit être un prestataire actif, distinct de l\'organisation, et unique dans l\'annuaire', async () => {
    await assert.rejects(q(as(ID.PM1), "INSERT INTO prestataire_annuaire (org_id, nom, prestataire_org_id) VALUES ($1, 'Faux', $2)", [ID.PM1, ID.B2]), /prestataire actif/);
    await assert.rejects(q(as(ID.PM1), "INSERT INTO prestataire_annuaire (org_id, nom, prestataire_org_id) VALUES ($1, 'Doublon', $2)", [ID.PM1, ID.P1]), /unique|duplicate/);
    await assert.rejects(sql('UPDATE prestataire_annuaire SET org_id = $1 WHERE id = $2', [ID.PM2, aHydro]), /ne peut pas être modifié/);
  });

  it('4. éligibilité : famille du ticket, motifs d\'exclusion, tri par priorité, visible du seul dispatcheur', async () => {
    const lignes = (await q<{ nom: string; priorite: number; eligible: boolean; raison: string }>(as(ID.PM1),
      'SELECT nom, priorite, eligible, raison FROM app.prestataires_eligibles($1)', [ticket]));
    assert.deepEqual(lignes.map((l) => [l.nom, l.priorite, l.eligible, l.raison]), [
      ['Hydro', 1, true, 'ok'], ['Aqua', 2, true, 'ok'],
      ['Expire', 1, false, 'assurance_expiree'], ['Suspendu', 1, false, 'suspendu'], ['Orphelin', 3, false, 'non_rattache'],
    ]);
    assert.deepEqual(await q(as(ID.PM2), 'SELECT * FROM app.prestataires_eligibles($1)', [ticket]), [], 'PM2 ne voit pas le ticket');
    assert.deepEqual(await q(as(ID.B1), 'SELECT * FROM app.prestataires_eligibles($1)', [ticket]), [], 'le bailleur n\'a pas d\'annuaire : aucun candidat');
  });

  it('5. affectation : écriture directe interdite, éligibilité ré-appliquée, motifs de refus', async () => {
    await assert.rejects(q(as(ID.PM1), "INSERT INTO affectation_ticket (org_id, ticket_id, annuaire_id, prestataire_org_id, prestataire_nom, famille_id) VALUES ($1,$2,$3,$4,'x',$5)", [ID.PM1, ticket, aHydro, ID.P1, fPlomb]), /permission denied/);
    const refus = async (annuaire: string) =>
      q(as(ID.PM1), 'SELECT app.affecter_ticket($1, $2, NULL)', [ticket, annuaire]).then(() => null, (e: { code: string; detail: string }) => [e.code, e.detail]);
    assert.deepEqual(await refus(aExpire), ['NV001', 'assurance_expiree']);
    assert.deepEqual(await refus(aSusp), ['NV001', 'suspendu']);
    assert.deepEqual(await refus(aOrphelin), ['NV001', 'non_rattache']);
    assert.deepEqual(await refus('00000000-0000-4000-8000-0000000000aa'), ['NV001', 'famille_non_referencee']);
    assert.equal((await sql('SELECT count(*)::int AS n FROM affectation_ticket'))[0].n, 0);
    const autreFamilleTicket = (await q<{ id: string }>(as(ID.PM1),
      "INSERT INTO ticket (owner_org_id, managing_org_id, site_id, titre, famille_id) VALUES ($1,$2,$3,'Prise',$4) RETURNING id", [ID.B1, ID.PM1, ID.siteB1a, fElec]))[0]!.id;
    await assert.rejects(q(as(ID.PM1), 'SELECT app.affecter_ticket($1, $2, NULL)', [autreFamilleTicket, aAqua]), (e: { code: string; detail: string }) => e.code === 'NV001' && e.detail === 'famille_non_referencee');
  });

  it('6. affectation puis réaffectation : le nouveau prestataire reçoit l\'accès, l\'ancien le perd, l\'historique est conservé', async () => {
    const visibleDe = (org: string) => q<{ titre: string }>(as(org), 'SELECT titre FROM ticket');
    assert.deepEqual(await visibleDe(ID.P1), []);
    await q(as(ID.PM1), 'SELECT app.affecter_ticket($1, $2, $3)', [ticket, aHydro, 'Premier choix']);
    assert.deepEqual((await visibleDe(ID.P1)).map((t) => t.titre), ['Fuite']);
    assert.deepEqual(await visibleDe(ID.P2), []);
    assert.equal((await sql('SELECT statut FROM ticket WHERE id = $1', [ticket]))[0].statut, 'affecte');
    await assert.rejects(q(as(ID.PM1), 'SELECT app.affecter_ticket($1, $2, NULL)', [ticket, aHydro]), (e: { code: string }) => e.code === 'NV002');

    await q(as(ID.PM1), 'SELECT app.affecter_ticket($1, $2, $3)', [ticket, aAqua, 'Hydro indisponible']);
    assert.deepEqual(await visibleDe(ID.P1), [], 'l\'ancien prestataire perd l\'accès');
    assert.deepEqual((await visibleDe(ID.P2)).map((t) => t.titre), ['Fuite']);
    const hist = await q<{ prestataire_nom: string; fin_at: Date | null; motif: string }>(as(ID.PM1),
      'SELECT prestataire_nom, fin_at, motif FROM affectation_ticket WHERE ticket_id = $1 ORDER BY affecte_at DESC, rang DESC', [ticket]);
    assert.deepEqual(hist.map((h) => [h.prestataire_nom, h.fin_at === null, h.motif]), [['Aqua', true, 'Hydro indisponible'], ['Hydro', false, 'Premier choix']]);
    const acces = await sql("SELECT org_id, revoque_at IS NULL AS actif FROM acces_objet WHERE objet_id = $1 ORDER BY created_at", [ticket]);
    assert.deepEqual(acces.map((a) => [a.org_id, a.actif]), [[ID.P1, false], [ID.P2, true]]);
  });

  it('7. le prestataire voit la famille du ticket confié, mais ni l\'annuaire ni les affectations ni les notes internes', async () => {
    assert.deepEqual((await q<{ libelle: string }>(as(ID.P2), 'SELECT libelle FROM famille_ticket')).map((f) => f.libelle), ['Plomberie']);
    assert.deepEqual(await q(as(ID.P2), 'SELECT id FROM affectation_ticket'), []);
    assert.deepEqual(await q(as(ID.P1), 'SELECT id FROM famille_ticket'), [], 'l\'ancien prestataire ne voit plus la famille');
    assert.deepEqual((await q<{ libelle: string }>(as(ID.B1), 'SELECT libelle FROM famille_ticket')).map((f) => f.libelle).sort(), ['Plomberie', 'Électricité'], 'le bailleur lit les familles des tickets créés par son PM');
    await assert.rejects(q(as(ID.P2), 'SELECT app.affecter_ticket($1, $2, NULL)', [ticket, aAqua]), (e: { code: string }) => e.code === '42501' || e.code === 'NV001');
  });

  it('8. statut incompatible refusé ; fin de mandat : l\'ancien PM ne peut plus affecter', async () => {
    await sql("UPDATE ticket SET statut = 'clos' WHERE id = $1", [ticket]);
    await assert.rejects(q(as(ID.PM1), 'SELECT app.affecter_ticket($1, $2, NULL)', [ticket, aHydro]), (e: { code: string }) => e.code === 'NV003');
    await sql("UPDATE ticket SET statut = 'affecte' WHERE id = $1", [ticket]);
    await sql('UPDATE mandat_gestion SET debut = current_date - 30 WHERE pm_org_id = $1', [ID.PM1]);
    await sql('UPDATE mandat_gestion SET fin = current_date - 1 WHERE pm_org_id = $1', [ID.PM1]);
    await assert.rejects(q(as(ID.PM1), 'SELECT app.affecter_ticket($1, $2, NULL)', [ticket, aHydro]), (e: { code: string }) => e.code === '42501');
    assert.deepEqual(await q(as(ID.PM1), 'SELECT app.prestataires_eligibles($1)', [ticket]), []);
  });
});

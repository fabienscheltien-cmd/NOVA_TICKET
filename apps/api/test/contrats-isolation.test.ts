import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import type pg from 'pg';
import { ApiRepository } from '@nova/shared';
import { ID, adminClient, appPool, createUser, seed, tenantDb } from './helpers.js';
import { MFA_SECRET, type TestApp, startTestApp } from './http-helpers.js';

const uuid = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const PREST = uuid(61);

/** Isolation et permissions des calendriers, contrats, règles SLA, instances et paramètres. */
describe('contrats, calendriers, SLA — isolation et permissions', () => {
  let admin: pg.Client;
  let t: TestApp;
  const pool = appPool();
  const db = tenantDb(pool);
  const tok: Record<string, string> = {};
  let famille = ''; let fiche = ''; let calendrier = ''; let contrat = ''; let ticket = '';
  const q = <T = Record<string, unknown>>(orgId: string, sql: string, p: unknown[] = []) =>
    db.withTenant({ orgId, userId: ID.uPM1 }, async (c) => (await c.query(sql, p)).rows as T[]);

  before(async () => {
    admin = await adminClient();
    await seed(admin);
    await admin.query("INSERT INTO organisation (id, type, nom) VALUES ($1, 'prestataire', 'Prestataire contrats')", [PREST]);
    await createUser(admin, { email: 'fm.pm1@test.invalid', memberships: [[ID.PM1, 'gestionnaire_fm']], mfaSecret: MFA_SECRET });
    await createUser(admin, { email: 'accueil.pm1@test.invalid', memberships: [[ID.PM1, 'accueil']] });
    await createUser(admin, { email: 'fm.pm2@test.invalid', memberships: [[ID.PM2, 'gestionnaire_fm']], mfaSecret: MFA_SECRET });
    await createUser(admin, { email: 'admin.b1@test.invalid', memberships: [[ID.B1, 'admin_org']], mfaSecret: MFA_SECRET });
    await createUser(admin, { email: 'tech.presta@test.invalid', memberships: [[PREST, 'technicien']] });
    t = await startTestApp();
    tok.pm1 = await t.loginOrg('fm.pm1@test.invalid', ID.PM1);
    tok.accueil = await t.loginOrg('accueil.pm1@test.invalid', ID.PM1);
    tok.pm2 = await t.loginOrg('fm.pm2@test.invalid', ID.PM2);
    tok.b1 = await t.loginOrg('admin.b1@test.invalid', ID.B1);
    tok.presta = await t.loginOrg('tech.presta@test.invalid', PREST);
    const repo = new ApiRepository({ baseUrl: t.base, getToken: () => tok.pm1! });
    famille = (await repo.createFamille({ libelle: 'Isolation contrats' })).id;
    fiche = (await repo.createPrestataire({ nom: 'Presta contrats', familles: [{ famille_id: famille, priorite: 1 }] })).id;
    await admin.query('UPDATE prestataire_annuaire SET prestataire_org_id = $1 WHERE id = $2', [PREST, fiche]);
    calendrier = (await repo.createCalendrier({ nom: 'Cal PM1', plages: [{ jours: [1, 2, 3, 4, 5, 6, 7], debut: '00:00', fin: '24:00' }] })).id;
    contrat = (await repo.createContrat({
      annuaire_id: fiche, libelle: 'Contrat PM1', date_debut: '2020-01-01', calendrier_id: calendrier,
      perimetre: [{ site_id: ID.siteB1a, famille_id: null }], regles: [{ priorite: 'p3', delai_prise_en_compte_min: 60, delai_resolution_min: 600 }],
    })).id;
    ticket = (await repo.createTicket({ titre: 'Ticket SLA', famille_id: famille, site_id: ID.siteB1a })).id;
    await repo.affecter(ticket, { annuaire_id: fiche });
  });
  after(async () => { await t.close(); await admin.end(); await pool.end(); });

  const get = (token: string, path: string) => t.call('GET', path, { token });

  it('1. un autre property manager ne voit ni calendrier, ni contrat, ni paramètre de PM1', async () => {
    assert.deepEqual((await get(tok.pm2!, '/contrats')).json.items, []);
    assert.deepEqual((await get(tok.pm2!, '/calendriers')).json.items, []);
    assert.equal((await get(tok.pm2!, `/contrats/${contrat}`)).status, 404);
    const maj = await t.call('PATCH', `/contrats/${contrat}`, { token: tok.pm2, body: { libelle: 'Piraté' } });
    assert.equal(maj.status, 404);
    assert.equal((await t.call('PUT', `/calendriers/${calendrier}`, { token: tok.pm2, body: { nom: 'Piraté', plages: [{ jours: [1], debut: '08:00', fin: '18:00' }] } })).status, 404);
    assert.equal((await get(tok.pm1!, `/contrats/${contrat}`)).json.libelle, 'Contrat PM1', 'inchangé');
    // PM2 active l'exigence de contrat pour lui : PM1 n'est pas touché
    assert.equal((await t.call('PUT', '/parametres', { token: tok.pm2, body: { exiger_contrat: true } })).status, 200);
    assert.deepEqual((await get(tok.pm1!, '/parametres')).json, { exiger_contrat: false });
    await t.call('PUT', '/parametres', { token: tok.pm2, body: { exiger_contrat: false } });
  });

  it('2. un autre PM ne peut ni référencer la fiche d\'annuaire, ni le calendrier de PM1, ni un site qu\'il ne voit pas', async () => {
    const base = { libelle: 'Intrus', date_debut: '2026-01-01', perimetre: [{ site_id: ID.siteB1a, famille_id: null }] };
    const mk = (body: unknown) => t.call('POST', '/contrats', { token: tok.pm2, body });
    const r1 = await mk({ ...base, annuaire_id: fiche });
    assert.equal(r1.status, 400);
    assert.match(r1.json.message, /prestataire inconnu/);
    // PM2 crée sa propre fiche puis tente le calendrier et le site de PM1
    const repo2 = new ApiRepository({ baseUrl: t.base, getToken: () => tok.pm2! });
    const f2 = (await repo2.createFamille({ libelle: 'F PM2' })).id;
    const fiche2 = (await repo2.createPrestataire({ nom: 'Fiche PM2', familles: [{ famille_id: f2, priorite: 1 }] })).id;
    assert.match((await mk({ ...base, annuaire_id: fiche2, calendrier_id: calendrier })).json.message, /calendrier inconnu/);
    assert.match((await mk({ ...base, annuaire_id: fiche2 })).json.message, /site inconnu/, 'le site de B1 n\'est pas visible de PM2');
    assert.match((await mk({ annuaire_id: fiche2, libelle: 'x', date_debut: '2026-01-01', perimetre: [{ site_id: ID.siteB2, famille_id: f2 }, { site_id: ID.siteB1a, famille_id: null }] })).json.message, /site inconnu/);
    assert.match((await mk({ annuaire_id: fiche2, libelle: 'x', date_debut: '2026-01-01', perimetre: [{ site_id: ID.siteB2, famille_id: famille }] })).json.message, /famille inconnue|site inconnu/, 'la famille de PM1 n\'existe pas pour PM2');
  });

  it('3. permissions : lecture réservée aux rôles qui ont contrat.read, écriture à sla.configure ; le bailleur n\'écrit rien', async () => {
    assert.equal((await get(tok.accueil!, '/contrats')).status, 403);
    assert.equal((await get(tok.presta!, '/contrats')).status, 403);
    assert.equal((await get(tok.presta!, '/calendriers')).status, 403);
    assert.equal((await t.call('POST', '/calendriers', { token: tok.accueil, body: { nom: 'x', plages: [{ jours: [1], debut: '08:00', fin: '18:00' }] } })).status, 403);
    assert.equal((await t.call('PUT', '/parametres', { token: tok.accueil, body: { exiger_contrat: true } })).status, 403);
    // bailleur (admin) : lit ses propres contrats (aucun), n'écrit rien
    assert.deepEqual((await get(tok.b1!, '/contrats')).json.items, []);
    for (const [m, path, body] of [
      ['POST', '/calendriers', { nom: 'x', plages: [{ jours: [1], debut: '08:00', fin: '18:00' }] }],
      ['POST', '/contrats', { annuaire_id: fiche, libelle: 'x', date_debut: '2026-01-01', perimetre: [{ site_id: ID.siteB1a }] }],
      ['PUT', '/parametres', { exiger_contrat: true }],
    ] as const) assert.equal((await t.call(m, path, { token: tok.b1, body })).status, 403, `${m} ${path}`);
    assert.equal((await t.call('GET', '/contrats')).status, 401);
  });

  it('4. le SLA n\'est lisible que du dispatcheur : ni le bailleur du ticket, ni le prestataire affecté ne le voient', async () => {
    const pm = (await get(tok.pm1!, `/tickets/${ticket}`)).json;
    assert.equal(pm.sla.length, 2);
    assert.equal(pm.sla[0].contrat_libelle, 'Contrat PM1');
    const bailleur = await get(tok.b1!, `/tickets/${ticket}`);
    assert.equal(bailleur.status, 200, 'le bailleur voit le ticket de son site');
    assert.deepEqual(bailleur.json.sla, []);
    const presta = await get(tok.presta!, `/tickets/${ticket}`);
    assert.equal(presta.status, 200, 'le prestataire affecté voit le ticket');
    assert.deepEqual(presta.json.sla, []);
    assert.deepEqual(presta.json.historique, [], 'et toujours pas les affectations');
  });

  it('5. base de données : RLS, clés composites et garde-fous sur toutes les tables du domaine', async () => {
    const tables = ['calendrier_ouvre', 'calendrier_fermeture', 'contrat_service', 'contrat_perimetre', 'sla_regle', 'sla_instance'];
    for (const tb of tables) {
      if (tb !== 'calendrier_fermeture') assert.ok(Number((await q(ID.PM1, `SELECT count(*)::int AS n FROM ${tb}`))[0]!.n) > 0, `${tb} : PM1 voit ses propres lignes (sinon le test d'isolation serait vide)`);
      for (const autre of [ID.PM2, ID.B1, PREST]) assert.equal((await q(autre, `SELECT count(*)::int AS n FROM ${tb}`))[0]!.n, 0, `${tb} invisible pour ${autre}`);
    }
    assert.ok(Number((await q(ID.PM1, 'SELECT count(*)::int AS n FROM sla_instance'))[0]!.n) === 2);
    // écriture dans l'organisation d'un autre : refusée par la RLS
    await assert.rejects(q(ID.PM2, "INSERT INTO calendrier_ouvre (org_id, nom, plages) VALUES ($1, 'x', '[{\"jours\":[1],\"debut\":\"08:00\",\"fin\":\"18:00\"}]')", [ID.PM1]), /row-level security/);
    await assert.rejects(q(ID.PM1, 'INSERT INTO sla_instance (org_id, ticket_id, affectation_id, contrat_id, type, depart_at, delai_minutes, echeance_at) SELECT $1, ticket_id, id, $2, \'resolution\', now(), 10, now() FROM affectation_ticket LIMIT 1', [ID.PM2, contrat]), /row-level security|foreign key/);
    // le périmètre ne peut viser qu'un site visible (trigger invoker sous RLS)
    await assert.rejects(q(ID.PM1, 'INSERT INTO contrat_perimetre (org_id, contrat_id, site_id) VALUES ($1, $2, $3)', [ID.PM1, contrat, ID.siteB2]), /site inconnu/);
    // clé composite : un contrat de PM1 ne peut pas viser la fiche d'annuaire d'un autre PM
    const autreFiche = (await admin.query("INSERT INTO prestataire_annuaire (org_id, nom) VALUES ($1, 'Fiche PM2 db') RETURNING id", [ID.PM2])).rows[0].id;
    await assert.rejects(q(ID.PM1, "INSERT INTO contrat_service (org_id, annuaire_id, libelle, date_debut) VALUES ($1, $2, 'x', '2026-01-01')", [ID.PM1, autreFiche]), /foreign key/);
    // l'organisation d'un contrat ne change pas
    await assert.rejects(q(ID.PM1, 'UPDATE contrat_service SET org_id = $1 WHERE id = $2', [ID.PM2, contrat]), /ne peut pas être modifié|row-level security/);
    // paramètre : seule l'organisation courante, seulement un property manager
    await assert.rejects(q(ID.B1, 'SELECT app.set_exiger_contrat(true)'), /réservé à un property manager/);
    await q(ID.PM1, 'SELECT app.set_exiger_contrat(false)');
    assert.equal((await q(ID.PM2, 'SELECT exiger_contrat FROM organisation WHERE id = $1', [ID.PM1])).length, 0, 'l\'organisation voisine n\'est pas lisible');
    await assert.rejects(q(ID.PM1, 'UPDATE organisation SET exiger_contrat = true WHERE id = $1', [ID.PM1]), /permission denied|row-level security/);
    // contraintes de forme
    await assert.rejects(q(ID.PM1, "INSERT INTO sla_regle (org_id, contrat_id, priorite, delai_prise_en_compte_min, delai_resolution_min) VALUES ($1, $2, 'p1', 100, 50)", [ID.PM1, contrat]), /check/);
    await assert.rejects(q(ID.PM1, "INSERT INTO sla_regle (org_id, contrat_id, priorite, delai_prise_en_compte_min, delai_resolution_min) VALUES ($1, $2, 'p3', 10, 50)", [ID.PM1, contrat]), /unique|duplicate/);
    await assert.rejects(q(ID.PM1, "INSERT INTO calendrier_ouvre (org_id, nom, plages) VALUES ($1, 'vide', '[]')", [ID.PM1]), /check/);
  });
});

import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import type pg from 'pg';
import { ApiRepository, type Repository } from '@nova/shared';
import { runRepositoryContract } from '@nova/shared/testing';
import { createOrgWithAdminInvitation } from '../src/db/create-org.js';
import { ID, adminClient, createUser, seed } from './helpers.js';
import { MFA_SECRET, type TestApp, startTestApp } from './http-helpers.js';

const uuid = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const P4 = uuid(41); const P5 = uuid(42); const P6 = uuid(43); const P7 = uuid(44);

let admin: pg.Client;
let t: TestApp;
const tokens: Record<string, string> = {};
let localA = ''; let localB = '';

async function preparer() {
  admin = await adminClient();
  await seed(admin);
  for (const [id, nom] of [[P4, 'Prestataire 4'], [P5, 'Prestataire 5'], [P6, 'Prestataire 6'], [P7, 'Prestataire 7']] as const) {
    await admin.query("INSERT INTO organisation (id, type, nom) VALUES ($1, 'prestataire', $2)", [id, nom]);
  }
  const mkLocal = async (site: string, nom: string, qr: string) => {
    const b = (await admin.query('INSERT INTO batiment (org_id, site_id, nom) VALUES ($1,$2,$3) RETURNING id', [ID.B1, site, `Bât ${nom}`])).rows[0].id;
    const n = (await admin.query('INSERT INTO niveau (org_id, site_id, batiment_id, nom) VALUES ($1,$2,$3,$4) RETURNING id', [ID.B1, site, b, `Niv ${nom}`])).rows[0].id;
    return (await admin.query('INSERT INTO local (org_id, site_id, niveau_id, nom, qr_code) VALUES ($1,$2,$3,$4,$5) RETURNING id', [ID.B1, site, n, nom, qr])).rows[0].id as string;
  };
  localA = await mkLocal(ID.siteB1a, 'Local A', 'qr-contract-a');
  localB = await mkLocal(ID.siteB1b, 'Local B', 'qr-contract-b');
  await createUser(admin, { email: 'fm.pm1@test.invalid', memberships: [[ID.PM1, 'gestionnaire_fm']], mfaSecret: MFA_SECRET });
  await createUser(admin, { email: 'accueil.pm1@test.invalid', memberships: [[ID.PM1, 'accueil']] });
  await createUser(admin, { email: 'fm.pm2@test.invalid', memberships: [[ID.PM2, 'gestionnaire_fm']], mfaSecret: MFA_SECRET });
  await createUser(admin, { email: 'admin.b1@test.invalid', memberships: [[ID.B1, 'admin_org']], mfaSecret: MFA_SECRET });
  await createUser(admin, { email: 'tech.p6@test.invalid', memberships: [[P6, 'technicien']] });
  await createUser(admin, { email: 'tech.p7@test.invalid', memberships: [[P7, 'technicien']] });
  t = await startTestApp();
  tokens.pm1 = await t.loginOrg('fm.pm1@test.invalid', ID.PM1);
  tokens.accueil = await t.loginOrg('accueil.pm1@test.invalid', ID.PM1);
  tokens.pm2 = await t.loginOrg('fm.pm2@test.invalid', ID.PM2);
  tokens.b1 = await t.loginOrg('admin.b1@test.invalid', ID.B1);
  tokens.p1 = await t.loginOrg('tech.p6@test.invalid', P6);
  tokens.p2 = await t.loginOrg('tech.p7@test.invalid', P7);
  const repo: Repository = new ApiRepository({ baseUrl: t.base, getToken: () => tokens.pm1! });
  return {
    repo,
    fixtures: { siteId: ID.siteB1a, localId: localA, localAutreSiteId: localB, orgIds: [ID.P1, ID.P2, ID.P3, ID.S1, P4] },
    // Back-office (connexion propriétaire) : l'API elle-même interdit le rattachement par identifiant.
    rattacher: async (annuaireId: string, orgId: string) => { await admin.query('UPDATE prestataire_annuaire SET prestataire_org_id = $1 WHERE id = $2', [orgId, annuaireId]); },
  };
}

// La même suite que pour la démonstration, contre l'API réelle et PostgreSQL : la console peut passer de l'une à l'autre.
runRepositoryContract('ApiRepository (API réelle, PostgreSQL)', preparer);

describe('API — permissions, isolation et affectation de bout en bout', () => {
  const as = (who: string) => new ApiRepository({ baseUrl: t.base, getToken: () => tokens[who]! });
  let famille = ''; let hydro = ''; let aqua = ''; let ticket = '';

  before(async () => {
    const repo = as('pm1');
    famille = (await repo.createFamille({ libelle: 'Isolation e2e' })).id;
    hydro = (await repo.createPrestataire({ nom: 'Hydro e2e', familles: [{ famille_id: famille, priorite: 1 }] })).id;
    aqua = (await repo.createPrestataire({ nom: 'Aqua e2e', familles: [{ famille_id: famille, priorite: 2 }] })).id;
    await admin.query('UPDATE prestataire_annuaire SET prestataire_org_id = $1 WHERE id = $2', [P6, hydro]);
    await admin.query('UPDATE prestataire_annuaire SET prestataire_org_id = $1 WHERE id = $2', [P7, aqua]);
    ticket = (await repo.createTicket({ titre: 'Fuite e2e', famille_id: famille, site_id: ID.siteB1a })).id;
  });
  after(async () => { await t.close(); await admin.end(); });

  it('authentification et permissions : 401 sans jeton ; l\'accueil lit et crée mais n\'administre ni n\'affecte ; le technicien n\'accède pas à l\'annuaire', async () => {
    assert.equal((await t.call('GET', '/annuaire')).status, 401);
    assert.equal((await t.call('GET', '/annuaire', { token: tokens.accueil })).status, 200);
    assert.equal((await t.call('POST', '/familles', { token: tokens.accueil, body: { libelle: 'Interdite' } })).status, 403);
    assert.equal((await t.call('POST', '/annuaire', { token: tokens.accueil, body: { nom: 'Interdit', familles: [] } })).status, 403);
    assert.equal((await t.call('POST', `/tickets/${ticket}/affectation`, { token: tokens.accueil, body: { annuaire_id: hydro } })).status, 403);
    const cree = await t.call('POST', '/tickets', { token: tokens.accueil, body: { titre: 'Créé par l\'accueil', famille_id: famille, site_id: ID.siteB1a } });
    assert.equal(cree.status, 201);
    assert.equal(cree.json.selection.suggere, hydro);
    for (const chemin of ['/annuaire', '/familles']) assert.equal((await t.call('GET', chemin, { token: tokens.p1 })).status, 403, chemin);
  });

  it('format des erreurs : validation 400, introuvable 404, non éligible 422 avec le motif', async () => {
    const v = await t.call('POST', '/tickets', { token: tokens.pm1, body: { titre: '', famille_id: famille, site_id: ID.siteB1a } });
    assert.deepEqual([v.status, v.json.error], [400, 'validation_error']);
    assert.equal((await t.call('GET', `/tickets/${uuid(77)}`, { token: tokens.pm1 })).status, 404);
    assert.equal((await t.call('GET', '/tickets/pas-un-uuid', { token: tokens.pm1 })).status, 400);
    await as('pm1').setStatutPrestataire(aqua, 'suspendu');
    const r = await t.call('POST', `/tickets/${ticket}/affectation`, { token: tokens.pm1, body: { annuaire_id: aqua } });
    assert.deepEqual([r.status, r.json.error, r.json.raison], [422, 'non_eligible', 'suspendu']);
    await as('pm1').setStatutPrestataire(aqua, 'actif');
  });

  it('le prestataire ne voit le ticket qu\'une fois affecté, avec la famille, mais ne peut ni affecter ni lire l\'annuaire', async () => {
    assert.equal((await t.call('GET', `/tickets/${ticket}`, { token: tokens.p1 })).status, 404);
    await as('pm1').affecter(ticket, { annuaire_id: hydro });
    const vu = await t.call('GET', `/tickets/${ticket}`, { token: tokens.p1 });
    assert.equal(vu.status, 200);
    assert.equal(vu.json.famille_libelle, 'Isolation e2e');
    assert.deepEqual(vu.json.selection, { eligibles: [], suggere: null }, 'aucun annuaire côté prestataire');
    assert.deepEqual(vu.json.historique, [], 'les affectations (et leurs motifs) restent internes au dispatcheur');
    assert.ok((await t.call('GET', '/tickets', { token: tokens.p1 })).json.items.some((x: { id: string }) => x.id === ticket));
    assert.equal((await t.call('POST', `/tickets/${ticket}/affectation`, { token: tokens.p1, body: { annuaire_id: hydro } })).status, 403);

    await as('pm1').affecter(ticket, { annuaire_id: aqua, motif: 'Note interne : Hydro surchargé' });
    assert.equal((await t.call('GET', `/tickets/${ticket}`, { token: tokens.p1 })).status, 404, 'l\'ancien prestataire perd l\'accès');
    const p2 = await t.call('GET', `/tickets/${ticket}`, { token: tokens.p2 });
    assert.equal(p2.status, 200);
    assert.ok(!JSON.stringify(p2.json).includes('Hydro surchargé'), 'le motif interne ne fuit pas vers le prestataire');
  });

  it('isolation : un autre property manager et le bailleur ne voient ni annuaire ni familles du PM ; le bailleur voit le ticket de son site', async () => {
    assert.equal((await t.call('GET', `/tickets/${ticket}`, { token: tokens.pm2 })).status, 404);
    assert.deepEqual((await t.call('GET', '/annuaire', { token: tokens.pm2 })).json.items, []);
    assert.deepEqual((await t.call('GET', '/familles', { token: tokens.pm2 })).json.items, []);
    assert.equal((await t.call('GET', `/annuaire/${hydro}`, { token: tokens.pm2 })).status, 404);
    assert.equal((await t.call('PATCH', `/annuaire/${hydro}`, { token: tokens.pm2, body: { nom: 'Piraté' } })).status, 404);
    assert.equal((await t.call('POST', `/annuaire/${hydro}/statut`, { token: tokens.pm2, body: { statut: 'suspendu' } })).status, 404);
    assert.equal((await t.call('POST', `/tickets/${ticket}/affectation`, { token: tokens.pm2, body: { annuaire_id: hydro } })).status, 404);
    const crea = await t.call('POST', '/tickets', { token: tokens.pm2, body: { titre: 'Intrus', famille_id: famille, site_id: ID.siteB1a } });
    assert.equal(crea.status, 400, 'ni le site de B1 ni la famille de PM1 ne sont visibles de PM2');
    assert.deepEqual((await t.call('GET', '/annuaire', { token: tokens.b1 })).json.items, []);
    const b1 = await t.call('GET', `/tickets/${ticket}`, { token: tokens.b1 });
    assert.equal(b1.status, 200);
    assert.equal(b1.json.famille_libelle, 'Isolation e2e');
    assert.equal(b1.json.prestataire_actuel, null, 'le bailleur ne voit pas l\'annuaire ni les affectations de son PM');
    const refus = await t.call('POST', `/tickets/${ticket}/affectation`, { token: tokens.b1, body: { annuaire_id: aqua } });
    assert.equal(refus.status, 403, 'le bailleur a une vision : il n\'affecte pas, même avec un annuaire (décision 16/10/2026)');
  });

  it('familles standard : import idempotent par organisation, isolé entre organisations', async () => {
    const un = await t.call('POST', '/familles/defaults', { token: tokens.pm2 });
    assert.deepEqual([un.status, un.json.items.length], [200, 12]);
    const deux = await t.call('POST', '/familles/defaults', { token: tokens.pm2 });
    assert.equal(deux.json.items.length, 12);
    assert.ok(!(await t.call('GET', '/familles', { token: tokens.pm1 })).json.items.some((f: { id: string }) => un.json.items.some((g: { id: string }) => g.id === f.id)));
  });

  it('création d\'organisation (CLI) : les familles standard sont proposées aux bailleurs et gestionnaires, pas aux prestataires', async () => {
    const bailleur = await createOrgWithAdminInvitation(admin, { type: 'bailleur', nom: 'Bailleur CLI', adminEmail: 'a@cli.invalid' });
    const presta = await createOrgWithAdminInvitation(admin, { type: 'prestataire', nom: 'Presta CLI', adminEmail: 'b@cli.invalid' });
    const n = async (org: string) => (await admin.query('SELECT count(*)::int AS n FROM famille_ticket WHERE org_id = $1', [org])).rows[0].n;
    assert.equal(await n(bailleur.orgId), 12);
    assert.equal(await n(presta.orgId), 0);
  });
});

import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import type pg from 'pg';
import { adminClient, appPool, ID, seed, tenantDb } from './helpers.js';

describe('niveau 3 — scénarios métier d\'isolation', () => {
  let admin: pg.Client;
  const pool = appPool();
  const db = tenantDb(pool);
  const as = (orgId: string, userId = ID.uPM1, scopeSiteIds?: string[]) => ({ orgId, userId, scopeSiteIds });
  const titles = (ctx: ReturnType<typeof as>) =>
    db.withTenant(ctx, async (c) => (await c.query('SELECT titre FROM ticket ORDER BY titre')).rows.map((r) => r.titre as string));
  const denied = /permission denied|row-level security|inaccessible|sans accès|42501/;

  before(async () => { admin = await adminClient(); await seed(admin); });
  after(async () => { await admin.end(); await pool.end(); });

  it('1. un bailleur ne voit que ses sites', async () => {
    const sites = (org: string) => db.withTenant(as(org), async (c) => (await c.query('SELECT nom FROM site ORDER BY nom')).rows.map((r) => r.nom));
    assert.deepEqual(await sites(ID.B1), ['Site B1 A', 'Site B1 B']);
    assert.deepEqual(await sites(ID.B2), ['Site B2']);
  });

  it('2. un bailleur ne voit pas les tickets d\'un autre bailleur', async () => {
    assert.deepEqual(await titles(as(ID.B2)), ['T3 B2/PM2']);
    assert.equal((await titles(as(ID.B1))).includes('T3 B2/PM2'), false);
  });

  it('3. le property manager voit les tickets qu\'il gère, pas ceux d\'un PM sans mandat', async () => {
    assert.deepEqual(await titles(as(ID.PM1)), ['T1 B1/PM1 site A', 'T2 B1/PM1 site A (non partagé)', 'T4 B1/PM1 site B']);
    assert.deepEqual(await titles(as(ID.PM2)), ['T3 B2/PM2']);
  });

  it('4. prestataires concurrents : P1 voit le ticket partagé, P2 et P3 rien', async () => {
    await db.withTenant(as(ID.PM1), (c) => c.query('SELECT app.share_ticket($1, $2)', [ID.t1, ID.P1]));
    assert.deepEqual(await titles(as(ID.P1, ID.uP1)), ['T1 B1/PM1 site A']);
    assert.deepEqual(await titles(as(ID.P2, ID.uP2)), []);
    assert.deepEqual(await titles(as(ID.P3)), []);
  });

  it('5. écriture directe dans acces_objet refusée', async () => {
    await assert.rejects(
      db.withTenant(as(ID.P2, ID.uP2), (c) =>
        c.query("INSERT INTO acces_objet (objet_type, objet_id, org_id, cree_par_org_id) VALUES ('ticket', $1, $2, $2)", [ID.t1, ID.P2])),
      denied);
  });

  it('6. partager un ticket qu\'on ne gère pas est refusé (P2, B2)', async () => {
    for (const org of [ID.P2, ID.B2, ID.P1]) {
      await assert.rejects(db.withTenant(as(org), (c) => c.query('SELECT app.share_ticket($1, $2)', [ID.t1, org])), denied, `org ${org}`);
    }
  });

  it('7. un sous-traitant sans accès ne voit rien du ticket', async () => {
    assert.deepEqual(await titles(as(ID.S1)), []);
  });

  it('8. fil partagé et note interne : visibilité par organisation participante', async () => {
    const shared = await db.withTenant(as(ID.PM1), async (c) =>
      (await c.query('SELECT app.create_fil($1, $2, $3::uuid[]) AS id', [ID.t1, 'partage_ticket', [ID.PM1, ID.P1, ID.B1]])).rows[0].id as string);
    const internal = await db.withTenant(as(ID.PM1), async (c) =>
      (await c.query('SELECT app.create_fil($1, $2, $3::uuid[]) AS id', [ID.t1, 'interne', [ID.PM1]])).rows[0].id as string);
    await db.withTenant(as(ID.PM1), (c) => c.query('INSERT INTO message (fil_id, auteur_org_id, corps) VALUES ($1,$2,$3)', [shared, ID.PM1, 'message partagé PM1']));
    await db.withTenant(as(ID.PM1), (c) => c.query('INSERT INTO message (fil_id, auteur_org_id, corps) VALUES ($1,$2,$3)', [internal, ID.PM1, 'note interne PM1']));
    await db.withTenant(as(ID.P1, ID.uP1), (c) => c.query('INSERT INTO message (fil_id, auteur_org_id, corps) VALUES ($1,$2,$3)', [shared, ID.P1, 'réponse P1']));
    const bodies = (org: string) => db.withTenant(as(org), async (c) => (await c.query('SELECT corps FROM message ORDER BY corps')).rows.map((r) => r.corps));
    assert.deepEqual(await bodies(ID.PM1), ['message partagé PM1', 'note interne PM1', 'réponse P1']);
    assert.deepEqual(await bodies(ID.P1), ['message partagé PM1', 'réponse P1']);
    assert.deepEqual(await bodies(ID.B1), ['message partagé PM1', 'réponse P1']);
    for (const org of [ID.P2, ID.S1, ID.B2, ID.ED]) assert.deepEqual(await bodies(org), [], `org ${org}`);
    const fils = (org: string) => db.withTenant(as(org), async (c) => (await c.query('SELECT type FROM fil ORDER BY type')).rows.map((r) => r.type));
    assert.deepEqual(await fils(ID.P1), ['partage_ticket']);
  });

  it('9. message avec auteur usurpé ou dans un fil non participant : refusé', async () => {
    const filId = (await admin.query("SELECT id FROM fil WHERE type = 'interne'")).rows[0].id as string;
    await assert.rejects(db.withTenant(as(ID.P1, ID.uP1), (c) => c.query('INSERT INTO message (fil_id, auteur_org_id, corps) VALUES ($1,$2,$3)', [filId, ID.P1, 'intrusion'])), denied);
    const sharedId = (await admin.query("SELECT id FROM fil WHERE type = 'partage_ticket'")).rows[0].id as string;
    await assert.rejects(db.withTenant(as(ID.P1, ID.uP1), (c) => c.query('INSERT INTO message (fil_id, auteur_org_id, corps) VALUES ($1,$2,$3)', [sharedId, ID.PM1, 'usurpation'])), denied);
  });

  it('10. un fil ne peut inclure une organisation sans accès au ticket', async () => {
    await assert.rejects(
      db.withTenant(as(ID.PM1), (c) => c.query('SELECT app.create_fil($1, $2, $3::uuid[])', [ID.t1, 'partage_ticket', [ID.PM1, ID.P2]])), denied);
  });

  it('11. révocation : P1 perd l\'accès, l\'historique reste chez le client', async () => {
    await db.withTenant(as(ID.PM1), (c) => c.query('SELECT app.revoke_ticket_share($1, $2)', [ID.t1, ID.P1]));
    assert.deepEqual(await titles(as(ID.P1, ID.uP1)), []);
    assert.equal((await titles(as(ID.PM1))).includes('T1 B1/PM1 site A'), true);
  });

  it('12. utilisateur multi-organisations : aucun résidu entre espaces', async () => {
    await db.withTenant(as(ID.PM1), (c) => c.query('SELECT app.share_ticket($1, $2)', [ID.t1, ID.P1]));
    const seenAs = (org: string) => titles(as(org, ID.uMulti));
    assert.deepEqual(await seenAs(ID.P1), ['T1 B1/PM1 site A']);
    assert.deepEqual(await seenAs(ID.P2), []);
    assert.deepEqual(await seenAs(ID.P1), ['T1 B1/PM1 site A']);
  });

  it('13. le pool ne conserve aucun contexte entre deux transactions (max=1 connexion)', async () => {
    await titles(as(ID.B1));
    const n = await db.withoutTenant(async (c) => (await c.query('SELECT count(*)::int AS n FROM ticket')).rows[0].n);
    assert.equal(n, 0);
  });

  it('14. périmètre : un accès restreint à un site masque les autres sites', async () => {
    assert.deepEqual(await titles(as(ID.B1, ID.uB1, [ID.siteB1a])), ['T1 B1/PM1 site A', 'T2 B1/PM1 site A (non partagé)']);
    const sites = await db.withTenant(as(ID.B1, ID.uB1, [ID.siteB1b]), async (c) => (await c.query('SELECT nom FROM site')).rows.map((r) => r.nom));
    assert.deepEqual(sites, ['Site B1 B']);
  });

  it('15. visibilité des utilisateurs et appartenances limitée à l\'espace actif', async () => {
    const users = (org: string) => db.withTenant(as(org), async (c) => (await c.query('SELECT email FROM utilisateur ORDER BY email')).rows.map((r) => r.email));
    assert.deepEqual(await users(ID.PM1), ['pm1@test.invalid']);
    assert.deepEqual(await users(ID.P1), ['multi@test.invalid', 'p1@test.invalid']);
    assert.deepEqual(await users(ID.ED), []);
  });

  it('16. l\'éditeur ne lit aucune donnée métier', async () => {
    await db.withTenant(as(ID.ED), async (c) => {
      for (const t of ['site', 'ticket', 'fil', 'message', 'acces_objet', 'appartenance', 'fil_participant']) {
        assert.equal((await c.query(`SELECT count(*)::int AS n FROM ${t}`)).rows[0].n, 0, t);
      }
    });
  });

  it('17. modification ou création hors de son périmètre : refusées', async () => {
    const updated = await db.withTenant(as(ID.B2), (c) => c.query("UPDATE ticket SET statut = 'clos' WHERE id = $1", [ID.t1]));
    assert.equal(updated.rowCount, 0);
    await assert.rejects(
      db.withTenant(as(ID.B2), (c) => c.query("INSERT INTO ticket (owner_org_id, site_id, titre) VALUES ($1, $2, 'intrus')", [ID.B1, ID.siteB1a])), denied);
    await assert.rejects(
      db.withTenant(as(ID.B2), (c) => c.query("INSERT INTO site (org_id, nom) VALUES ($1, 'intrus')", [ID.B1])), denied);
    const statut = (await admin.query('SELECT statut FROM ticket WHERE id = $1', [ID.t1])).rows[0].statut;
    assert.equal(statut, 'nouveau');
  });
});

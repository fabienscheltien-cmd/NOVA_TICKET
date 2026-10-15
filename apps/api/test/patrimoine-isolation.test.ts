import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import type pg from 'pg';
import { ID, adminClient, appPool, seed, tenantDb } from './helpers.js';

const rls = /row-level security/;

describe('patrimoine — isolation, mandats et occupations', () => {
  let admin: pg.Client;
  const pool = appPool();
  const db = tenantDb(pool);
  const as = (orgId: string, scopeSiteIds?: string[]) => ({ orgId, userId: ID.uPM1, scopeSiteIds });
  const col = async (ctx: ReturnType<typeof as>, sql: string, params: unknown[] = []) =>
    db.withTenant(ctx, async (c) => (await c.query(sql, params)).rows.map((r) => Object.values(r)[0] as string));
  const q = <T = Record<string, unknown>>(sql: string, p: unknown[] = []) => admin.query(sql, p).then((r) => r.rows as T[]);

  let pfA: string; let pfB: string;
  let batB1a: string; let nivB1a: string; let locB1a: string; let locB1b: string; let locB2: string;
  let occ1: string; let occ2: string; let occB2: string;

  before(async () => {
    admin = await adminClient();
    await seed(admin);
    pfA = (await q<{ id: string }>("INSERT INTO portefeuille (org_id, nom) VALUES ($1, 'PF A') RETURNING id", [ID.B1]))[0]!.id;
    pfB = (await q<{ id: string }>("INSERT INTO portefeuille (org_id, nom) VALUES ($1, 'PF B') RETURNING id", [ID.B1]))[0]!.id;
    await q('UPDATE site SET portefeuille_id = $1 WHERE id = $2', [pfA, ID.siteB1a]);
    await q('UPDATE site SET portefeuille_id = $1 WHERE id = $2', [pfB, ID.siteB1b]);
    const mk = async (org: string, site: string, nom: string) => {
      const b = (await q<{ id: string }>('INSERT INTO batiment (org_id, site_id, nom) VALUES ($1,$2,$3) RETURNING id', [org, site, `Bât ${nom}`]))[0]!.id;
      const n = (await q<{ id: string }>('INSERT INTO niveau (org_id, site_id, batiment_id, nom) VALUES ($1,$2,$3,$4) RETURNING id', [org, site, b, `Niv ${nom}`]))[0]!.id;
      const l = (await q<{ id: string }>(
        "INSERT INTO local (org_id, site_id, niveau_id, nom, qr_code) VALUES ($1,$2,$3,$4,$5) RETURNING id", [org, site, n, `Local ${nom}`, `qr-${nom}`]))[0]!.id;
      return { b, n, l };
    };
    const a = await mk(ID.B1, ID.siteB1a, 'B1a');
    batB1a = a.b; nivB1a = a.n; locB1a = a.l;
    locB1b = (await mk(ID.B1, ID.siteB1b, 'B1b')).l;
    locB2 = (await mk(ID.B2, ID.siteB2, 'B2')).l;
    const occ = async (org: string, creator: string, nom: string) =>
      (await q<{ id: string }>('INSERT INTO occupant (org_id, cree_par_org_id, nom) VALUES ($1,$2,$3) RETURNING id', [org, creator, nom]))[0]!.id;
    occ1 = await occ(ID.B1, ID.B1, 'Société Un');
    occ2 = await occ(ID.B1, ID.PM1, 'Société Deux');
    occB2 = await occ(ID.B2, ID.B2, 'Société B2');
    await q("INSERT INTO occupation (org_id, site_id, local_id, occupant_id) VALUES ($1,$2,$3,$4)", [ID.B1, ID.siteB1a, locB1a, occ1]);
    await q("INSERT INTO occupation (org_id, site_id, local_id, occupant_id) VALUES ($1,$2,$3,$4)", [ID.B1, ID.siteB1a, locB1a, occ2]);
    await q("INSERT INTO occupation (org_id, site_id, local_id, occupant_id) VALUES ($1,$2,$3,$4)", [ID.B2, ID.siteB2, locB2, occB2]);
    await q("INSERT INTO contact (org_id, occupant_id, nom) VALUES ($1,$2,'Contact Un'), ($3,$4,'Contact B2')", [ID.B1, occ1, ID.B2, occB2]);
  });
  after(async () => { await admin.end(); await pool.end(); });

  const resetMandates = async () => {
    await q('DELETE FROM mandat_gestion');
    await q('INSERT INTO mandat_gestion (bailleur_org_id, pm_org_id) VALUES ($1, $2), ($3, $4)', [ID.B1, ID.PM1, ID.B2, ID.PM2]);
  };

  it('1. bailleur, PM sous mandat, PM sans mandat, prestataires : chacun ne voit que son périmètre', async () => {
    const sites = (org: string) => col(as(org), 'SELECT nom FROM site ORDER BY nom');
    assert.deepEqual(await sites(ID.B1), ['Site B1 A', 'Site B1 B']);
    assert.deepEqual(await sites(ID.PM1), ['Site B1 A', 'Site B1 B']);
    assert.deepEqual(await sites(ID.PM2), ['Site B2']);
    for (const org of [ID.PM3, ID.P1, ID.P2, ID.S1, ID.ED]) assert.deepEqual(await sites(org), [], `org ${org}`);
  });

  it('2. mandat limité à un portefeuille, à un site, futur ou échu : périmètre exact', async () => {
    const sites = () => col(as(ID.PM3), 'SELECT nom FROM site ORDER BY nom');
    const give = (extra: string, params: unknown[] = []) =>
      q(`INSERT INTO mandat_gestion (bailleur_org_id, pm_org_id, ${extra.split('|')[0]}) VALUES ($1, $2, ${extra.split('|')[1]})`, [ID.B1, ID.PM3, ...params]);
    try {
      await give('portefeuille_id|$3', [pfA]);
      assert.deepEqual(await sites(), ['Site B1 A']);
      await q('DELETE FROM mandat_gestion WHERE pm_org_id = $1', [ID.PM3]);
      await give('site_id|$3', [ID.siteB1b]);
      assert.deepEqual(await sites(), ['Site B1 B']);
      await q('DELETE FROM mandat_gestion WHERE pm_org_id = $1', [ID.PM3]);
      await give("debut|current_date + 1");
      assert.deepEqual(await sites(), [], 'mandat futur');
      await q('DELETE FROM mandat_gestion WHERE pm_org_id = $1', [ID.PM3]);
      await q("INSERT INTO mandat_gestion (bailleur_org_id, pm_org_id, debut, fin) VALUES ($1, $2, current_date - 10, current_date - 1)", [ID.B1, ID.PM3]);
      assert.deepEqual(await sites(), [], 'mandat échu');
    } finally { await resetMandates(); }
  });

  it('3. fin de mandat PM1 → PM3 : PM1 perd l\'accès, PM3 hérite de l\'historique, le bailleur le conserve', async () => {
    const tickets = (org: string) => col(as(org), 'SELECT titre FROM ticket ORDER BY titre');
    assert.equal((await tickets(ID.PM1)).length, 3);
    try {
      await q("UPDATE mandat_gestion SET debut = current_date - 30 WHERE pm_org_id = $1", [ID.PM1]);
      await q("UPDATE mandat_gestion SET fin = current_date - 1 WHERE pm_org_id = $1", [ID.PM1]);
      await q('INSERT INTO mandat_gestion (bailleur_org_id, pm_org_id) VALUES ($1, $2)', [ID.B1, ID.PM3]);
      assert.deepEqual(await tickets(ID.PM1), []);
      assert.deepEqual(await col(as(ID.PM1), 'SELECT nom FROM local'), []);
      assert.equal((await tickets(ID.PM3)).length, 3, 'historique hérité');
      assert.equal((await tickets(ID.B1)).length, 3, 'le bailleur reste propriétaire');
    } finally { await resetMandates(); }
  });

  it('4. bâtiments, niveaux, locaux, occupations, occupants, contacts : mêmes frontières', async () => {
    const counts = async (org: string) => {
      const r: Record<string, number> = {};
      await db.withTenant(as(org), async (c) => {
        for (const t of ['batiment', 'niveau', 'local', 'occupation', 'occupant', 'contact']) {
          r[t] = (await c.query(`SELECT count(*)::int AS n FROM ${t}`)).rows[0].n;
        }
      });
      return r;
    };
    const zero = { batiment: 0, niveau: 0, local: 0, occupation: 0, occupant: 0, contact: 0 };
    assert.deepEqual(await counts(ID.B1), { batiment: 2, niveau: 2, local: 2, occupation: 2, occupant: 2, contact: 1 });
    assert.deepEqual(await counts(ID.PM1), { batiment: 2, niveau: 2, local: 2, occupation: 2, occupant: 2, contact: 1 });
    assert.deepEqual(await counts(ID.B2), { batiment: 1, niveau: 1, local: 1, occupation: 1, occupant: 1, contact: 1 });
    for (const org of [ID.PM3, ID.P1, ID.S1, ID.ED]) assert.deepEqual(await counts(org), zero, `org ${org}`);
  });

  it('5. écriture : PM sous mandat oui, PM sans mandat et autre bailleur non, incohérence de bailleur refusée', async () => {
    const ins = (org: string, owner: string, site: string, nom: string) =>
      db.withTenant(as(org), (c) => c.query('INSERT INTO batiment (org_id, site_id, nom) VALUES ($1,$2,$3)', [owner, site, nom]));
    await ins(ID.PM1, ID.B1, ID.siteB1a, 'Bât ajouté par PM1');
    await assert.rejects(ins(ID.PM3, ID.B1, ID.siteB1a, 'intrus PM3'), rls);
    await assert.rejects(ins(ID.B2, ID.B1, ID.siteB1a, 'intrus B2'), rls);
    await assert.rejects(ins(ID.PM1, ID.B2, ID.siteB1a, 'bailleur incohérent'), /foreign key|row-level security/);
    await assert.rejects(ins(ID.PM1, ID.B2, ID.siteB2, 'site d\'un autre mandat'), rls);
    assert.equal((await q("SELECT count(*)::int AS n FROM batiment WHERE nom LIKE 'intrus%'"))[0]!.n, 0);
  });

  it('6. création de site par un PM : seulement pour un bailleur et un portefeuille couverts par un mandat', async () => {
    const mkSite = (org: string, owner: string, pf: string | null, nom: string) =>
      db.withTenant(as(org), async (c) =>
        (await c.query('INSERT INTO site (org_id, nom, portefeuille_id) VALUES ($1,$2,$3) RETURNING id', [owner, nom, pf])).rows[0].id as string);
    assert.ok(await mkSite(ID.PM1, ID.B1, pfA, 'Site créé par PM1'));
    await assert.rejects(mkSite(ID.PM1, ID.B2, null, 'chez un autre bailleur'), rls);
    await assert.rejects(mkSite(ID.PM3, ID.B1, null, 'sans mandat'), rls);
    try {
      await q('INSERT INTO mandat_gestion (bailleur_org_id, pm_org_id, portefeuille_id) VALUES ($1, $2, $3)', [ID.B1, ID.PM3, pfA]);
      assert.ok(await mkSite(ID.PM3, ID.B1, pfA, 'Site PF A par PM3'));
      await assert.rejects(mkSite(ID.PM3, ID.B1, pfB, 'hors portefeuille'), rls);
      await assert.rejects(mkSite(ID.PM3, ID.B1, null, 'sans portefeuille'), rls);
    } finally { await resetMandates(); }
  });

  it('7. le bailleur propriétaire d\'une ligne est immuable', async () => {
    await assert.rejects(q('UPDATE site SET org_id = $1 WHERE id = $2', [ID.B2, ID.siteB1a]), /ne peut pas être modifié|foreign key/);
    await assert.rejects(db.withTenant(as(ID.B1), (c) => c.query('UPDATE local SET org_id = $1 WHERE id = $2', [ID.B2, locB1a])), /ne peut pas être modifié|row-level security|foreign key/);
  });

  it('8. mandats : seul le bailleur crée et clôt ; visibles des deux parties ; types d\'organisation contrôlés', async (t) => {
    t.after(resetMandates);
    const mandats = (org: string) => col(as(org), 'SELECT pm_org_id FROM mandat_gestion');
    assert.deepEqual(await mandats(ID.PM1), [ID.PM1]);
    assert.deepEqual(await mandats(ID.PM3), []);
    await db.withTenant(as(ID.B1), (c) => c.query('INSERT INTO mandat_gestion (bailleur_org_id, pm_org_id) VALUES ($1, $2)', [ID.B1, ID.PM3]));
    assert.deepEqual(await mandats(ID.PM3), [ID.PM3]);
    assert.deepEqual(await mandats(ID.PM2), [ID.PM2], 'PM2 ne voit que ses mandats');
    await assert.rejects(db.withTenant(as(ID.PM3), (c) => c.query('INSERT INTO mandat_gestion (bailleur_org_id, pm_org_id) VALUES ($1, $2)', [ID.B2, ID.PM3])), rls);
    await assert.rejects(db.withTenant(as(ID.B1), (c) => c.query('INSERT INTO mandat_gestion (bailleur_org_id, pm_org_id) VALUES ($1, $2)', [ID.B1, ID.P1])), /property manager/);
    const byPm = await db.withTenant(as(ID.PM1), (c) => c.query('UPDATE mandat_gestion SET fin = current_date + 30 WHERE pm_org_id = $1', [ID.PM1]));
    assert.equal(byPm.rowCount, 0, 'le PM ne peut pas clore un mandat');
    const byBailleur = await db.withTenant(as(ID.B1), (c) => c.query('UPDATE mandat_gestion SET fin = current_date + 30 WHERE pm_org_id = $1', [ID.PM1]));
    assert.equal(byBailleur.rowCount, 1, 'le bailleur peut clore un mandat');
    const names = (org: string) => col(as(org), 'SELECT nom FROM organisation ORDER BY nom');
    assert.deepEqual(await names(ID.PM3), ['Bailleur 1', 'PM 3']);
    assert.deepEqual(await names(ID.PM2), ['Bailleur 2', 'PM 2']);
    assert.deepEqual(await names(ID.P1), ['Prestataire 1']);
  });

  it('9. occupations : occupants simultanés autorisés, chevauchement du même occupant interdit', async () => {
    const occupants = await col(as(ID.B1), 'SELECT o.nom FROM occupation x JOIN occupant o ON o.id = x.occupant_id WHERE x.local_id = $1 AND x.fin IS NULL ORDER BY o.nom', [locB1a]);
    assert.deepEqual(occupants, ['Société Deux', 'Société Un']);
    await assert.rejects(
      db.withTenant(as(ID.B1), (c) => c.query('INSERT INTO occupation (org_id, site_id, local_id, occupant_id, debut) VALUES ($1,$2,$3,$4, current_date)', [ID.B1, ID.siteB1a, locB1a, occ1])),
      /exclusion|conflicting key/i);
    // successif : on clôt l'occupation puis on en ouvre une nouvelle après la fin
    await q("UPDATE occupation SET debut = current_date - 20 WHERE occupant_id = $1", [occ1]);
    await q("UPDATE occupation SET fin = current_date - 5 WHERE occupant_id = $1", [occ1]);
    await db.withTenant(as(ID.B1), (c) => c.query('INSERT INTO occupation (org_id, site_id, local_id, occupant_id, debut) VALUES ($1,$2,$3,$4, current_date - 5)', [ID.B1, ID.siteB1a, locB1a, occ1]));
    await assert.rejects(db.withTenant(as(ID.B1), (c) => c.query("INSERT INTO occupation (org_id, site_id, local_id, occupant_id, debut, fin) VALUES ($1,$2,$3,$4, current_date, current_date)", [ID.B1, ID.siteB1a, locB1a, occ1])), /check|violates/);
  });

  it('10. occupants : un PM voit ceux de ses sites et ceux qu\'il a créés, jamais ceux d\'un autre mandat', async () => {
    const noms = (org: string) => col(as(org), 'SELECT nom FROM occupant ORDER BY nom');
    assert.deepEqual(await noms(ID.PM1), ['Société Deux', 'Société Un']);
    assert.deepEqual(await noms(ID.PM2), ['Société B2']);
    const created = await db.withTenant(as(ID.PM1), async (c) =>
      (await c.query("INSERT INTO occupant (org_id, cree_par_org_id, nom) VALUES ($1, $2, 'Nouveau PM1') RETURNING id", [ID.B1, ID.PM1])).rows[0].id as string);
    assert.ok((await noms(ID.PM1)).includes('Nouveau PM1'));
    assert.ok((await noms(ID.B1)).includes('Nouveau PM1'), 'le bailleur propriétaire le voit');
    assert.ok(!(await noms(ID.PM2)).includes('Nouveau PM1'));
    await assert.rejects(db.withTenant(as(ID.PM2), (c) => c.query("INSERT INTO occupant (org_id, cree_par_org_id, nom) VALUES ($1, $2, 'chez B1')", [ID.B1, ID.PM2])), rls);
    await db.withTenant(as(ID.PM1), (c) => c.query("INSERT INTO contact (org_id, occupant_id, nom) VALUES ($1, $2, 'Contact PM1')", [ID.B1, created]));
    await assert.rejects(db.withTenant(as(ID.PM2), (c) => c.query("INSERT INTO contact (org_id, occupant_id, nom) VALUES ($1, $2, 'intrus')", [ID.B1, created])), rls);
    assert.deepEqual(await col(as(ID.PM2), "SELECT nom FROM contact ORDER BY nom"), ['Contact B2']);
  });

  it('11. périmètre utilisateur : un PM restreint à un site ne voit que ce site et ses locaux, tickets', async () => {
    const ctx = as(ID.PM1, [ID.siteB1b]);
    assert.deepEqual(await col(ctx, 'SELECT nom FROM site ORDER BY nom'), ['Site B1 B']);
    assert.deepEqual(await col(ctx, 'SELECT nom FROM local ORDER BY nom'), ['Local B1b']);
    assert.deepEqual(await col(ctx, 'SELECT titre FROM ticket ORDER BY titre'), ['T4 B1/PM1 site B']);
  });

  it('12. QR : code unique, résolution limitée au périmètre visible', async () => {
    const resolve = (org: string) => col(as(org), 'SELECT id FROM local WHERE qr_code = $1', ['qr-B1a']);
    assert.deepEqual(await resolve(ID.B1), [locB1a]);
    assert.deepEqual(await resolve(ID.PM1), [locB1a]);
    for (const org of [ID.B2, ID.PM2, ID.PM3, ID.P1]) assert.deepEqual(await resolve(org), [], `org ${org}`);
    await assert.rejects(q("INSERT INTO local (org_id, site_id, niveau_id, nom, qr_code) VALUES ($1,$2,$3,'doublon','qr-B1a')", [ID.B1, ID.siteB1a, nivB1a]), /unique|duplicate/);
    assert.ok(batB1a && locB1b);
  });
});

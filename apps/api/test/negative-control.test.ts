import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import type pg from 'pg';
import { adminClient, checkCatalog, ID, seed } from './helpers.js';

/** Le banc de tests doit prouver qu'il détecte une régression : on casse volontairement la protection. */
describe('contrôle négatif — le banc détecte les fuites', () => {
  let admin: pg.Client;
  before(async () => { admin = await adminClient(); await seed(admin); });
  after(async () => { await admin.end(); });

  it('le contrôle de catalogue signale une table sans RLS ni politique', async () => {
    await admin.query('BEGIN');
    try {
      await admin.query('CREATE SCHEMA neg_control');
      await admin.query('CREATE TABLE neg_control.fuite (id int)');
      const violations = await checkCatalog(admin, 'neg_control');
      assert.deepEqual(violations.map((v) => v.problem).sort(), ['RLS non activée', 'RLS non forcée', 'aucune politique']);
    } finally {
      await admin.query('ROLLBACK');
    }
  });

  it('une politique désactivée provoque une fuite entre bailleurs, détectée par le test', async () => {
    await admin.query('BEGIN');
    try {
      await admin.query('ALTER TABLE ticket DISABLE ROW LEVEL SECURITY');
      await admin.query('SET LOCAL ROLE nova_app');
      await admin.query("SELECT set_config('app.org_id', $1, true)", [ID.B2]);
      const { rows } = await admin.query('SELECT titre FROM ticket ORDER BY titre');
      assert.ok(rows.length > 1, 'sans RLS, B2 voit les tickets des autres : le banc doit le constater');
      assert.throws(() => assert.deepEqual(rows.map((r) => r.titre), ['T3 B2/PM2']));
    } finally {
      await admin.query('ROLLBACK');
    }
    const { rows } = await admin.query('SELECT relrowsecurity FROM pg_class WHERE relname = $1', ['ticket']);
    assert.equal(rows[0].relrowsecurity, true, 'la protection doit être restaurée après le ROLLBACK');
  });
});

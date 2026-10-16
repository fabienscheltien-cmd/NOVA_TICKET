import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import type pg from 'pg';
import { adminClient, appPool, checkCatalog, DATA_TABLES, ID, seed, tenantDb } from './helpers.js';

const SECURITY_DEFINER_ALLOWLIST = [
  'app.assert_role_for_org', 'app.assert_ticket_manager', 'app.auth_get_user', 'app.auth_lookup',
  'app.auth_register_failure', 'app.auth_register_success', 'app.create_fil', 'app.invitation_accept_existing',
  'app.invitation_accept_new', 'app.mfa_begin', 'app.mfa_confirm', 'app.mfa_use_backup', 'app.org_deactivate',
  'app.resolve_membership', 'app.revoke_ticket_share', 'app.session_create', 'app.session_revoke',
  'app.session_revoke_user', 'app.session_rotate', 'app.share_ticket', 'app.trg_appartenance_role',
  'app.affecter_ticket', 'app.trg_annuaire_check', 'app.trg_mandat_check', 'app.user_deactivate', 'app.visible_sites', 'app.has_mandate_for', 'app.workspaces_of',
];

describe('niveau 1 — catalogue', () => {
  let admin: pg.Client;
  const pool = appPool();
  before(async () => { admin = await adminClient(); await seed(admin); });
  after(async () => { await admin.end(); await pool.end(); });

  it('toute table publique a RLS activée, forcée et au moins une politique', async () => {
    assert.deepEqual(await checkCatalog(admin), []);
  });

  it("le rôle applicatif n'est ni superutilisateur, ni BYPASSRLS, ni propriétaire d'une table", async () => {
    const role = await admin.query("SELECT rolsuper, rolbypassrls FROM pg_roles WHERE rolname = 'nova_app'");
    assert.equal(role.rows[0].rolsuper, false);
    assert.equal(role.rows[0].rolbypassrls, false);
    const owned = await admin.query(
      "SELECT c.relname FROM pg_class c JOIN pg_roles r ON r.oid = c.relowner WHERE r.rolname = 'nova_app' AND c.relkind IN ('r','p')");
    assert.equal(owned.rowCount, 0);
    const owner = await admin.query("SELECT rolsuper, rolbypassrls FROM pg_roles WHERE rolname = 'nova_owner'");
    assert.equal(owner.rows[0].rolsuper, false);
    assert.equal(owner.rows[0].rolbypassrls, false);
  });

  it('la liste des fonctions SECURITY DEFINER est figée', async () => {
    const { rows } = await admin.query<{ f: string }>(
      `SELECT n.nspname || '.' || p.proname AS f FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
        WHERE p.prosecdef AND n.nspname IN ('public', 'app') ORDER BY 1`);
    assert.deepEqual(rows.map((r) => r.f), [...SECURITY_DEFINER_ALLOWLIST].sort());
  });

  it("le rôle applicatif n'a aucun accès à schema_migrations", async () => {
    await assert.rejects(pool.query('SELECT 1 FROM schema_migrations'), /permission denied/);
  });

  it('sans espace de travail, toute lecture renvoie 0 ligne', async () => {
    const db = tenantDb(pool);
    for (const t of DATA_TABLES) {
      const n = await db.withoutTenant(async (c) => (await c.query(`SELECT count(*)::int AS n FROM ${t}`)).rows[0].n);
      assert.equal(n, 0, `table ${t}`);
    }
  });

  it('un contexte invalide est refusé avant tout accès', async () => {
    const db = tenantDb(pool);
    await assert.rejects(db.withTenant({ userId: 'x', orgId: ID.B1 }, async () => 1), /contexte invalide/);
    await assert.rejects(
      db.withTenant({ userId: ID.uB1, orgId: ID.B1, scopeSiteIds: ["x'; DROP TABLE site; --"] }, async () => 1),
      /périmètre invalide/);
  });
});

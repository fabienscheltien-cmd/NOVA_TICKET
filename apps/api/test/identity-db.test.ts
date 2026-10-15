import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import type pg from 'pg';
import { AuthService } from '../src/auth/auth.service.js';
import { MemoryMailer } from '../src/auth/mailer.js';
import { createOrgWithAdminInvitation } from '../src/db/create-org.js';
import { sha256Hex } from '../src/auth/crypto.js';
import { AUTH_TABLES, ID, TEST_PASSWORD, adminClient, appPool, authConfig, createUser, seed, tenantDb } from './helpers.js';

describe('identité — base de données', () => {
  let admin: pg.Client;
  const pool = appPool();
  const db = tenantDb(pool);
  const mailer = new MemoryMailer();
  const svc = new AuthService(db, authConfig(), mailer);
  const stats = async (sql: string, p: unknown[] = []) => (await admin.query(sql, p)).rows;

  before(async () => { admin = await adminClient(); await seed(admin); });
  after(async () => { await admin.end(); await pool.end(); });

  it('nova_app ne peut lire aucune table d\'authentification ni exécuter les fonctions d\'administration', async () => {
    for (const t of AUTH_TABLES) await assert.rejects(pool.query(`SELECT 1 FROM ${t}`), /permission denied/, t);
    for (const f of ['app.org_deactivate(uuid)', 'app.user_deactivate(uuid)', 'app.assert_role_for_org(text, uuid)', 'app.trg_appartenance_role()']) {
      const [{ ok }] = await stats("SELECT has_function_privilege('nova_app', $1, 'EXECUTE') AS ok", [f]);
      assert.equal(ok, false, f);
    }
  });

  it('un rôle incompatible avec le type d\'organisation est refusé (technicien chez un bailleur)', async () => {
    const u = await createUser(admin, { email: 'tech@test.invalid', memberships: [[ID.P1, 'technicien']] });
    await assert.rejects(admin.query("INSERT INTO appartenance (utilisateur_id, org_id, role) VALUES ($1, $2, 'technicien')", [u, ID.B1]), /n'est pas autorisé|check/i);
    await assert.rejects(admin.query("INSERT INTO appartenance (utilisateur_id, org_id, role) VALUES ($1, $2, 'inexistant')", [u, ID.PM1]));
  });

  it('création d\'organisation + invitation admin (CLI) puis acceptation : un seul usage', async () => {
    const { orgId, token } = await createOrgWithAdminInvitation(admin, { type: 'bailleur', nom: 'Bailleur CLI', adminEmail: 'Admin@Cli.Test.invalid' });
    const stored = (await stats('SELECT token_hash, email FROM invitation WHERE org_id = $1', [orgId]))[0];
    assert.equal(stored.token_hash, sha256Hex(token));
    assert.notEqual(stored.token_hash, token, 'seule l\'empreinte est stockée');
    assert.equal(stored.email, 'admin@cli.test.invalid');
    const tokens = await svc.acceptInvitationNew(token, { password: TEST_PASSWORD, nom: 'Admin CLI' });
    assert.ok(tokens.access_token && tokens.refresh_token);
    await assert.rejects(svc.acceptInvitationNew(token, { password: TEST_PASSWORD, nom: 'Bis' }), /invalide|expirée/);
    const ws = await svc.listWorkspaces((await stats("SELECT id FROM utilisateur WHERE email = 'admin@cli.test.invalid'"))[0].id);
    assert.deepEqual(ws.map((w) => [w.nom, w.role]), [['Bailleur CLI', 'admin_org']]);
  });

  it('invitation expirée ou révoquée refusée ; mot de passe faible refusé', async () => {
    const { orgId, token } = await createOrgWithAdminInvitation(admin, { type: 'property_manager', nom: 'PM expiré', adminEmail: 'exp@test.invalid' });
    await assert.rejects(svc.acceptInvitationNew(token, { password: 'court', nom: 'X' }), /12 caractères/);
    await admin.query("UPDATE invitation SET expires_at = now() - interval '1 minute' WHERE org_id = $1", [orgId]);
    await assert.rejects(svc.acceptInvitationNew(token, { password: TEST_PASSWORD, nom: 'X' }), /invalide|expirée/);
    const r = await createOrgWithAdminInvitation(admin, { type: 'property_manager', nom: 'PM révoqué', adminEmail: 'rev@test.invalid' });
    await admin.query('UPDATE invitation SET revoked_at = now() WHERE org_id = $1', [r.orgId]);
    await assert.rejects(svc.acceptInvitationNew(r.token, { password: TEST_PASSWORD, nom: 'X' }), /invalide|expirée/);
  });

  it('invitations : visibles uniquement de leur organisation', async () => {
    const admin1 = await createUser(admin, { email: 'adm-b1@test.invalid', memberships: [[ID.B1, 'admin_org']] });
    await svc.createInvitation({ userId: admin1, orgId: ID.B1 }, { email: 'nouveau@test.invalid', role: 'responsable_site' });
    assert.equal(mailer.sent.at(-1)?.to, 'nouveau@test.invalid');
    const count = (org: string) => db.withTenant({ userId: admin1, orgId: org }, async (c) => (await c.query('SELECT count(*)::int AS n FROM invitation')).rows[0].n);
    assert.equal(await count(ID.B1), 1);
    assert.equal(await count(ID.B2), 0);
    await assert.rejects(svc.createInvitation({ userId: admin1, orgId: ID.B1 }, { email: 'x@test.invalid', role: 'technicien' }), /Rôle non autorisé/);
    await assert.rejects(
      db.withTenant({ userId: admin1, orgId: ID.B2 }, (c) => c.query("INSERT INTO invitation (org_id, email, role, token_hash, expires_at) VALUES ($1, 'x@y.z', 'admin_org', 'h', now())", [ID.B1])),
      /row-level security/);
  });

  it('resolve_membership : refus pour une organisation étrangère, un membre retiré, un utilisateur ou une organisation désactivés', async () => {
    const uid = await createUser(admin, { email: 'multi2@test.invalid', memberships: [[ID.P1, 'technicien'], [ID.P2, 'technicien']] });
    assert.equal((await svc.resolveMembership(uid, ID.P1))?.role, 'technicien');
    assert.equal(await svc.resolveMembership(uid, ID.B1), null);
    await admin.query('UPDATE appartenance SET actif = false WHERE utilisateur_id = $1 AND org_id = $2', [uid, ID.P2]);
    assert.equal(await svc.resolveMembership(uid, ID.P2), null);
    assert.deepEqual((await svc.listWorkspaces(uid)).map((w) => w.org_id), [ID.P1]);
  });

  it('désactivation d\'organisation en cascade : appartenances, invitations, sessions sans autre espace', async () => {
    const orgX = (await admin.query("INSERT INTO organisation (type, nom) VALUES ('prestataire', 'Presta X') RETURNING id")).rows[0].id as string;
    const solo = await createUser(admin, { email: 'solo@test.invalid', memberships: [[orgX, 'technicien']] });
    const duo = await createUser(admin, { email: 'duo@test.invalid', memberships: [[orgX, 'technicien'], [ID.P3, 'technicien']] });
    const soloTok = await svc.issueTokens(solo);
    const duoTok = await svc.issueTokens(duo);
    await admin.query("INSERT INTO invitation (org_id, email, role, token_hash, expires_at) VALUES ($1, 'p@test.invalid', 'technicien', 'hX', now() + interval '1 day')", [orgX]);
    await admin.query('SELECT app.org_deactivate($1)', [orgX]);
    assert.equal(await svc.resolveMembership(solo, orgX), null);
    assert.equal(await svc.resolveMembership(duo, orgX), null);
    assert.equal((await svc.resolveMembership(duo, ID.P3))?.role, 'technicien', 'l\'autre espace reste utilisable');
    assert.ok((await stats("SELECT revoked_at FROM invitation WHERE token_hash = 'hX'"))[0].revoked_at);
    await assert.rejects(svc.refresh(soloTok.refresh_token), /invalid_refresh_token|401/);
    assert.ok((await svc.refresh(duoTok.refresh_token)).access_token, 'sessions conservées pour qui garde un espace actif');
  });

  it('désactivation d\'utilisateur : connexion, rafraîchissement et espaces refusés', async () => {
    const uid = await createUser(admin, { email: 'partant@test.invalid', memberships: [[ID.P3, 'technicien']] });
    const tok = await svc.issueTokens(uid);
    await admin.query('SELECT app.user_deactivate($1)', [uid]);
    await assert.rejects(svc.login('partant@test.invalid', TEST_PASSWORD), /Identifiants invalides/);
    await assert.rejects(svc.refresh(tok.refresh_token), /401|invalid/);
    assert.deepEqual(await svc.listWorkspaces(uid), []);
    assert.equal(await svc.resolveMembership(uid, ID.P3), null);
  });

  it('rotation du jeton de rafraîchissement : réutilisation = révocation de toute la famille', async () => {
    const uid = await createUser(admin, { email: 'rot@test.invalid', memberships: [[ID.P3, 'technicien']] });
    const first = await svc.issueTokens(uid);
    const second = await svc.refresh(first.refresh_token);
    await assert.rejects(svc.refresh(first.refresh_token), /401|invalid/);
    await assert.rejects(svc.refresh(second.refresh_token), /401|invalid/, 'la famille entière est révoquée');
    const hashes = (await stats('SELECT token_hash FROM session_refresh WHERE utilisateur_id = $1', [uid])).map((r) => r.token_hash);
    assert.ok(hashes.every((h: string) => h.length === 64 && h !== first.refresh_token), 'jetons stockés hachés');
  });

  it('verrouillage après 5 échecs ; réponse identique pour compte inconnu et mauvais mot de passe', async () => {
    await createUser(admin, { email: 'lock@test.invalid', memberships: [[ID.P3, 'technicien']] });
    const err = async (e: string, p: string) => svc.login(e, p).then(() => null, (x: Error) => JSON.stringify((x as { getResponse?: () => unknown }).getResponse?.()));
    const unknown = await err('inconnu@test.invalid', 'x');
    const wrong = await err('lock@test.invalid', 'mauvais');
    assert.equal(unknown, wrong);
    for (let i = 0; i < 4; i++) await err('lock@test.invalid', 'mauvais');
    assert.equal(await err('lock@test.invalid', TEST_PASSWORD), wrong, 'verrouillé : même réponse générique');
    await admin.query("UPDATE credential SET locked_until = NULL WHERE utilisateur_id = (SELECT id FROM utilisateur WHERE email = 'lock@test.invalid')");
    const ok = await svc.login('LOCK@test.invalid', TEST_PASSWORD);
    assert.equal(ok.status, 'ok');
  });
});

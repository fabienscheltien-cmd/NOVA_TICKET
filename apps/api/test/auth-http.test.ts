import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import type { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import type pg from 'pg';
import { AppModule } from '../src/app.module.js';
import { MAILER, MemoryMailer } from '../src/auth/mailer.js';
import { totp } from '../src/auth/totp.js';
import { ID, TEST_PASSWORD, adminClient, createUser, seed } from './helpers.js';

describe('authentification — parcours HTTP de bout en bout', () => {
  let admin: pg.Client;
  let app: INestApplication;
  let base: string;
  const mailer = new MemoryMailer();

  const call = async (method: string, path: string, opts: { body?: unknown; token?: string } = {}) => {
    const res = await fetch(base + path, {
      method,
      headers: { 'content-type': 'application/json', ...(opts.token ? { authorization: `Bearer ${opts.token}` } : {}) },
      body: opts.body === undefined ? undefined : JSON.stringify(opts.body),
    });
    const text = await res.text();
    return { status: res.status, json: text ? JSON.parse(text) : null };
  };

  let adminId: string;
  let adminSecret: string;
  let adminRefresh: string;
  let adminOrgToken: string;
  let inviteToken: string;
  let newUserTokens: { access_token: string; refresh_token: string };

  before(async () => {
    admin = await adminClient();
    await seed(admin);
    const mod = await Test.createTestingModule({ imports: [AppModule] }).overrideProvider(MAILER).useValue(mailer).compile();
    app = mod.createNestApplication();
    await app.listen(0, '127.0.0.1');
    base = (await app.getUrl()).replace('[::1]', '127.0.0.1');
    adminId = await createUser(admin, { email: 'admin.b1@test.invalid', memberships: [[ID.B1, 'admin_org']] });
  });
  after(async () => { await app.close(); await admin.end(); });

  it('santé et routes protégées', async () => {
    assert.deepEqual((await call('GET', '/health')).json, { status: 'ok' });
    assert.equal((await call('GET', '/me/workspaces')).status, 401);
    assert.equal((await call('POST', '/invitations', { body: { email: 'a@b.co', role: 'admin_org' } })).status, 401);
    assert.equal((await call('GET', '/me/workspaces', { token: 'pas.un.jeton' })).status, 401);
  });

  it('un administrateur sans MFA ne peut pas entrer dans un espace, puis active la MFA', async () => {
    const login = await call('POST', '/auth/login', { body: { email: 'admin.b1@test.invalid', password: TEST_PASSWORD } });
    assert.equal(login.status, 200);
    assert.equal(login.json.status, 'ok');
    const userToken = login.json.access_token as string;
    const ws = await call('GET', '/me/workspaces', { token: userToken });
    assert.deepEqual(ws.json.workspaces.map((w: { nom: string; role: string }) => [w.nom, w.role]), [['Bailleur 1', 'admin_org']]);
    const refused = await call('POST', '/me/workspace/switch', { token: userToken, body: { org_id: ID.B1 } });
    assert.equal(refused.status, 403);
    assert.equal(refused.json.error, 'mfa_enrollment_required');

    const setup = await call('POST', '/me/mfa/setup', { token: userToken });
    assert.equal(setup.status, 200);
    adminSecret = setup.json.secret;
    assert.match(setup.json.otpauth_uri, /^otpauth:\/\/totp\//);
    assert.equal((await call('POST', '/me/mfa/confirm', { token: userToken, body: { code: '000000' } })).status, 400);
    const confirm = await call('POST', '/me/mfa/confirm', { token: userToken, body: { code: totp(adminSecret, Date.now()) } });
    assert.equal(confirm.status, 200);
    assert.equal(confirm.json.backup_codes.length, 10);
    const stored = (await admin.query('SELECT mfa_secret_enc FROM credential WHERE utilisateur_id = $1', [adminId])).rows[0].mfa_secret_enc as string;
    assert.ok(!stored.includes(adminSecret), 'secret MFA chiffré au repos');
  });

  it('connexion avec MFA : code faux refusé, code correct accepté, accès à l\'espace', async () => {
    const login = await call('POST', '/auth/login', { body: { email: 'admin.b1@test.invalid', password: TEST_PASSWORD } });
    assert.equal(login.json.status, 'mfa_required');
    assert.equal(login.json.access_token, undefined);
    const bad = await call('POST', '/auth/mfa/verify', { body: { mfa_token: login.json.mfa_token, code: '123456' } });
    assert.equal(bad.status, 401);
    const good = await call('POST', '/auth/mfa/verify', { body: { mfa_token: login.json.mfa_token, code: totp(adminSecret, Date.now()) } });
    assert.equal(good.status, 200);
    adminRefresh = good.json.refresh_token;
    const sw = await call('POST', '/me/workspace/switch', { token: good.json.access_token, body: { org_id: ID.B1 } });
    assert.equal(sw.status, 200);
    adminOrgToken = sw.json.access_token;
    assert.equal(sw.json.role, 'admin_org');
    // un jeton MFA ne sert pas de jeton d'accès
    assert.equal((await call('GET', '/me/workspaces', { token: login.json.mfa_token })).status, 401);
  });

  it('espace non autorisé refusé', async () => {
    const t = (await call('POST', '/auth/refresh', { body: { refresh_token: adminRefresh } })).json.access_token as string;
    const r = await call('POST', '/me/workspace/switch', { token: t, body: { org_id: ID.B2 } });
    assert.equal(r.status, 403);
    assert.equal(r.json.error, 'not_a_member');
  });

  it('invitation : rôle incompatible refusé, invitation valide envoyée par e-mail simulé', async () => {
    const wrongRole = await call('POST', '/invitations', { token: adminOrgToken, body: { email: 'tech@test.invalid', role: 'technicien' } });
    assert.equal(wrongRole.status, 400);
    assert.equal(wrongRole.json.error, 'role_not_allowed');
    const ok = await call('POST', '/invitations', { token: adminOrgToken, body: { email: 'Resp.Site@Test.invalid', role: 'responsable_site' } });
    assert.equal(ok.status, 201);
    const mail = mailer.sent.at(-1)!;
    assert.equal(mail.to, 'resp.site@test.invalid');
    inviteToken = mail.link.split('/').at(-1)!;
    assert.ok(inviteToken.length >= 40);
  });

  it('acceptation : mot de passe faible refusé, compte créé, jeton à usage unique', async () => {
    const weak = await call('POST', `/invitations/${inviteToken}/accept`, { body: { password: 'court', nom: 'Resp' } });
    assert.equal(weak.status, 400);
    const ok = await call('POST', `/invitations/${inviteToken}/accept`, { body: { password: TEST_PASSWORD, nom: 'Resp Site' } });
    assert.equal(ok.status, 200);
    newUserTokens = ok.json;
    const again = await call('POST', `/invitations/${inviteToken}/accept`, { body: { password: TEST_PASSWORD, nom: 'Resp Site' } });
    assert.equal(again.status, 400);
    assert.equal(again.json.error, 'invalid_invitation');
  });

  it('un responsable de site accède à son espace mais pas à l\'administration des utilisateurs', async () => {
    const sw = await call('POST', '/me/workspace/switch', { token: newUserTokens.access_token, body: { org_id: ID.B1 } });
    assert.equal(sw.status, 200);
    const inv = await call('POST', '/invitations', { token: sw.json.access_token, body: { email: 'z@test.invalid', role: 'responsable_site' } });
    assert.equal(inv.status, 403);
    assert.equal(inv.json.error, 'missing_permission');
  });

  it('les invitations et retraits d\'un espace ne s\'appliquent pas à un autre espace', async () => {
    const r = await call('POST', `/organisations/${ID.B2}/members/${adminId}/deactivate`, { token: adminOrgToken });
    assert.equal(r.status, 403);
    assert.equal(r.json.error, 'wrong_workspace');
  });

  it('retrait d\'un membre : effet immédiat malgré un jeton encore valide ; dernier administrateur protégé', async () => {
    const sw = await call('POST', '/me/workspace/switch', { token: newUserTokens.access_token, body: { org_id: ID.B1 } });
    const orgToken = sw.json.access_token as string;
    const memberId = (await admin.query("SELECT id FROM utilisateur WHERE email = 'resp.site@test.invalid'")).rows[0].id as string;
    assert.equal((await call('POST', `/organisations/${ID.B1}/members/${memberId}/deactivate`, { token: adminOrgToken })).status, 204);
    const after = await call('POST', '/invitations', { token: orgToken, body: { email: 'z@test.invalid', role: 'responsable_site' } });
    assert.equal(after.status, 403);
    assert.equal(after.json.error, 'not_a_member');
    assert.equal((await call('POST', '/me/workspace/switch', { token: newUserTokens.access_token, body: { org_id: ID.B1 } })).status, 403);
    const last = await call('POST', `/organisations/${ID.B1}/members/${adminId}/deactivate`, { token: adminOrgToken });
    assert.equal(last.status, 409);
    assert.equal(last.json.error, 'last_admin');
  });

  it('rafraîchissement avec rotation ; déconnexion invalide le jeton', async () => {
    const r1 = await call('POST', '/auth/refresh', { body: { refresh_token: newUserTokens.refresh_token } });
    assert.equal(r1.status, 200);
    assert.notEqual(r1.json.refresh_token, newUserTokens.refresh_token);
    assert.equal((await call('POST', '/auth/logout', { body: { refresh_token: r1.json.refresh_token } })).status, 204);
    assert.equal((await call('POST', '/auth/refresh', { body: { refresh_token: r1.json.refresh_token } })).status, 401);
  });

  it('utilisateur existant : invitation à un second espace, uniquement pour sa propre adresse', async () => {
    const pmAdmin = await createUser(admin, { email: 'admin.pm1@test.invalid', memberships: [[ID.PM1, 'admin_org']], mfaSecret: 'JBSWY3DPEHPK3PXP' });
    const tech = await createUser(admin, { email: 'tech.p1@test.invalid', memberships: [[ID.P1, 'technicien']] });
    const l = await call('POST', '/auth/login', { body: { email: 'admin.pm1@test.invalid', password: TEST_PASSWORD } });
    const v = await call('POST', '/auth/mfa/verify', { body: { mfa_token: l.json.mfa_token, code: totp('JBSWY3DPEHPK3PXP', Date.now()) } });
    const orgTok = (await call('POST', '/me/workspace/switch', { token: v.json.access_token, body: { org_id: ID.PM1 } })).json.access_token as string;
    assert.equal((await call('POST', '/invitations', { token: orgTok, body: { email: 'tech.p1@test.invalid', role: 'prestataire_externe' } })).status, 201);
    const token = mailer.sent.at(-1)!.link.split('/').at(-1)!;
    const conflict = await call('POST', `/invitations/${token}/accept`, { body: { password: TEST_PASSWORD, nom: 'Tech' } });
    assert.equal(conflict.status, 409);
    assert.equal(conflict.json.error, 'account_exists');
    const techLogin = await call('POST', '/auth/login', { body: { email: 'tech.p1@test.invalid', password: TEST_PASSWORD } });
    const other = await call('POST', '/auth/login', { body: { email: 'admin.b1@test.invalid', password: TEST_PASSWORD } });
    assert.equal(other.json.status, 'mfa_required');
    const wrong = await call('POST', `/me/invitations/${token}/accept`, { token: v.json.access_token });
    assert.equal(wrong.status, 400, 'une autre adresse ne peut pas accepter');
    const ok = await call('POST', `/me/invitations/${token}/accept`, { token: techLogin.json.access_token });
    assert.equal(ok.status, 200);
    assert.equal(ok.json.org_id, ID.PM1);
    const ws = await call('GET', '/me/workspaces', { token: techLogin.json.access_token });
    assert.deepEqual(ws.json.workspaces.map((w: { role: string }) => w.role).sort(), ['prestataire_externe', 'technicien']);
    assert.ok(pmAdmin && tech);
  });

  it('codes de secours : un code ne sert qu\'une fois', async () => {
    const secret = 'KRSXG5CTMVRXEZLU';
    const uid = await createUser(admin, { email: 'backup@test.invalid', memberships: [[ID.B2, 'admin_org']], mfaSecret: secret });
    const codes = ['abcde-12345', 'fedcb-54321'];
    const { sha256Hex } = await import('../src/auth/crypto.js');
    for (const c of codes) await admin.query('INSERT INTO code_secours (utilisateur_id, code_hash) VALUES ($1, $2)', [uid, sha256Hex(c)]);
    const attempt = async (code: string) => {
      const l = await call('POST', '/auth/login', { body: { email: 'backup@test.invalid', password: TEST_PASSWORD } });
      return call('POST', '/auth/mfa/verify', { body: { mfa_token: l.json.mfa_token, code } });
    };
    assert.equal((await attempt('ABCDE-12345')).status, 200);
    assert.equal((await attempt('abcde-12345')).status, 401);
    assert.equal((await attempt('fedcb-54321')).status, 200);
  });
});

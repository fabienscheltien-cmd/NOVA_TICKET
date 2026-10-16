import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import type pg from 'pg';
import { ID, TEST_PASSWORD, adminClient, createUser, seed } from './helpers.js';
import { MFA_SECRET, type TestApp, startTestApp } from './http-helpers.js';

const NOUVEAU = 'un tout nouveau mot de passe';
const jeton = (t: TestApp) => t.mailer.resets.at(-1)!.link.split('/').at(-1)!;

describe('mot de passe oublié', () => {
  let admin: pg.Client;
  let t: TestApp;

  before(async () => {
    admin = await adminClient();
    await seed(admin);
    await createUser(admin, { email: 'oubli@test.invalid', memberships: [[ID.PM1, 'accueil']] });
    await createUser(admin, { email: 'mfa@test.invalid', memberships: [[ID.PM1, 'gestionnaire_fm']], mfaSecret: MFA_SECRET });
    t = await startTestApp();
  });
  after(async () => { await t.close(); await admin.end(); });

  const forgot = (email: string) => t.call('POST', '/auth/password/forgot', { body: { email } });
  const reset = (token: string, password = NOUVEAU) => t.call('POST', '/auth/password/reset', { body: { token, password } });
  const login = (email: string, password: string) => t.call('POST', '/auth/login', { body: { email, password } });

  it('1. réponse identique pour une adresse connue ou inconnue ; e-mail seulement pour un compte réel', async () => {
    const avant = t.mailer.resets.length;
    const inconnu = await forgot('personne@test.invalid');
    const connu = await forgot('oubli@test.invalid');
    assert.equal(inconnu.status, 202);
    assert.deepEqual(inconnu.json, connu.json);
    assert.equal(t.mailer.resets.length, avant + 1);
    assert.equal(t.mailer.resets.at(-1)!.to, 'oubli@test.invalid');
    assert.equal((await t.call('POST', '/auth/password/forgot', { body: { email: 'pas-un-courriel' } })).status, 400);
  });

  it('2. une demande par minute et par compte : la seconde ne produit pas d\'e-mail', async () => {
    const n = t.mailer.resets.length;
    assert.equal((await forgot('oubli@test.invalid')).status, 202);
    assert.equal(t.mailer.resets.length, n);
  });

  it('3. réinitialisation : nouveau mot de passe, ancien refusé, sessions révoquées, jeton à usage unique', async () => {
    const session = (await login('oubli@test.invalid', TEST_PASSWORD)).json;
    assert.ok(session.refresh_token);
    const token = jeton(t);
    assert.equal((await reset(token, 'court')).status, 400, 'longueur minimale');
    assert.equal((await reset(token)).status, 204);
    assert.equal((await login('oubli@test.invalid', TEST_PASSWORD)).status, 401);
    assert.equal((await login('oubli@test.invalid', NOUVEAU)).status, 200);
    const rafraichi = await t.call('POST', '/auth/refresh', { body: { refresh_token: session.refresh_token } });
    assert.equal(rafraichi.status, 401, 'les sessions ouvertes avant la réinitialisation sont révoquées');
    const rejeu = await reset(token, 'encore un autre mot de passe');
    assert.equal(rejeu.status, 400);
    assert.equal(rejeu.json.error, 'invalid_reset_link');
    assert.equal((await reset('x'.repeat(40))).status, 400, 'jeton inconnu');
  });

  it('4. un jeton expiré est refusé ; une nouvelle demande invalide la précédente', async () => {
    await admin.query("UPDATE password_reset SET created_at = now() - interval '5 minutes'");
    await forgot('oubli@test.invalid');
    const premier = jeton(t);
    await admin.query("UPDATE password_reset SET created_at = now() - interval '5 minutes'");
    await forgot('oubli@test.invalid');
    const second = jeton(t);
    assert.notEqual(premier, second);
    assert.equal((await reset(premier)).status, 400, 'remplacé par la demande suivante');
    await admin.query("UPDATE password_reset SET expires_at = now() - interval '1 second' WHERE used_at IS NULL");
    assert.equal((await reset(second)).status, 400, 'expiré');
  });

  it('5. déverrouille le compte, mais la double authentification reste exigée', async () => {
    for (let i = 0; i < 5; i++) await login('mfa@test.invalid', 'mauvais mot de passe long');
    assert.equal((await login('mfa@test.invalid', TEST_PASSWORD)).status, 401, 'compte verrouillé');
    await forgot('mfa@test.invalid');
    assert.equal((await reset(jeton(t))).status, 204);
    const l = await login('mfa@test.invalid', NOUVEAU);
    assert.equal(l.status, 200);
    assert.equal(l.json.status, 'mfa_required', 'pas de contournement de la MFA');
    assert.equal(l.json.access_token, undefined);
  });

  it('6. un compte désactivé ne reçoit rien', async () => {
    await admin.query("UPDATE utilisateur SET statut = 'desactive' WHERE email = 'oubli@test.invalid'");
    await admin.query("UPDATE password_reset SET created_at = now() - interval '5 minutes'");
    const n = t.mailer.resets.length;
    assert.equal((await forgot('oubli@test.invalid')).status, 202);
    assert.equal(t.mailer.resets.length, n);
  });

  it('7. le jeton n\'est jamais stocké en clair', async () => {
    const lignes = (await admin.query('SELECT token_hash FROM password_reset')).rows.map((r) => r.token_hash as string);
    for (const m of t.mailer.resets) assert.ok(!lignes.includes(m.link.split('/').at(-1)!));
  });
});

describe('limitation de débit par IP', () => {
  let t: TestApp;
  before(async () => { t = await startTestApp({ rateLimitAuthPerMin: 3 }); });
  after(async () => { await t.close(); });

  it('renvoie 429 avec Retry-After au-delà de la limite, par seau ; les autres routes ne sont pas touchées', async () => {
    const tentative = () => fetch(`${t.base}/auth/login`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email: 'a@b.test', password: 'x' }),
    });
    for (let i = 0; i < 3; i++) assert.equal((await tentative()).status, 401);
    const bloque = await tentative();
    assert.equal(bloque.status, 429);
    assert.ok(Number(bloque.headers.get('retry-after')) >= 1);
    assert.equal((await bloque.json() as { error: string }).error, 'too_many_requests');
    const autre = await t.call('POST', '/auth/password/forgot', { body: { email: 'a@b.test' } });
    assert.equal(autre.status, 202, 'seau distinct');
    assert.equal((await fetch(`${t.base}/health`)).status, 200);
  });
});

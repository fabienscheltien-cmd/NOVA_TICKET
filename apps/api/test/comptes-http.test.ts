import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import type pg from 'pg';
import { ApiRepository } from '@nova/shared';
import { ID, TEST_PASSWORD, adminClient, createUser, seed } from './helpers.js';
import { MFA_SECRET, type TestApp, startTestApp } from './http-helpers.js';

/**
 * Comptes prestataires par invitation, bailleur en lecture seule, vision de l'administrateur sur son organisation.
 */
describe('comptes — invitation prestataire, bailleur lecture seule, vision admin', () => {
  let admin: pg.Client;
  let t: TestApp;
  const tok: Record<string, string> = {};
  let famille = ''; let fiche = ''; let ticket = '';

  const dernierJeton = () => t.mailer.sent.at(-1)!.link.split('/').at(-1)!;

  before(async () => {
    admin = await adminClient();
    await seed(admin);
    await createUser(admin, { email: 'admin.pm1@test.invalid', memberships: [[ID.PM1, 'admin_org']], mfaSecret: MFA_SECRET });
    await createUser(admin, { email: 'fm.pm1@test.invalid', memberships: [[ID.PM1, 'gestionnaire_fm']], mfaSecret: MFA_SECRET });
    await createUser(admin, { email: 'accueil.pm1@test.invalid', memberships: [[ID.PM1, 'accueil']] });
    await createUser(admin, { email: 'admin.pm2@test.invalid', memberships: [[ID.PM2, 'admin_org']], mfaSecret: MFA_SECRET });
    await createUser(admin, { email: 'admin.b1@test.invalid', memberships: [[ID.B1, 'admin_org']], mfaSecret: MFA_SECRET });
    t = await startTestApp();
    tok.adminPm1 = await t.loginOrg('admin.pm1@test.invalid', ID.PM1);
    tok.fm = await t.loginOrg('fm.pm1@test.invalid', ID.PM1);
    tok.accueil = await t.loginOrg('accueil.pm1@test.invalid', ID.PM1);
    tok.adminPm2 = await t.loginOrg('admin.pm2@test.invalid', ID.PM2);
    tok.adminB1 = await t.loginOrg('admin.b1@test.invalid', ID.B1);
    const repo = new ApiRepository({ baseUrl: t.base, getToken: () => tok.fm! });
    famille = (await repo.createFamille({ libelle: 'Comptes e2e' })).id;
    fiche = (await repo.createPrestataire({ nom: 'Plomb Invité', familles: [{ famille_id: famille, priorite: 1 }] })).id;
    ticket = (await repo.createTicket({ titre: 'Fuite comptes', famille_id: famille, site_id: ID.siteB1a })).id;
  });
  after(async () => { await t.close(); await admin.end(); });

  const inviter = (token: string, id = fiche, email = 'plombier@prestataire.test') =>
    t.call('POST', `/annuaire/${id}/invitation`, { token, body: { email } });

  it('1. le dispatcheur invite : e-mail simulé, mais aucun rattachement ni éligibilité avant acceptation', async () => {
    const r = await inviter(tok.fm!);
    assert.equal(r.status, 200);
    assert.equal(r.json.prestataire_org_id, null);
    assert.equal(r.json.invitation_email, 'plombier@prestataire.test');
    assert.equal(t.mailer.sent.at(-1)!.invitePar, 'PM 1 (mandats B1 et B2)');
    const aff = await t.call('POST', `/tickets/${ticket}/affectation`, { token: tok.fm, body: { annuaire_id: fiche } });
    assert.equal(aff.status, 422);
    assert.equal(aff.json.raison, 'non_rattache');
    // l'organisation en attente n'a aucun membre : rien à voir, rien à connaître
    const org = (await admin.query("SELECT o.id FROM organisation o JOIN invitation i ON i.org_id = o.id WHERE i.annuaire_id = $1", [fiche])).rows;
    assert.equal(org.length, 1);
    assert.equal((await admin.query('SELECT count(*)::int AS n FROM appartenance WHERE org_id = $1', [org[0].id])).rows[0].n, 0);
  });

  it('2. une nouvelle invitation révoque la précédente et réutilise la même organisation', async () => {
    const ancien = dernierJeton();
    const orgAvant = (await admin.query('SELECT DISTINCT org_id FROM invitation WHERE annuaire_id = $1', [fiche])).rows;
    assert.equal((await inviter(tok.fm!, fiche, 'autre@prestataire.test')).status, 200);
    const orgApres = (await admin.query('SELECT DISTINCT org_id FROM invitation WHERE annuaire_id = $1', [fiche])).rows;
    assert.deepEqual(orgApres, orgAvant);
    const vieux = await t.call('POST', `/invitations/${ancien}/accept`, { body: { password: TEST_PASSWORD, nom: 'Vieux' } });
    assert.equal(vieux.status, 400);
    assert.equal(vieux.json.error, 'invalid_invitation');
  });

  it('3. refus : autre PM (404), rôle sans config.manage (403), bailleur (403), adresse invalide (400)', async () => {
    assert.equal((await inviter(tok.adminPm2!)).status, 404, 'la fiche d\'un autre PM n\'existe pas pour lui');
    assert.equal((await inviter(tok.accueil!)).status, 403);
    assert.equal((await inviter(tok.adminB1!)).status, 403);
    assert.equal((await inviter(tok.fm!, fiche, 'pas-un-courriel')).status, 400);
    assert.equal((await t.call('POST', `/annuaire/${fiche}/invitation`, { body: { email: 'a@b.test' } })).status, 401);
  });

  it('4. l\'acceptation crée l\'organisation prestataire et rattache la fiche ; le ticket devient affectable', async () => {
    const jeton = dernierJeton();
    const acc = await t.call('POST', `/invitations/${jeton}/accept`, { body: { password: TEST_PASSWORD, nom: 'Plombier Invité' } });
    assert.equal(acc.status, 200);
    assert.ok(acc.json.access_token);
    const f = (await admin.query(
      `SELECT a.prestataire_org_id, o.type, o.nom, ap.role FROM prestataire_annuaire a
         JOIN organisation o ON o.id = a.prestataire_org_id
         JOIN appartenance ap ON ap.org_id = o.id WHERE a.id = $1`, [fiche])).rows[0];
    assert.equal(f.type, 'prestataire');
    assert.equal(f.nom, 'Plomb Invité');
    assert.equal(f.role, 'admin_org');
    const rejeu = await t.call('POST', `/invitations/${jeton}/accept`, { body: { password: TEST_PASSWORD, nom: 'Rejeu' } });
    assert.equal(rejeu.status, 400, 'jeton à usage unique');
    const aff = await t.call('POST', `/tickets/${ticket}/affectation`, { token: tok.fm, body: { annuaire_id: fiche } });
    assert.equal(aff.status, 200);
    const acces = (await admin.query("SELECT count(*)::int AS n FROM acces_objet WHERE objet_id = $1 AND org_id = $2 AND revoque_at IS NULL", [ticket, f.prestataire_org_id])).rows[0].n;
    assert.equal(acces, 1, 'le compte créé par invitation reçoit l\'accès au ticket affecté');
    const encore = await inviter(tok.fm!);
    assert.equal(encore.status, 409, 'déjà rattaché');
  });

  it('5. aucun rattachement par identifiant : ignoré par l\'API, refusé par la base', async () => {
    const repo = new ApiRepository({ baseUrl: t.base, getToken: () => tok.fm! });
    const autre = (await repo.createPrestataire({ nom: 'Autre fiche', prestataire_org_id: ID.P1 } as never)).id;
    assert.equal((await repo.getPrestataire(autre)).prestataire_org_id, null);
    const patch = await t.call('PATCH', `/annuaire/${autre}`, { token: tok.fm, body: { prestataire_org_id: ID.P1 } });
    assert.equal(patch.json.prestataire_org_id, null);
  });

  it('6. le bailleur a une vision : il lit tickets et annuaire, n\'écrit rien dans le dispatch', async () => {
    const lit = await t.call('GET', '/tickets', { token: tok.adminB1 });
    assert.equal(lit.status, 200);
    assert.ok(lit.json.items.some((x: { id: string }) => x.id === ticket), 'le bailleur voit les tickets de ses sites');
    for (const [m, path, body] of [
      ['POST', '/tickets', { titre: 'x', famille_id: famille, site_id: ID.siteB1a }],
      ['POST', `/tickets/${ticket}/affectation`, { annuaire_id: fiche }],
      ['POST', '/familles', { libelle: 'Interdite' }],
      ['POST', '/annuaire', { nom: 'Interdit' }],
    ] as const) {
      const r = await t.call(m, path, { token: tok.adminB1, body });
      assert.equal(r.status, 403, `${m} ${path}`);
    }
  });

  it('7. l\'administrateur voit tout son compte : membres et invitations, rien d\'une autre organisation', async () => {
    const m = await t.call('GET', '/organisation/membres', { token: tok.adminPm1 });
    assert.equal(m.status, 200);
    const emails = m.json.membres.map((x: { email: string }) => x.email).sort();
    assert.deepEqual(emails, ['accueil.pm1@test.invalid', 'admin.pm1@test.invalid', 'fm.pm1@test.invalid', 'pm1@test.invalid']);
    assert.ok(m.json.membres.every((x: { mfa_active: boolean | undefined }) => typeof x.mfa_active === 'boolean'));
    assert.ok(!JSON.stringify(m.json).includes('hash') && !JSON.stringify(m.json).includes('secret'));
    const m2 = await t.call('GET', '/organisation/membres', { token: tok.adminPm2 });
    assert.deepEqual(m2.json.membres.map((x: { email: string }) => x.email), ['admin.pm2@test.invalid']);
    for (const who of ['fm', 'accueil']) {
      assert.equal((await t.call('GET', '/organisation/membres', { token: tok[who] })).status, 403, who);
      assert.equal((await t.call('GET', '/organisation/invitations', { token: tok[who] })).status, 403, who);
    }
  });

  it('8. invitations d\'un compte : l\'administrateur les liste et les révoque, jamais celles d\'un autre compte', async () => {
    const inv = await t.call('POST', '/invitations', { token: tok.adminPm1, body: { email: 'nouveau@pm1.test', role: 'accueil' } });
    assert.equal(inv.status, 201);
    const l = await t.call('GET', '/organisation/invitations', { token: tok.adminPm1 });
    const mienne = l.json.invitations.find((x: { id: string }) => x.id === inv.json.id);
    assert.equal(mienne.statut, 'en_attente');
    assert.ok(!l.json.invitations.some((x: { email: string }) => x.email.endsWith('@prestataire.test')), 'les invitations de prestataires appartiennent au compte prestataire');
    assert.equal((await t.call('POST', `/invitations/${inv.json.id}/revoke`, { token: tok.adminPm2 })).status, 404);
    assert.equal((await t.call('POST', `/invitations/${inv.json.id}/revoke`, { token: tok.adminPm1 })).status, 204);
    const apres = await t.call('GET', '/organisation/invitations', { token: tok.adminPm1 });
    assert.equal(apres.json.invitations.find((x: { id: string }) => x.id === inv.json.id).statut, 'revoquee');
    assert.equal((await t.call('POST', `/invitations/${inv.json.id}/revoke`, { token: tok.adminPm1 })).status, 404, 'déjà traitée');
  });
});

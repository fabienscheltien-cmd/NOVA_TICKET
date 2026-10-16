import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import type { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import type pg from 'pg';
import { AppModule } from '../src/app.module.js';
import { configureApp } from '../src/app.setup.js';
import { MAILER, MemoryMailer } from '../src/auth/mailer.js';
import { totp } from '../src/auth/totp.js';
import { ID, TEST_PASSWORD, adminClient, createUser, seed } from './helpers.js';

const SECRET = 'JBSWY3DPEHPK3PXP';

describe('patrimoine — parcours HTTP (création, import CSV, QR, mandats)', () => {
  let admin: pg.Client;
  let app: INestApplication;
  let base: string;
  const tokens: Record<string, string> = {};

  const call = async (method: string, path: string, opts: { body?: unknown; csv?: string; token?: string } = {}) => {
    const headers: Record<string, string> = {};
    if (opts.token) headers.authorization = `Bearer ${opts.token}`;
    let body: string | undefined;
    if (opts.csv !== undefined) { headers['content-type'] = 'text/csv'; body = opts.csv; }
    else if (opts.body !== undefined) { headers['content-type'] = 'application/json'; body = JSON.stringify(opts.body); }
    const res = await fetch(base + path, { method, headers, body });
    const ct = res.headers.get('content-type') ?? '';
    if (ct.includes('image/png')) return { status: res.status, json: null, png: Buffer.from(await res.arrayBuffer()) };
    const text = await res.text();
    return { status: res.status, json: text ? JSON.parse(text) : null, png: null };
  };

  const login = async (email: string, org: string): Promise<string> => {
    const l = await call('POST', '/auth/login', { body: { email, password: TEST_PASSWORD } });
    const t = l.json.status === 'mfa_required'
      ? (await call('POST', '/auth/mfa/verify', { body: { mfa_token: l.json.mfa_token, code: totp(SECRET, Date.now()) } })).json.access_token
      : l.json.access_token;
    const sw = await call('POST', '/me/workspace/switch', { token: t, body: { org_id: org } });
    assert.equal(sw.status, 200, `${email} → ${JSON.stringify(sw.json)}`);
    return sw.json.access_token;
  };

  before(async () => {
    admin = await adminClient();
    await seed(admin);
    const mod = await Test.createTestingModule({ imports: [AppModule] }).overrideProvider(MAILER).useValue(new MemoryMailer()).compile();
    app = mod.createNestApplication();
    configureApp(app);
    await app.listen(0, '127.0.0.1');
    base = (await app.getUrl()).replace('[::1]', '127.0.0.1');
    await createUser(admin, { email: 'admin.b1@test.invalid', memberships: [[ID.B1, 'admin_org']], mfaSecret: SECRET });
    await createUser(admin, { email: 'admin.b2@test.invalid', memberships: [[ID.B2, 'admin_org']], mfaSecret: SECRET });
    await createUser(admin, { email: 'fm.pm1@test.invalid', memberships: [[ID.PM1, 'gestionnaire_fm']], mfaSecret: SECRET });
    await createUser(admin, { email: 'fm.pm3@test.invalid', memberships: [[ID.PM3, 'gestionnaire_fm']], mfaSecret: SECRET });
    await createUser(admin, { email: 'tech.p1@test.invalid', memberships: [[ID.P1, 'technicien']] });
    tokens.b1 = await login('admin.b1@test.invalid', ID.B1);
    tokens.b2 = await login('admin.b2@test.invalid', ID.B2);
    tokens.pm1 = await login('fm.pm1@test.invalid', ID.PM1);
    tokens.pm3 = await login('fm.pm3@test.invalid', ID.PM3);
    tokens.tech = await login('tech.p1@test.invalid', ID.P1);
  });
  after(async () => { await app.close(); await admin.end(); });

  let siteId = ''; let batimentId = ''; let niveauId = ''; let localId = ''; let qrCode = '';

  it('un bailleur construit sa hiérarchie site → bâtiment → niveau → local avec un QR unique', async () => {
    const s = await call('POST', '/sites', { token: tokens.b1, body: { nom: 'Tour Horizon', reference: 'TH', ville: 'Lyon', latitude: 45.76, longitude: 4.83, surface_m2: 12000 } });
    assert.equal(s.status, 201);
    siteId = s.json.id;
    assert.equal(s.json.org_id, ID.B1);
    assert.equal((await call('POST', '/batiments', { token: tokens.b1, body: { site_id: siteId, nom: 'Bâtiment A' } })).status, 201);
    const b = (await call('GET', `/batiments?site_id=${siteId}`, { token: tokens.b1 })).json.items[0];
    batimentId = b.id;
    const n = await call('POST', '/niveaux', { token: tokens.b1, body: { batiment_id: batimentId, nom: 'RDC', ordre: 0 } });
    assert.equal(n.status, 201);
    niveauId = n.json.id;
    const l = await call('POST', '/locaux', { token: tokens.b1, body: { niveau_id: niveauId, nom: 'Accueil', reference: 'A-001', type: 'partie_commune', surface_m2: 80 } });
    assert.equal(l.status, 201);
    localId = l.json.id;
    qrCode = l.json.qr_code;
    assert.match(qrCode, /^[A-Za-z0-9_-]{16}$/);
    assert.equal(l.json.site_id, siteId, 'site dérivé du niveau');
    assert.equal((await call('POST', '/locaux', { token: tokens.b1, body: { niveau_id: niveauId, nom: 'Doublon', reference: 'A-001' } })).status, 409);
  });

  it('validation : valeurs invalides refusées', async () => {
    assert.equal((await call('POST', '/sites', { token: tokens.b1, body: { nom: '' } })).status, 400);
    assert.equal((await call('POST', '/sites', { token: tokens.b1, body: { nom: 'X', latitude: 123 } })).status, 400);
    assert.equal((await call('POST', '/locaux', { token: tokens.b1, body: { niveau_id: 'pas-un-uuid', nom: 'X' } })).status, 400);
    assert.equal((await call('POST', '/locaux', { token: tokens.b1, body: { niveau_id: niveauId, nom: 'X', type: 'inconnu' } })).status, 400);
  });

  it('QR : image PNG et résolution du code, uniquement dans le périmètre visible', async () => {
    const png = await call('GET', `/locaux/${localId}/qr.png`, { token: tokens.b1 });
    assert.equal(png.status, 200);
    assert.deepEqual([...png.png!.subarray(0, 4)], [0x89, 0x50, 0x4e, 0x47]);
    const r = await call('GET', `/qr/${qrCode}`, { token: tokens.b1 });
    assert.equal(r.status, 200);
    assert.deepEqual([r.json.nom, r.json.site, r.json.niveau, r.json.batiment], ['Accueil', 'Tour Horizon', 'RDC', 'Bâtiment A']);
    assert.equal((await call('GET', `/qr/${qrCode}`, { token: tokens.pm1 })).status, 200, 'PM1 a un mandat sur B1');
    for (const t of ['b2', 'pm3', 'tech']) assert.equal((await call('GET', `/qr/${qrCode}`, { token: tokens[t] })).status, 404, t);
    assert.equal((await call('GET', `/locaux/${localId}/qr.png`, { token: tokens.b2 })).status, 404);
  });

  it('permissions : un technicien lit le patrimoine visible mais ne peut rien écrire', async () => {
    assert.equal((await call('POST', '/sites', { token: tokens.tech, body: { nom: 'Interdit' } })).status, 403);
    assert.equal((await call('POST', '/mandats', { token: tokens.tech, body: { pm_org_id: ID.PM1 } })).status, 403);
    assert.equal((await call('GET', '/sites', { token: tokens.tech })).json.items.length, 0, 'aucun site visible sans contrat (incrément 3)');
    assert.equal((await call('GET', '/sites')).status, 401);
  });

  it('mandat : le PM n\'accède au patrimoine du bailleur qu\'à partir du mandat, et le perd à sa clôture', async () => {
    assert.equal((await call('GET', `/sites/${siteId}`, { token: tokens.pm3 })).status, 404);
    assert.ok([400, 403].includes((await call('POST', '/mandats', { token: tokens.pm3, body: { pm_org_id: ID.PM3 } })).status), 'le PM ne crée pas son propre mandat');
    assert.equal((await call('POST', '/mandats', { token: tokens.b1, body: { pm_org_id: ID.P1 } })).status, 400, 'un prestataire ne peut pas être mandataire');
    const m = await call('POST', '/mandats', { token: tokens.b1, body: { pm_org_id: ID.PM3 } });
    assert.equal(m.status, 201);
    assert.equal((await call('GET', `/sites/${siteId}`, { token: tokens.pm3 })).status, 200);
    const names = (await call('GET', '/sites', { token: tokens.pm3 })).json.items.map((x: { nom: string }) => x.nom).sort();
    assert.deepEqual(names, ['Site B1 A', 'Site B1 B', 'Tour Horizon'], 'seuls les sites de B1 : ceux de B2 restent invisibles');
    const pmSite = await call('POST', '/sites', { token: tokens.pm3, body: { nom: 'Site créé par le PM', owner_org_id: ID.B1 } });
    assert.equal(pmSite.status, 201);
    assert.equal(pmSite.json.org_id, ID.B1, 'le bailleur reste propriétaire');
    assert.equal((await call('POST', '/sites', { token: tokens.pm3, body: { nom: 'Chez B2', owner_org_id: ID.B2 } })).status, 403);
    // clôture : à partir d'hier, le PM perd l'accès (la date de début doit précéder la fin)
    await admin.query("UPDATE mandat_gestion SET debut = current_date - 5 WHERE id = $1", [m.json.id]);
    const end = await call('POST', `/mandats/${m.json.id}/end`, { token: tokens.b1, body: { fin: new Date(Date.now() - 86400000).toISOString().slice(0, 10) } });
    assert.equal(end.status, 200);
    assert.equal((await call('GET', `/sites/${siteId}`, { token: tokens.pm3 })).status, 404);
    assert.equal((await call('GET', `/sites/${siteId}`, { token: tokens.b1 })).status, 200, 'le bailleur conserve tout');
  });

  const SITES_CSV = [
    'reference;nom;adresse;code_postal;ville;latitude;longitude;surface_m2;portefeuille',
    'S1;Siège Paris;1 rue de Rivoli;75001;Paris;48,8606;2,3376;5000,5;Tertiaire',
    'S2;Entrepôt Lille;2 rue du Nord;59000;Lille;50.63;3.06;12000;Logistique',
    'S3;Agence Nantes;3 quai Fulton;44000;Nantes;;;800;Tertiaire',
  ].join('\n');

  it('import CSV des sites : simulation sans écriture, puis validation, séparateur « ; » et virgule décimale', async () => {
    const dry = await call('POST', '/imports/sites?dry_run=true', { token: tokens.b2, csv: SITES_CSV });
    assert.equal(dry.status, 200);
    assert.deepEqual([dry.json.committed, dry.json.errors.length, dry.json.created.sites, dry.json.created.portefeuilles], [false, 0, 3, 2]);
    assert.equal((await admin.query("SELECT count(*)::int AS n FROM site WHERE reference LIKE 'S_' AND org_id = $1", [ID.B2])).rows[0].n, 0, 'rien d\'écrit en simulation');
    const real = await call('POST', '/imports/sites', { token: tokens.b2, csv: SITES_CSV });
    assert.deepEqual([real.json.committed, real.json.created.sites], [true, 3]);
    const sites = (await call('GET', '/sites?q=Paris', { token: tokens.b2 })).json.items;
    assert.equal(sites.length, 1);
    assert.equal(Number(sites[0].surface_m2), 5000.5);
    assert.equal(sites[0].latitude, 48.8606);
  });

  it('import CSV : toutes les erreurs sont rapportées par ligne et rien n\'est écrit (tout ou rien)', async () => {
    const bad = [
      'reference;nom;latitude',
      'N1;Valide;45',
      'S1;Doublon d\'une référence existante;45',
      ';Sans référence;45',
      'N2;Latitude folle;999',
      'N3;Valide aussi;46',
      'N3;Doublon dans le fichier;46',
    ].join('\n');
    const r = await call('POST', '/imports/sites', { token: tokens.b2, csv: bad });
    assert.equal(r.status, 200);
    assert.equal(r.json.committed, false);
    assert.deepEqual(r.json.errors.map((e: { ligne: number }) => e.ligne), [3, 4, 5, 7]);
    assert.deepEqual(r.json.created, {});
    assert.equal((await admin.query("SELECT count(*)::int AS n FROM site WHERE reference IN ('N1','N3')")).rows[0].n, 0);
    assert.equal((await call('POST', '/imports/sites', { token: tokens.b2, csv: '' })).status, 400);
    assert.equal((await call('POST', '/imports/sites', { token: tokens.b2, body: { csv: 'x' } })).status, 400, 'corps JSON refusé');
    assert.equal((await call('POST', '/imports/inconnu', { token: tokens.b2, csv: 'a\n1' })).status, 400);
  });

  it('import CSV des locaux (bâtiments et niveaux créés au besoin) puis des occupations (plusieurs occupants par local)', async () => {
    const locaux = [
      'site_reference,batiment,niveau,reference,nom,type,surface_m2',
      'S1,Bâtiment Nord,RDC,N-001,Open space,bureau,300',
      'S1,Bâtiment Nord,R+1,N-101,Salle de réunion,bureau,40',
      'S1,Bâtiment Sud,RDC,S-001,Local technique,local_technique,15',
    ].join('\n');
    const l = await call('POST', '/imports/locaux', { token: tokens.b2, csv: locaux });
    assert.deepEqual([l.json.committed, l.json.created], [true, { batiments: 2, niveaux: 3, locaux: 3 }]);
    const unknown = await call('POST', '/imports/locaux', { token: tokens.b2, csv: 'site_reference,batiment,niveau,reference,nom\nZZ,A,RDC,X,Y' });
    assert.match(unknown.json.errors[0].message, /site « ZZ » introuvable/);
    const occ = [
      'site_reference,local_reference,occupant,type_occupant,debut,fin,contact_nom,contact_email,contact_telephone',
      'S1,N-001,Société Alpha,societe,2025-01-01,,Anne Durand,anne@alpha.invalid,0102030405',
      'S1,N-001,Société Beta,societe,2025-03-01,,,,',
      'S1,N-101,Société Alpha,societe,2025-01-01,,,,',
    ].join('\n');
    const o = await call('POST', '/imports/occupations', { token: tokens.b2, csv: occ });
    assert.deepEqual([o.json.committed, o.json.created], [true, { occupants: 2, contacts: 1, occupations: 3 }]);
    const site = (await call('GET', '/sites?q=Paris', { token: tokens.b2 })).json.items[0];
    const occupants = (await call('GET', `/sites/${site.id}/occupants`, { token: tokens.b2 })).json.items as Array<{ occupant: string; local: string }>;
    assert.deepEqual(occupants.map((x) => `${x.occupant} / ${x.local}`), ['Société Alpha / Open space', 'Société Alpha / Salle de réunion', 'Société Beta / Open space']);
    const overlap = await call('POST', '/imports/occupations', { token: tokens.b2, csv: 'site_reference,local_reference,occupant,debut\nS1,N-001,Société Alpha,2025-02-01' });
    assert.match(overlap.json.errors[0].message, /chevauche/);
    for (const t of ['b1', 'pm1', 'pm3', 'tech']) {
      const other = await call('GET', `/sites/${site.id}/occupants`, { token: tokens[t] });
      assert.deepEqual([other.status, other.json.items], [200, []], `${t} : aucun occupant d'un site qu'il ne voit pas`);
      assert.equal((await call('GET', `/sites/${site.id}`, { token: tokens[t] })).status, 404, `${t} : site invisible`);
    }
  });

  it('un PM importe pour le compte d\'un bailleur uniquement avec un mandat (owner_org_id)', async () => {
    const csv = 'reference,nom\nPM-1,Site importé par PM1';
    const r = await call('POST', `/imports/sites?owner_org_id=${ID.B1}`, { token: tokens.pm1, csv });
    assert.equal(r.json.committed, true);
    const denied = await call('POST', `/imports/sites?owner_org_id=${ID.B2}`, { token: tokens.pm1, csv: 'reference,nom\nPM-2,Interdit' });
    assert.equal(denied.json.committed, false);
    assert.match(denied.json.errors[0].message, /accès refusé/);
  });

  it('archivage : un local archivé disparaît des listes et le QR ne résout plus', async () => {
    assert.equal((await call('DELETE', `/locaux/${localId}`, { token: tokens.b1 })).status, 204);
    assert.equal((await call('GET', `/locaux/${localId}`, { token: tokens.b1 })).status, 404);
    assert.equal((await call('GET', `/qr/${qrCode}`, { token: tokens.b1 })).status, 404);
    assert.equal((await call('DELETE', `/sites/${siteId}`, { token: tokens.b2 })).status, 404, 'pas d\'archivage chez un autre bailleur');
  });
});

import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { resolveMigrationsDir } from '../src/db/cli.js';
import { type TestApp, startTestApp } from './http-helpers.js';
import path from 'node:path';

describe('en-têtes de sécurité', () => {
  let t: TestApp;
  before(async () => { t = await startTestApp(); });
  after(async () => { await t.close(); });

  it('nosniff, HSTS, pas de X-Powered-By, pas de mise en cache des réponses d\'API, politique de ressources same-site', async () => {
    const r = await fetch(`${t.base}/health`);
    assert.equal(r.headers.get('x-content-type-options'), 'nosniff');
    assert.match(r.headers.get('strict-transport-security') ?? '', /max-age=\d+/);
    assert.equal(r.headers.get('x-powered-by'), null);
    assert.equal(r.headers.get('cache-control'), 'no-store');
    assert.equal(r.headers.get('cross-origin-resource-policy'), 'same-site');
    assert.match(r.headers.get('content-security-policy') ?? '', /default-src 'self'/);
  });

  it('les erreurs d\'authentification gardent les mêmes en-têtes', async () => {
    const r = await fetch(`${t.base}/tickets`);
    assert.equal(r.status, 401);
    assert.equal(r.headers.get('x-content-type-options'), 'nosniff');
  });
});

describe('dossier des migrations (TypeScript et JavaScript compilé)', () => {
  it('trouve db/migrations depuis src/db et depuis dist/src/db, ou depuis MIGRATIONS_DIR', () => {
    const racine = path.resolve(import.meta.dirname, '../../..');
    assert.equal(resolveMigrationsDir({}, path.join(racine, 'apps/api/src/db')), path.join(racine, 'db/migrations'));
    assert.equal(resolveMigrationsDir({ MIGRATIONS_DIR: '/x/migrations' }, '/nulle/part'), '/x/migrations');
    assert.throws(() => resolveMigrationsDir({}, '/nulle/part/ici/la/bas/encore'), /introuvable/);
  });
});

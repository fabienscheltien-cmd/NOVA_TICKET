import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { type TestApp, startTestApp } from './http-helpers.js';

describe('CORS : seules les origines configurées appellent l\'API depuis un navigateur', () => {
  let t: TestApp;
  before(async () => { process.env.CORS_ORIGINS = 'https://console.exemple.test'; t = await startTestApp(); });
  after(async () => { await t.close(); delete process.env.CORS_ORIGINS; });

  const preflight = (origin: string) => fetch(`${t.base}/auth/login`, {
    method: 'OPTIONS', headers: { origin, 'access-control-request-method': 'POST', 'access-control-request-headers': 'authorization,content-type' },
  });

  it('origine autorisée : en-têtes présents, pas de credentials, pas de joker', async () => {
    const r = await preflight('https://console.exemple.test');
    assert.equal(r.headers.get('access-control-allow-origin'), 'https://console.exemple.test');
    assert.match(r.headers.get('access-control-allow-headers') ?? '', /authorization/i);
    assert.equal(r.headers.get('access-control-allow-credentials'), null);
  });

  it('autre origine : aucun en-tête d\'autorisation', async () => {
    const r = await preflight('https://pirate.exemple.test');
    assert.equal(r.headers.get('access-control-allow-origin'), null);
  });
});

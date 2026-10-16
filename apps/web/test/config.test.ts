import { creerSource } from '../src/config';

describe('source de données', () => {
  it('démonstration par défaut', () => {
    expect(creerSource({}).mode).toBe('demo');
    expect(creerSource({ VITE_DATA_SOURCE: 'demo' }).repo.mode).toBe('demo');
  });
  it('mode API sur demande, avec le jeton lu dans le stockage local', async () => {
    localStorage.setItem('nova.session', JSON.stringify({ access: 'jeton-test', refresh: 'r', exp: Date.now() + 600_000, orgId: 'o', orgNom: 'Org', role: 'admin_org' }));
    let entete = '';
    const original = globalThis.fetch;
    globalThis.fetch = (async (_u: string, init: RequestInit) => { entete = String((init.headers as Record<string, string>).authorization); return new Response('{"items":[]}'); }) as typeof fetch;
    try {
      const s = creerSource({ VITE_DATA_SOURCE: 'api', VITE_API_URL: 'http://api.test' });
      expect(s.mode).toBe('api');
      expect(await s.repo.listFamilles()).toEqual([]);
      expect(entete).toBe('Bearer jeton-test');
    } finally { globalThis.fetch = original; localStorage.clear(); }
  });
});

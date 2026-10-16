import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import axe from 'axe-core';
import { MemoryRouter } from 'react-router-dom';
import { DemoRepository } from '@nova/shared';
import { App } from '../src/App';
import { AuthClient, ErreurAuth, SESSION_KEY } from '../src/auth';
import { AppContext } from '../src/context';

interface Appel { method: string; path: string; body: unknown; token: string }

/** Faux serveur : rejoue des réponses par route, enregistre les appels. */
function faux(routes: Record<string, (appel: Appel) => { status?: number; json?: unknown; headers?: Record<string, string> }>) {
  const appels: Appel[] = [];
  const fetchImpl = (async (url: string, init: RequestInit) => {
    const path = new URL(url).pathname;
    const method = init.method ?? 'GET';
    const appel: Appel = { method, path, body: init.body ? JSON.parse(String(init.body)) : undefined, token: String((init.headers as Record<string, string>)?.authorization ?? '').replace('Bearer ', '') };
    appels.push(appel);
    const h = routes[`${method} ${path}`];
    if (!h) return new Response('{"error":"not_found"}', { status: 404 });
    const r = h(appel);
    const corps = r.json === undefined ? '' : JSON.stringify(r.json);
    return new Response(corps || null, { status: r.status ?? 200, headers: r.headers ?? {} });
  }) as typeof fetch;
  return { appels, fetchImpl };
}

const ESPACE = { org_id: 'o1', nom: 'Gestion Lyon', type: 'property_manager', role: 'gestionnaire_fm', mfa_obligatoire: false };
const OK = { status: 'ok', access_token: 'acces-utilisateur', refresh_token: 'refresh-1', expires_in: 900 };

function monter(auth: AuthClient, route = '/') {
  const user = userEvent.setup();
  const repo = new DemoRepository({ today: () => '2026-10-16' });
  // Le mode « api » n'est pas nécessaire ici : l'App se fie à la présence d'un client d'authentification.
  const utils = render(
    <AppContext.Provider value={{ repo, auth, today: () => '2026-10-16' }}>
      <MemoryRouter initialEntries={[route]}><App /></MemoryRouter>
    </AppContext.Provider>,
  );
  return { user, ...utils };
}
const stockage = () => { localStorage.clear(); return localStorage; };

describe('connexion à la console', () => {
  beforeEach(() => { stockage(); });

  it('identifiants puis espace unique : entre dans la console et conserve la session', async () => {
    const f = faux({
      'POST /auth/login': () => ({ json: OK }),
      'GET /me/workspaces': (a) => (a.token === 'acces-utilisateur' ? { json: { workspaces: [ESPACE] } } : { status: 401 }),
      'POST /me/workspace/switch': () => ({ json: { access_token: 'acces-espace', expires_in: 900, role: 'gestionnaire_fm' } }),
    });
    const auth = new AuthClient('http://api.test', { fetchImpl: f.fetchImpl });
    const { user } = monter(auth);
    await user.type(await screen.findByLabelText(/Adresse e-mail/), 'fm@exemple.invalid');
    await user.type(screen.getByLabelText(/Mot de passe/), 'un mot de passe assez long');
    await user.click(screen.getByRole('button', { name: 'Se connecter' }));
    expect(await screen.findByRole('navigation', { name: 'Navigation principale' })).toBeInTheDocument();
    expect(screen.getByText('Gestion Lyon')).toBeInTheDocument();
    expect(JSON.parse(localStorage.getItem(SESSION_KEY)!)).toMatchObject({ access: 'acces-espace', refresh: 'refresh-1', orgId: 'o1' });
    expect(f.appels.find((a) => a.path === '/me/workspace/switch')!.body).toEqual({ org_id: 'o1' });
  });

  it('identifiants refusés : message uniforme, mot de passe vidé, pas de session', async () => {
    const f = faux({ 'POST /auth/login': () => ({ status: 401, json: { error: 'invalid_credentials' } }) });
    const auth = new AuthClient('http://api.test', { fetchImpl: f.fetchImpl });
    const { user } = monter(auth);
    await user.type(await screen.findByLabelText(/Adresse e-mail/), 'x@exemple.invalid');
    await user.type(screen.getByLabelText(/Mot de passe/), 'mauvais mot de passe');
    await user.click(screen.getByRole('button', { name: 'Se connecter' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('Adresse e-mail ou mot de passe incorrect.');
    expect(localStorage.getItem(SESSION_KEY)).toBeNull();
  });

  it('limite de débit : message dédié', async () => {
    const f = faux({ 'POST /auth/login': () => ({ status: 429, json: { error: 'too_many_requests' }, headers: { 'retry-after': '30' } }) });
    const { user } = monter(new AuthClient('http://api.test', { fetchImpl: f.fetchImpl }));
    await user.type(await screen.findByLabelText(/Adresse e-mail/), 'x@exemple.invalid');
    await user.type(screen.getByLabelText(/Mot de passe/), 'mot de passe');
    await user.click(screen.getByRole('button', { name: 'Se connecter' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('Trop de tentatives');
  });

  it('MFA puis choix entre plusieurs espaces', async () => {
    const autre = { ...ESPACE, org_id: 'o2', nom: 'Bailleur Rhône', type: 'bailleur', role: 'asset_manager' };
    const f = faux({
      'POST /auth/login': () => ({ json: { status: 'mfa_required', mfa_token: 'mfa-1' } }),
      'POST /auth/mfa/verify': (a) => ((a.body as { code: string }).code === '123456' ? { json: OK } : { status: 401, json: { error: 'invalid_credentials' } }),
      'GET /me/workspaces': () => ({ json: { workspaces: [ESPACE, autre] } }),
      'POST /me/workspace/switch': () => ({ json: { access_token: 'acces-espace', expires_in: 900, role: 'asset_manager' } }),
    });
    const { user } = monter(new AuthClient('http://api.test', { fetchImpl: f.fetchImpl }));
    await user.type(await screen.findByLabelText(/Adresse e-mail/), 'multi@exemple.invalid');
    await user.type(screen.getByLabelText(/Mot de passe/), 'un mot de passe assez long');
    await user.click(screen.getByRole('button', { name: 'Se connecter' }));
    await user.type(await screen.findByLabelText(/Code à 6 chiffres/), '000000');
    await user.click(screen.getByRole('button', { name: 'Valider' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('Code incorrect');
    await user.clear(screen.getByLabelText(/Code à 6 chiffres/));
    await user.type(screen.getByLabelText(/Code à 6 chiffres/), '123456');
    await user.click(screen.getByRole('button', { name: 'Valider' }));
    await user.click(await screen.findByRole('button', { name: /Bailleur Rhône/ }));
    expect(await screen.findByRole('navigation', { name: 'Navigation principale' })).toBeInTheDocument();
    expect(JSON.parse(localStorage.getItem(SESSION_KEY)!).orgId).toBe('o2');
  });

  it('MFA obligatoire non activée : propose l\'activation, affiche les codes de secours, puis entre', async () => {
    const admin = { ...ESPACE, role: 'admin_org', mfa_obligatoire: true };
    let active = false;
    const f = faux({
      'POST /auth/login': () => ({ json: OK }),
      'GET /me/workspaces': () => ({ json: { workspaces: [admin] } }),
      'POST /me/workspace/switch': () => (active ? { json: { access_token: 'acces-espace', expires_in: 900, role: 'admin_org' } } : { status: 403, json: { error: 'mfa_enrollment_required' } }),
      'POST /me/mfa/setup': () => ({ json: { secret: 'JBSWY3DPEHPK3PXP', otpauth_uri: 'otpauth://totp/NOVA:x?secret=JBSWY3DPEHPK3PXP' } }),
      'POST /me/mfa/confirm': () => { active = true; return { json: { backup_codes: ['aaaaa-bbbbb', 'ccccc-ddddd'] } }; },
    });
    const { user } = monter(new AuthClient('http://api.test', { fetchImpl: f.fetchImpl }));
    await user.type(await screen.findByLabelText(/Adresse e-mail/), 'admin@exemple.invalid');
    await user.type(screen.getByLabelText(/Mot de passe/), 'un mot de passe assez long');
    await user.click(screen.getByRole('button', { name: 'Se connecter' }));
    expect(await screen.findByText('JBSWY3DPEHPK3PXP')).toBeInTheDocument();
    await user.type(screen.getByLabelText(/Code à 6 chiffres/), '654321');
    await user.click(screen.getByRole('button', { name: 'Activer' }));
    expect(await screen.findByText('aaaaa-bbbbb')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: /J'ai conservé mes codes/ }));
    expect(await screen.findByRole('navigation', { name: 'Navigation principale' })).toBeInTheDocument();
  });

  it('déconnexion : session effacée, retour à l\'écran de connexion, jeton révoqué côté serveur', async () => {
    localStorage.setItem(SESSION_KEY, JSON.stringify({ access: 'a', refresh: 'r-1', exp: Date.now() + 600_000, orgId: 'o1', orgNom: 'Gestion Lyon', role: 'admin_org' }));
    const f = faux({ 'POST /auth/logout': () => ({ status: 204 }) });
    const { user } = monter(new AuthClient('http://api.test', { fetchImpl: f.fetchImpl }), '/annuaire');
    await user.click(await screen.findByRole('button', { name: 'Se déconnecter' }));
    expect(await screen.findByRole('heading', { name: 'Connexion à NOVA' })).toBeInTheDocument();
    expect(localStorage.getItem(SESSION_KEY)).toBeNull();
    await waitFor(() => expect(f.appels.find((a) => a.path === '/auth/logout')!.body).toEqual({ refresh_token: 'r-1' }));
  });
});

describe('jeton d\'accès', () => {
  beforeEach(() => { stockage(); });
  const sessionExpiree = () => localStorage.setItem(SESSION_KEY, JSON.stringify({ access: 'vieux', refresh: 'r-1', exp: Date.now() - 1000, orgId: 'o1', orgNom: 'O', role: 'admin_org' }));

  it('rafraîchit un jeton expiré, une seule rotation même si plusieurs requêtes partent ensemble', async () => {
    sessionExpiree();
    let rotations = 0;
    const f = faux({ 'POST /auth/refresh': () => { rotations++; return { json: { access_token: 'neuf', refresh_token: 'r-2', expires_in: 900 } }; } });
    const auth = new AuthClient('http://api.test', { fetchImpl: f.fetchImpl });
    const jetons = await Promise.all([auth.getToken(), auth.getToken(), auth.getToken()]);
    expect(jetons).toEqual(['neuf', 'neuf', 'neuf']);
    expect(rotations).toBe(1);
    expect(f.appels[0]!.body).toEqual({ refresh_token: 'r-1', org_id: 'o1' });
    expect(auth.session()!.refresh).toBe('r-2');
  });

  it('refus du rafraîchissement : session effacée (retour à la connexion) ; une erreur réseau la conserve', async () => {
    sessionExpiree();
    const refuse = new AuthClient('http://api.test', { fetchImpl: faux({ 'POST /auth/refresh': () => ({ status: 401, json: { error: 'invalid_refresh_token' } }) }).fetchImpl });
    await expect(refuse.getToken()).rejects.toBeInstanceOf(ErreurAuth);
    expect(refuse.session()).toBeNull();
    sessionExpiree();
    const reseau = new AuthClient('http://api.test', { fetchImpl: (async () => { throw new Error('hors ligne'); }) as typeof fetch });
    await expect(reseau.getToken()).rejects.toMatchObject({ code: 'network' });
    expect(reseau.session()).not.toBeNull();
  });
});

describe('comptes : mot de passe oublié, réinitialisation, invitation', () => {
  beforeEach(() => { stockage(); });

  it('mot de passe oublié : confirmation identique quelle que soit l\'adresse', async () => {
    const f = faux({ 'POST /auth/password/forgot': () => ({ status: 202, json: { message: 'ok' } }) });
    const { user } = monter(new AuthClient('http://api.test', { fetchImpl: f.fetchImpl }), '/mot-de-passe-oublie');
    await user.type(await screen.findByLabelText(/Adresse e-mail/), 'inconnu@exemple.invalid');
    await user.click(screen.getByRole('button', { name: 'Envoyer le lien' }));
    expect(await screen.findByRole('status')).toHaveTextContent('Si cette adresse correspond à un compte');
    expect(f.appels[0]!.body).toEqual({ email: 'inconnu@exemple.invalid' });
  });

  it('réinitialisation : longueur contrôlée côté console, puis succès ; lien expiré proposé à refaire', async () => {
    let calls = 0;
    const f = faux({ 'POST /auth/password/reset': () => (++calls === 1 ? { status: 400, json: { error: 'invalid_reset_link' } } : { status: 204 }) });
    const { user } = monter(new AuthClient('http://api.test', { fetchImpl: f.fetchImpl }), '/mot-de-passe/jeton-abcdefghij');
    await user.type(await screen.findByLabelText(/Nouveau mot de passe/), 'court');
    await user.click(screen.getByRole('button', { name: 'Enregistrer' }));
    expect(await screen.findByText('Au moins 12 caractères.', { selector: '.error' })).toBeInTheDocument();
    expect(f.appels).toHaveLength(0);
    await user.clear(screen.getByLabelText(/Nouveau mot de passe/));
    await user.type(screen.getByLabelText(/Nouveau mot de passe/), 'un mot de passe suffisant');
    await user.click(screen.getByRole('button', { name: 'Enregistrer' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('Ce lien est invalide ou expiré');
    expect(screen.getByRole('link', { name: 'Refaire une demande' })).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Enregistrer' }));
    expect(await screen.findByRole('heading', { name: 'Mot de passe modifié' })).toBeInTheDocument();
    expect(f.appels[1]!.body).toEqual({ token: 'jeton-abcdefghij', password: 'un mot de passe suffisant' });
  });

  it('invitation : crée le compte ; si le compte existe, renvoie vers la connexion', async () => {
    let calls = 0;
    const f = faux({ 'POST /invitations/jeton-inv/accept': () => (++calls === 1 ? { status: 409, json: { error: 'account_exists' } } : { json: OK }) });
    const { user } = monter(new AuthClient('http://api.test', { fetchImpl: f.fetchImpl }), '/invitations/jeton-inv');
    await user.click(await screen.findByRole('button', { name: 'Créer mon compte' }));
    expect(await screen.findByText('Le nom est obligatoire.')).toBeInTheDocument();
    await user.type(screen.getByLabelText(/Nom complet/), 'Camille Martin');
    await user.type(screen.getByLabelText(/Nouveau mot de passe/), 'un mot de passe suffisant');
    await user.click(screen.getByRole('button', { name: 'Créer mon compte' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('Un compte existe déjà');
    expect(screen.getByRole('link', { name: 'Se connecter' })).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Créer mon compte' }));
    expect(await screen.findByRole('heading', { name: 'Connexion à NOVA' })).toBeInTheDocument();
    expect(f.appels[1]!.body).toEqual({ nom: 'Camille Martin', password: 'un mot de passe suffisant' });
  });
});

describe('accessibilité des écrans de connexion (axe-core, jsdom)', () => {
  beforeEach(() => { stockage(); });
  it.each([['/', 'Connexion à NOVA'], ['/mot-de-passe-oublie', 'Mot de passe oublié'], ['/mot-de-passe/jeton-abcdefghij', 'Nouveau mot de passe'], ['/invitations/x', 'Créer votre compte NOVA']])(
    '%s : aucune violation', async (route, titre) => {
      const { container } = monter(new AuthClient('http://api.test', { fetchImpl: faux({}).fetchImpl }), route);
      await screen.findByRole('heading', { name: titre });
      const r = await axe.run(container, { rules: { 'color-contrast': { enabled: false }, region: { enabled: false } } });
      expect(r.violations.map((v) => `${v.id}: ${v.nodes.map((n) => n.html).join(' | ')}`)).toEqual([]);
    });
});

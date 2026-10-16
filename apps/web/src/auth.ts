/**
 * Client d'authentification de la console (mode API). Les jetons vivent dans le stockage local de ce navigateur :
 * jeton d'accès rattaché à l'espace de travail, jeton de rafraîchissement (rotation à chaque usage).
 * Les rafraîchissements sont sérialisés : deux rotations simultanées feraient détecter une réutilisation
 * et révoqueraient toute la session côté serveur.
 */
export const SESSION_KEY = 'nova.session';

export interface Session { access: string; refresh: string; exp: number; orgId: string; orgNom: string; role: string }
export interface Espace { org_id: string; nom: string; type: string; role: string; mfa_obligatoire: boolean }
export type ResultatConnexion = { status: 'ok' } | { status: 'mfa_required'; mfaToken: string };

export class ErreurAuth extends Error {
  constructor(readonly code: string, message: string, readonly status: number, readonly retryAfter?: number) {
    super(message);
    this.name = 'ErreurAuth';
  }
}

const MESSAGES: Record<string, string> = {
  invalid_credentials: 'Adresse e-mail ou mot de passe incorrect.',
  too_many_requests: 'Trop de tentatives. Patientez un instant avant de réessayer.',
  invalid_code: 'Code incorrect.',
  invalid_invitation: 'Cette invitation est invalide ou expirée.',
  invalid_reset_link: 'Ce lien est invalide ou expiré. Refaites une demande.',
  account_exists: 'Un compte existe déjà pour cette adresse : connectez-vous, puis rouvrez le lien de l\'invitation.',
  weak_password: 'Mot de passe trop court.',
  mfa_enrollment_required: 'La double authentification est obligatoire pour ce rôle : activez-la pour continuer.',
  not_a_member: 'Vous n\'avez plus accès à cet espace.',
  invalid_refresh_token: 'Votre session a expiré. Reconnectez-vous.',
};

export interface AuthOptions {
  fetchImpl?: typeof fetch;
  storage?: Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>;
  now?: () => number;
}

export class AuthClient {
  private readonly fetchImpl: typeof fetch;
  private readonly storage: NonNullable<AuthOptions['storage']>;
  private readonly now: () => number;
  private readonly listeners = new Set<() => void>();
  private enCours: Promise<Session> | null = null;
  /** Jetons de niveau utilisateur, entre la connexion et le choix de l'espace (jamais persistés). */
  private attente: { access: string; refresh: string } | null = null;

  constructor(private readonly baseUrl: string, opts: AuthOptions = {}) {
    this.fetchImpl = opts.fetchImpl ?? ((...a) => fetch(...a));
    this.storage = opts.storage ?? localStorage;
    this.now = opts.now ?? Date.now;
  }

  // --- état -------------------------------------------------------------------------------------
  session(): Session | null {
    try {
      const brut = this.storage.getItem(SESSION_KEY);
      return brut ? (JSON.parse(brut) as Session) : null;
    } catch { return null; }
  }
  private ecrire(s: Session | null): void {
    try { if (s) this.storage.setItem(SESSION_KEY, JSON.stringify(s)); else this.storage.removeItem(SESSION_KEY); } catch { /* stockage indisponible */ }
    for (const l of this.listeners) l();
  }
  subscribe(fn: () => void): () => void { this.listeners.add(fn); return () => { this.listeners.delete(fn); }; }

  // --- HTTP -------------------------------------------------------------------------------------
  private async appeler<T>(method: string, path: string, body?: unknown, token?: string): Promise<T> {
    let res: Response;
    try {
      res = await this.fetchImpl(this.baseUrl.replace(/\/$/, '') + path, {
        method,
        headers: { ...(token ? { authorization: `Bearer ${token}` } : {}), ...(body !== undefined ? { 'content-type': 'application/json' } : {}) },
        body: body === undefined ? undefined : JSON.stringify(body),
      });
    } catch {
      throw new ErreurAuth('network', 'Le serveur est injoignable.', 0);
    }
    const texte = await res.text();
    const json = texte ? (JSON.parse(texte) as Record<string, unknown>) : null;
    if (!res.ok) {
      const code = typeof json?.error === 'string' ? json.error : `http_${res.status}`;
      const message = MESSAGES[code] ?? (typeof json?.message === 'string' ? json.message : `Erreur ${res.status}`);
      const retry = Number(res.headers.get('retry-after'));
      throw new ErreurAuth(code, message, res.status, Number.isFinite(retry) && retry > 0 ? retry : undefined);
    }
    return json as T;
  }

  // --- connexion --------------------------------------------------------------------------------
  async connexion(email: string, password: string): Promise<ResultatConnexion> {
    const r = await this.appeler<{ status: string; mfa_token?: string; access_token?: string; refresh_token?: string }>('POST', '/auth/login', { email, password });
    if (r.status === 'mfa_required') return { status: 'mfa_required', mfaToken: r.mfa_token! };
    this.attente = { access: r.access_token!, refresh: r.refresh_token! };
    return { status: 'ok' };
  }

  async verifierMfa(mfaToken: string, code: string): Promise<void> {
    const r = await this.appeler<{ access_token: string; refresh_token: string }>('POST', '/auth/mfa/verify', { mfa_token: mfaToken, code });
    this.attente = { access: r.access_token, refresh: r.refresh_token };
  }

  espaces(): Promise<Espace[]> {
    return this.appeler<{ workspaces: Espace[] }>('GET', '/me/workspaces', undefined, this.jetonAttente()).then((r) => r.workspaces);
  }

  /** Choisit l'espace : `switch` vérifie l'appartenance et la MFA sans consommer le jeton de rafraîchissement. */
  async entrer(espace: Espace): Promise<void> {
    const a = this.jetonAttente();
    const r = await this.appeler<{ access_token: string; expires_in: number; role: string }>('POST', '/me/workspace/switch', { org_id: espace.org_id }, a);
    this.ecrire({ access: r.access_token, refresh: this.attente!.refresh, exp: this.now() + r.expires_in * 1000, orgId: espace.org_id, orgNom: espace.nom, role: r.role });
    this.attente = null;
  }

  private jetonAttente(): string {
    if (!this.attente) throw new ErreurAuth('invalid_refresh_token', MESSAGES.invalid_refresh_token!, 401);
    return this.attente.access;
  }

  mfaPreparer(): Promise<{ secret: string; otpauth_uri: string }> {
    return this.appeler('POST', '/me/mfa/setup', undefined, this.jetonAttente());
  }
  mfaConfirmer(code: string): Promise<{ backup_codes: string[] }> {
    return this.appeler('POST', '/me/mfa/confirm', { code }, this.jetonAttente());
  }

  // --- jeton d'accès pour le Repository -----------------------------------------------------------
  async getToken(): Promise<string> {
    const s = this.session();
    if (!s) throw new ErreurAuth('unauthorized', 'Session expirée.', 401);
    if (s.exp - this.now() > 30_000) return s.access;
    this.enCours ??= this.rafraichir(s).finally(() => { this.enCours = null; });
    return (await this.enCours).access;
  }

  private async rafraichir(s: Session): Promise<Session> {
    try {
      const r = await this.appeler<{ access_token: string; refresh_token: string; expires_in: number }>('POST', '/auth/refresh', { refresh_token: s.refresh, org_id: s.orgId });
      const suivante = { ...s, access: r.access_token, refresh: r.refresh_token, exp: this.now() + r.expires_in * 1000 };
      this.ecrire(suivante);
      return suivante;
    } catch (err) {
      // Refus du serveur (jeton révoqué, appartenance retirée) : on revient à l'écran de connexion.
      if (err instanceof ErreurAuth && err.status >= 400 && err.status < 500 && err.status !== 429) this.ecrire(null);
      throw err;
    }
  }

  async deconnexion(): Promise<void> {
    const s = this.session();
    this.ecrire(null);
    this.attente = null;
    if (s) await this.appeler('POST', '/auth/logout', { refresh_token: s.refresh }).catch(() => undefined);
  }

  // --- comptes ----------------------------------------------------------------------------------
  async motDePasseOublie(email: string): Promise<void> { await this.appeler('POST', '/auth/password/forgot', { email }); }
  async reinitialiser(token: string, password: string): Promise<void> { await this.appeler('POST', '/auth/password/reset', { token, password }); }
  async accepterInvitation(token: string, nom: string, password: string): Promise<void> {
    const r = await this.appeler<{ access_token: string; refresh_token: string }>('POST', `/invitations/${encodeURIComponent(token)}/accept`, { nom, password });
    this.attente = { access: r.access_token, refresh: r.refresh_token };
  }
  async accepterInvitationCompteExistant(token: string): Promise<void> {
    const jeton = this.attente?.access ?? (await this.getToken());
    await this.appeler('POST', `/me/invitations/${encodeURIComponent(token)}/accept`, {}, jeton);
  }
  aJetonAttente(): boolean { return this.attente !== null; }
}

import type pg from 'pg';
import { randomUUID } from 'node:crypto';
import type { TenantContext, TenantDb } from '../db/tenant-db.js';
import type { AuthConfig } from './config.js';
import {
  DUMMY_HASH, MIN_PASSWORD_LENGTH, decryptSecret, encryptSecret, generateBackupCodes, hashPassword,
  normalizeBackupCode, randomToken, sha256Hex, verifyPassword,
} from './crypto.js';
import { AuthError, forbidden, invalidCredentials } from './errors.js';
import type { Mailer } from './mailer.js';
import { otpauthUri, generateTotpSecret, verifyTotp } from './totp.js';
import { signToken, verifyToken } from './tokens.js';

export interface TokenPair { access_token: string; refresh_token: string; expires_in: number }
export type LoginResult = ({ status: 'ok' } & TokenPair) | { status: 'mfa_required'; mfa_token: string };
export interface Workspace { org_id: string; nom: string; type: string; role: string; mfa_obligatoire: boolean }
export interface Membership { role: string; mfa_obligatoire: boolean; org_type: string }

const normEmail = (e: string) => e.trim().toLowerCase();

function assertPassword(password: string): void {
  if (password.length < MIN_PASSWORD_LENGTH) {
    throw new AuthError('weak_password', 400, `Le mot de passe doit comporter au moins ${MIN_PASSWORD_LENGTH} caractères`);
  }
}

export class AuthService {
  constructor(private readonly db: TenantDb, private readonly cfg: AuthConfig, private readonly mailer: Mailer) {}

  private q<T extends pg.QueryResultRow>(sql: string, params: unknown[] = []): Promise<T[]> {
    return this.db.withoutTenant(async (c) => (await c.query<T>(sql, params)).rows);
  }

  // --- Connexion ------------------------------------------------------------------------------
  async login(email: string, password: string, userAgent?: string): Promise<LoginResult> {
    const [u] = await this.q<{ user_id: string; password_hash: string; mfa_enabled: boolean; statut: string; locked_until: Date | null }>(
      'SELECT * FROM app.auth_lookup($1)', [normEmail(email)]);
    const ok = await verifyPassword(u?.password_hash ?? DUMMY_HASH, password);
    // Réponse identique (compte inconnu, désactivé, verrouillé, mauvais mot de passe) : pas d'énumération.
    if (!u || u.statut !== 'actif') throw invalidCredentials();
    if (u.locked_until && u.locked_until > new Date()) throw invalidCredentials();
    if (!ok) {
      await this.q('SELECT app.auth_register_failure($1)', [u.user_id]);
      throw invalidCredentials();
    }
    if (u.mfa_enabled) {
      return { status: 'mfa_required', mfa_token: await signToken(this.cfg, { sub: u.user_id, typ: 'mfa' }, this.cfg.mfaTokenTtlSec) };
    }
    await this.q('SELECT app.auth_register_success($1)', [u.user_id]);
    return { status: 'ok', ...(await this.issueTokens(u.user_id, userAgent)) };
  }

  async verifyMfa(mfaToken: string, code: string, userAgent?: string): Promise<TokenPair> {
    const claims = await verifyToken(this.cfg, mfaToken, 'mfa');
    if (!claims) throw invalidCredentials();
    const [u] = await this.q<{ mfa_enabled: boolean; mfa_secret_enc: string | null; statut: string; locked_until: Date | null }>(
      'SELECT * FROM app.auth_get_user($1)', [claims.sub]);
    if (!u || u.statut !== 'actif' || !u.mfa_enabled || !u.mfa_secret_enc) throw invalidCredentials();
    if (u.locked_until && u.locked_until > new Date()) throw invalidCredentials();
    const secret = decryptSecret(u.mfa_secret_enc, this.cfg.encKey);
    let valid = verifyTotp(secret, code.trim());
    if (!valid && /^[0-9a-f]{5}-[0-9a-f]{5}$/i.test(code.trim())) {
      const [r] = await this.q<{ used: boolean }>('SELECT app.mfa_use_backup($1, $2) AS used', [claims.sub, sha256Hex(normalizeBackupCode(code))]);
      valid = r?.used === true;
    }
    if (!valid) {
      await this.q('SELECT app.auth_register_failure($1)', [claims.sub]);
      throw invalidCredentials();
    }
    await this.q('SELECT app.auth_register_success($1)', [claims.sub]);
    return this.issueTokens(claims.sub, userAgent);
  }

  async issueTokens(userId: string, userAgent?: string, orgId?: string, famille: string = randomUUID(), refresh?: string): Promise<TokenPair> {
    const refresh_token = refresh ?? randomToken();
    if (!refresh) {
      await this.q('SELECT app.session_create($1, $2, $3, $4, $5)', [
        userId, sha256Hex(refresh_token), famille, new Date(Date.now() + this.cfg.refreshTtlSec * 1000), userAgent ?? null]);
    }
    const access_token = await signToken(this.cfg, { sub: userId, typ: 'access', ...(orgId ? { org: orgId } : {}) }, this.cfg.accessTtlSec);
    return { access_token, refresh_token, expires_in: this.cfg.accessTtlSec };
  }

  /** Rotation du jeton de rafraîchissement ; option : jeton d'accès directement rattaché à un espace. */
  async refresh(refreshToken: string, userAgent?: string, orgId?: string): Promise<TokenPair> {
    const next = randomToken();
    const [r] = await this.q<{ uid: string | null }>('SELECT app.session_rotate($1, $2, $3, $4) AS uid', [
      sha256Hex(refreshToken), sha256Hex(next), new Date(Date.now() + this.cfg.refreshTtlSec * 1000), userAgent ?? null]);
    if (!r?.uid) throw new AuthError('invalid_refresh_token', 401);
    let org: string | undefined;
    if (orgId) {
      await this.assertWorkspaceAllowed(r.uid, orgId);
      org = orgId;
    }
    return this.issueTokens(r.uid, userAgent, org, undefined, next);
  }

  async logout(refreshToken: string): Promise<void> {
    await this.q('SELECT app.session_revoke($1)', [sha256Hex(refreshToken)]);
  }

  // --- Espaces de travail ----------------------------------------------------------------------
  listWorkspaces(userId: string): Promise<Workspace[]> {
    return this.q<Workspace>('SELECT * FROM app.workspaces_of($1)', [userId]);
  }

  async resolveMembership(userId: string, orgId: string): Promise<Membership | null> {
    const [m] = await this.q<Membership>('SELECT * FROM app.resolve_membership($1, $2)', [userId, orgId]);
    return m ?? null;
  }

  private async assertWorkspaceAllowed(userId: string, orgId: string): Promise<Membership> {
    const m = await this.resolveMembership(userId, orgId);
    if (!m) throw forbidden('not_a_member');
    if (m.mfa_obligatoire) {
      const [u] = await this.q<{ mfa_enabled: boolean }>('SELECT * FROM app.auth_get_user($1)', [userId]);
      if (!u?.mfa_enabled) throw forbidden('mfa_enrollment_required');
    }
    return m;
  }

  async switchWorkspace(userId: string, orgId: string): Promise<{ access_token: string; expires_in: number; role: string }> {
    const m = await this.assertWorkspaceAllowed(userId, orgId);
    const access_token = await signToken(this.cfg, { sub: userId, typ: 'access', org: orgId }, this.cfg.accessTtlSec);
    return { access_token, expires_in: this.cfg.accessTtlSec, role: m.role };
  }

  // --- MFA ------------------------------------------------------------------------------------
  async mfaSetup(userId: string): Promise<{ secret: string; otpauth_uri: string }> {
    const [u] = await this.q<{ mfa_enabled: boolean; email: string }>('SELECT * FROM app.auth_get_user($1)', [userId]);
    if (!u) throw forbidden();
    if (u.mfa_enabled) throw new AuthError('mfa_already_enabled', 409);
    const secret = generateTotpSecret();
    await this.q('SELECT app.mfa_begin($1, $2)', [userId, encryptSecret(secret, this.cfg.encKey)]);
    return { secret, otpauth_uri: otpauthUri(this.cfg.issuer, u.email, secret) };
  }

  async mfaConfirm(userId: string, code: string): Promise<{ backup_codes: string[] }> {
    const [u] = await this.q<{ mfa_enabled: boolean; mfa_secret_enc: string | null }>('SELECT * FROM app.auth_get_user($1)', [userId]);
    if (!u?.mfa_secret_enc || u.mfa_enabled) throw new AuthError('mfa_not_pending', 409);
    if (!verifyTotp(decryptSecret(u.mfa_secret_enc, this.cfg.encKey), code.trim())) throw new AuthError('invalid_code', 400);
    const codes = generateBackupCodes();
    await this.q('SELECT app.mfa_confirm($1, $2::text[])', [userId, codes.map((c) => sha256Hex(normalizeBackupCode(c)))]);
    return { backup_codes: codes };
  }

  // --- Invitations ----------------------------------------------------------------------------
  async createInvitation(ctx: TenantContext, input: { email: string; role: string }): Promise<{ id: string; expires_at: Date }> {
    const email = normEmail(input.email);
    const token = randomToken();
    const expiresAt = new Date(Date.now() + this.cfg.invitationTtlSec * 1000);
    const { row, org } = await this.db.withTenant(ctx, async (c) => {
      const o = (await c.query<{ nom: string; type: string }>('SELECT nom, type FROM organisation WHERE id = $1', [ctx.orgId])).rows[0];
      const r = (await c.query<{ org_types: string[] }>('SELECT org_types FROM role WHERE code = $1', [input.role])).rows[0];
      if (!o || !r || !r.org_types.includes(o.type)) throw new AuthError('role_not_allowed', 400, 'Rôle non autorisé pour ce type d\'organisation');
      const ins = await c.query<{ id: string }>(
        `INSERT INTO invitation (org_id, email, role, token_hash, expires_at, invited_by)
         VALUES ($1, $2, $3, $4, $5, $6) RETURNING id`,
        [ctx.orgId, email, input.role, sha256Hex(token), expiresAt, ctx.userId]);
      return { row: ins.rows[0]!, org: o };
    });
    await this.mailer.sendInvitation({
      to: email, organisation: org.nom, role: input.role, expiresAt,
      link: `${this.cfg.appBaseUrl}/invitations/${token}`,
    });
    return { id: row.id, expires_at: expiresAt };
  }

  async acceptInvitationNew(token: string, input: { password: string; nom: string }, userAgent?: string): Promise<TokenPair> {
    assertPassword(input.password);
    let userId: string;
    try {
      const [r] = await this.q<{ uid: string }>('SELECT app.invitation_accept_new($1, $2, $3) AS uid', [
        sha256Hex(token), await hashPassword(input.password), input.nom.trim()]);
      userId = r!.uid;
    } catch (err) {
      const code = (err as { code?: string }).code;
      if (code === '23505') throw new AuthError('account_exists', 409, 'Un compte existe déjà pour cette adresse : connectez-vous pour accepter');
      if (code === '42501') throw new AuthError('invalid_invitation', 400, 'Invitation invalide ou expirée');
      throw err;
    }
    return this.issueTokens(userId, userAgent);
  }

  async acceptInvitationExisting(token: string, userId: string): Promise<{ org_id: string }> {
    try {
      const [r] = await this.q<{ org: string }>('SELECT app.invitation_accept_existing($1, $2) AS org', [sha256Hex(token), userId]);
      return { org_id: r!.org };
    } catch (err) {
      if ((err as { code?: string }).code === '42501') throw new AuthError('invalid_invitation', 400, 'Invitation invalide, expirée ou destinée à une autre adresse');
      throw err;
    }
  }

  /**
   * Invite un prestataire depuis une fiche d'annuaire du client courant. Le prestataire crée son compte
   * (organisation de type prestataire) en acceptant ; le rattachement n'est posé qu'à ce moment.
   */
  async inviterPrestataire(ctx: TenantContext, annuaireId: string, rawEmail: string): Promise<{ expires_at: Date }> {
    const email = normEmail(rawEmail);
    const token = randomToken();
    const expiresAt = new Date(Date.now() + this.cfg.invitationTtlSec * 1000);
    const { client, prestataire } = await this.db.withTenant(ctx, async (c) => {
      await c.query('SELECT app.inviter_prestataire($1, $2, $3, $4)', [annuaireId, email, sha256Hex(token), expiresAt]);
      const cl = (await c.query<{ nom: string }>('SELECT nom FROM organisation WHERE id = $1', [ctx.orgId])).rows[0]!;
      const p = (await c.query<{ nom: string }>('SELECT nom FROM prestataire_annuaire WHERE id = $1', [annuaireId])).rows[0]!;
      return { client: cl.nom, prestataire: p.nom };
    }).catch((err) => {
      const code = (err as { code?: string }).code;
      if (code === 'P0002') throw new AuthError('not_found', 404, 'Prestataire introuvable');
      if (code === '23505') throw new AuthError('deja_rattache', 409, 'Ce prestataire a déjà un compte rattaché');
      if (code === '42501') throw new AuthError('forbidden', 403, 'Invitation réservée à un property manager');
      throw err;
    });
    await this.mailer.sendInvitation({
      to: email, organisation: prestataire, role: 'admin_org', expiresAt, invitePar: client,
      link: `${this.cfg.appBaseUrl}/invitations/${token}`,
    });
    return { expires_at: expiresAt };
  }

  // --- Vision de l'administrateur sur son organisation -------------------------------------------
  listMembers(ctx: TenantContext) {
    return this.db.withTenant(ctx, async (c) =>
      (await c.query('SELECT * FROM app.org_membres() ORDER BY actif DESC, email')).rows);
  }

  listInvitations(ctx: TenantContext) {
    return this.db.withTenant(ctx, async (c) =>
      (await c.query(
        `SELECT id, email, role, expires_at, created_at,
                CASE WHEN accepted_at IS NOT NULL THEN 'acceptee' WHEN revoked_at IS NOT NULL THEN 'revoquee'
                     WHEN expires_at <= now() THEN 'expiree' ELSE 'en_attente' END AS statut
           FROM invitation ORDER BY created_at DESC`)).rows);
  }

  async revokeInvitation(ctx: TenantContext, id: string): Promise<void> {
    const r = await this.db.withTenant(ctx, (c) => c.query(
      'UPDATE invitation SET revoked_at = now() WHERE id = $1 AND accepted_at IS NULL AND revoked_at IS NULL RETURNING id', [id]));
    if (!r.rows[0]) throw new AuthError('not_found', 404, 'Invitation introuvable ou déjà traitée');
  }

  // --- Membres --------------------------------------------------------------------------------
  /** Retire un membre de l'espace actif. Refuse de retirer le dernier administrateur. */
  async deactivateMember(ctx: TenantContext, memberUserId: string): Promise<void> {
    await this.db.withTenant(ctx, async (c) => {
      const target = (await c.query<{ role: string; actif: boolean }>(
        'SELECT role, actif FROM appartenance WHERE utilisateur_id = $1 FOR UPDATE', [memberUserId])).rows[0];
      if (!target || !target.actif) throw new AuthError('member_not_found', 404);
      if (target.role === 'admin_org') {
        const n = (await c.query<{ n: number }>("SELECT count(*)::int AS n FROM appartenance WHERE role = 'admin_org' AND actif")).rows[0]!.n;
        if (n <= 1) throw new AuthError('last_admin', 409, 'Impossible de retirer le dernier administrateur');
      }
      await c.query('UPDATE appartenance SET actif = false WHERE utilisateur_id = $1', [memberUserId]);
    });
  }

  verifyAccess(token: string) {
    return verifyToken(this.cfg, token, 'access');
  }
}

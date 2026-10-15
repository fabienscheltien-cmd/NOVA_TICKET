export interface AuthConfig {
  jwtSecret: Uint8Array;
  /** Clé AES-256 (32 octets) pour chiffrer les secrets MFA au repos. */
  encKey: Buffer;
  accessTtlSec: number;
  refreshTtlSec: number;
  mfaTokenTtlSec: number;
  invitationTtlSec: number;
  issuer: string;
  appBaseUrl: string;
}

export function loadAuthConfig(env: NodeJS.ProcessEnv = process.env): AuthConfig {
  const secret = env.JWT_SECRET;
  if (!secret || secret.length < 32) throw new Error('JWT_SECRET (32 caractères minimum) est requis');
  const key = Buffer.from(env.APP_ENCRYPTION_KEY ?? '', 'base64');
  if (key.length !== 32) throw new Error('APP_ENCRYPTION_KEY doit être une clé de 32 octets encodée en base64');
  return {
    jwtSecret: new TextEncoder().encode(secret),
    encKey: key,
    accessTtlSec: 15 * 60,
    refreshTtlSec: 30 * 24 * 3600,
    mfaTokenTtlSec: 5 * 60,
    invitationTtlSec: 7 * 24 * 3600,
    issuer: 'nova-ticket',
    appBaseUrl: env.APP_BASE_URL ?? 'http://localhost:5173',
  };
}

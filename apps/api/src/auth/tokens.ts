import { jwtVerify, SignJWT } from 'jose';
import type { AuthConfig } from './config.js';

export type TokenType = 'access' | 'mfa';
export interface TokenClaims { sub: string; typ: TokenType; org?: string }

export async function signToken(cfg: AuthConfig, claims: TokenClaims, ttlSec: number): Promise<string> {
  const jwt = new SignJWT({ typ: claims.typ, ...(claims.org ? { org: claims.org } : {}) })
    .setProtectedHeader({ alg: 'HS256' })
    .setSubject(claims.sub)
    .setIssuer(cfg.issuer)
    .setIssuedAt()
    .setExpirationTime(Math.floor(Date.now() / 1000) + ttlSec);
  return jwt.sign(cfg.jwtSecret);
}

/** Renvoie les revendications, ou null si le jeton est invalide, expiré ou du mauvais type. */
export async function verifyToken(cfg: AuthConfig, token: string, expected: TokenType): Promise<TokenClaims | null> {
  try {
    const { payload } = await jwtVerify(token, cfg.jwtSecret, { issuer: cfg.issuer, algorithms: ['HS256'] });
    if (payload.typ !== expected || typeof payload.sub !== 'string') return null;
    return { sub: payload.sub, typ: expected, ...(typeof payload.org === 'string' ? { org: payload.org } : {}) };
  } catch {
    return null;
  }
}

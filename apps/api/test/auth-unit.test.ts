import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { SignJWT } from 'jose';
import { loadAuthConfig } from '../src/auth/config.js';
import { decryptSecret, encryptSecret, generateBackupCodes, hashPassword, verifyPassword } from '../src/auth/crypto.js';
import { grantFor } from '../src/auth/permissions.js';
import { signToken, verifyToken } from '../src/auth/tokens.js';
import { base32Decode, base32Encode, hotp, totp, verifyTotp } from '../src/auth/totp.js';
import { authConfig } from './helpers.js';

describe('TOTP (RFC 6238 / RFC 4226)', () => {
  const ascii = Buffer.from('12345678901234567890');
  it('vecteurs de test RFC 6238 (SHA-1, 8 chiffres)', () => {
    const vectors: Array<[number, string]> = [
      [59, '94287082'], [1111111109, '07081804'], [1111111111, '14050471'], [1234567890, '89005924'], [2000000000, '69279037'],
    ];
    for (const [t, expected] of vectors) assert.equal(hotp(ascii, Math.floor(t / 30), 8), expected, `t=${t}`);
  });
  it('base32 aller-retour', () => {
    assert.equal(base32Decode(base32Encode(ascii)).toString(), ascii.toString());
    assert.equal(base32Encode(Buffer.from('foobar')), 'MZXW6YTBOI');
  });
  it('accepte ±1 pas, refuse au-delà et les formats invalides', () => {
    const secret = base32Encode(ascii);
    const now = 1_700_000_000_000;
    assert.equal(verifyTotp(secret, totp(secret, now), now), true);
    assert.equal(verifyTotp(secret, totp(secret, now - 30_000), now), true);
    assert.equal(verifyTotp(secret, totp(secret, now - 90_000), now), false);
    assert.equal(verifyTotp(secret, '12345', now), false);
    assert.equal(verifyTotp(secret, 'abcdef', now), false);
  });
});

describe('crypto', () => {
  it('mot de passe : argon2id, vérification et refus', async () => {
    const h = await hashPassword('un mot de passe assez long');
    assert.match(h, /^\$argon2id\$/);
    assert.equal(await verifyPassword(h, 'un mot de passe assez long'), true);
    assert.equal(await verifyPassword(h, 'autre'), false);
    assert.equal(await verifyPassword('pas un haché', 'x'), false);
  });
  it('chiffrement AES-GCM : aller-retour, falsification détectée, clé erronée refusée', () => {
    const key = Buffer.alloc(32, 1);
    const enc = encryptSecret('JBSWY3DPEHPK3PXP', key);
    assert.equal(decryptSecret(enc, key), 'JBSWY3DPEHPK3PXP');
    assert.notEqual(encryptSecret('JBSWY3DPEHPK3PXP', key), enc, 'IV aléatoire');
    const raw = Buffer.from(enc, 'base64');
    raw[raw.length - 1] = raw[raw.length - 1]! ^ 1;
    assert.throws(() => decryptSecret(raw.toString('base64'), key));
    assert.throws(() => decryptSecret(enc, Buffer.alloc(32, 2)));
  });
  it('codes de secours : 10 codes distincts au bon format', () => {
    const codes = generateBackupCodes();
    assert.equal(new Set(codes).size, 10);
    for (const c of codes) assert.match(c, /^[0-9a-f]{5}-[0-9a-f]{5}$/);
  });
});

describe('jetons', () => {
  const cfg = authConfig();
  it('jeton valide accepté, mauvais type refusé', async () => {
    const t = await signToken(cfg, { sub: 'u1', typ: 'access', org: 'o1' }, 60);
    assert.deepEqual(await verifyToken(cfg, t, 'access'), { sub: 'u1', typ: 'access', org: 'o1' });
    assert.equal(await verifyToken(cfg, t, 'mfa'), null);
  });
  it('jeton expiré, falsifié ou signé avec une autre clé : refusé', async () => {
    const expired = await signToken(cfg, { sub: 'u1', typ: 'access' }, -10);
    assert.equal(await verifyToken(cfg, expired, 'access'), null);
    const good = await signToken(cfg, { sub: 'u1', typ: 'access' }, 60);
    assert.equal(await verifyToken(cfg, good.slice(0, -2) + 'xx', 'access'), null);
    const other = loadAuthConfig({ ...process.env, JWT_SECRET: 'another-secret-that-is-long-enough-123456' });
    assert.equal(await verifyToken(other, good, 'access'), null);
  });
  it('algorithme « none » refusé', async () => {
    const unsigned = `${Buffer.from('{"alg":"none"}').toString('base64url')}.${Buffer.from('{"sub":"u1","typ":"access"}').toString('base64url')}.`;
    assert.equal(await verifyToken(cfg, unsigned, 'access'), null);
    const hs512 = await new SignJWT({ typ: 'access' }).setProtectedHeader({ alg: 'HS512' }).setSubject('u1').setIssuer(cfg.issuer).sign(cfg.jwtSecret);
    assert.equal(await verifyToken(cfg, hs512, 'access'), null);
  });
  it('configuration : secrets trop courts refusés', () => {
    assert.throws(() => loadAuthConfig({ JWT_SECRET: 'court', APP_ENCRYPTION_KEY: Buffer.alloc(32).toString('base64') }));
    assert.throws(() => loadAuthConfig({ JWT_SECRET: 'x'.repeat(40), APP_ENCRYPTION_KEY: 'AAAA' }));
  });
});

describe('permissions', () => {
  it('conformes à la matrice (extraits)', () => {
    assert.equal(grantFor('admin_org', 'user.invite'), 'yes');
    assert.equal(grantFor('gestionnaire_fm', 'user.invite'), null);
    assert.equal(grantFor('technicien', 'ot.execute'), 'yes');
    assert.equal(grantFor('technicien', 'ticket.create'), 'cond');
    assert.equal(grantFor('asset_manager', 'ticket.create'), null);
    assert.equal(grantFor('inconnu', 'user.invite'), null);
  });
});

import type { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { AppModule } from '../src/app.module.js';
import { configureApp } from '../src/app.setup.js';
import { MAILER, MemoryMailer } from '../src/auth/mailer.js';
import { totp } from '../src/auth/totp.js';
import { TEST_PASSWORD } from './helpers.js';

export const MFA_SECRET = 'JBSWY3DPEHPK3PXP';

export interface TestApp {
  app: INestApplication;
  base: string;
  mailer: MemoryMailer;
  call(method: string, path: string, opts?: { body?: unknown; token?: string }): Promise<{ status: number; json: any }>;
  /** Connexion complète (MFA si le compte en a une) puis entrée dans l'espace de travail : renvoie le jeton d'accès de l'espace. */
  loginOrg(email: string, orgId: string): Promise<string>;
  close(): Promise<void>;
}

/** Limite de débit relevée par défaut : les suites se connectent beaucoup depuis 127.0.0.1. */
export async function startTestApp(opts: { rateLimitAuthPerMin?: number } = {}): Promise<TestApp> {
  process.env.RATE_LIMIT_AUTH_PER_MIN = String(opts.rateLimitAuthPerMin ?? 1000);
  const mailer = new MemoryMailer();
  const mod = await Test.createTestingModule({ imports: [AppModule] }).overrideProvider(MAILER).useValue(mailer).compile();
  const app = mod.createNestApplication();
  configureApp(app);
  await app.listen(0, '127.0.0.1');
  const base = (await app.getUrl()).replace('[::1]', '127.0.0.1');
  const call: TestApp['call'] = async (method, path, opts = {}) => {
    const res = await fetch(base + path, {
      method,
      headers: { ...(opts.token ? { authorization: `Bearer ${opts.token}` } : {}), ...(opts.body !== undefined ? { 'content-type': 'application/json' } : {}) },
      body: opts.body === undefined ? undefined : JSON.stringify(opts.body),
    });
    const text = await res.text();
    return { status: res.status, json: text ? JSON.parse(text) : null };
  };
  const loginOrg: TestApp['loginOrg'] = async (email, orgId) => {
    const l = await call('POST', '/auth/login', { body: { email, password: TEST_PASSWORD } });
    const token = l.json.status === 'mfa_required'
      ? (await call('POST', '/auth/mfa/verify', { body: { mfa_token: l.json.mfa_token, code: totp(MFA_SECRET, Date.now()) } })).json.access_token
      : l.json.access_token;
    const sw = await call('POST', '/me/workspace/switch', { token, body: { org_id: orgId } });
    if (sw.status !== 200) throw new Error(`entrée dans l'espace refusée pour ${email} : ${JSON.stringify(sw.json)}`);
    return sw.json.access_token as string;
  };
  return { app, base, mailer, call, loginOrg, close: () => app.close() };
}

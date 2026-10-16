import { CanActivate, ExecutionContext, HttpException, Inject, Injectable, SetMetadata } from '@nestjs/common';
import { Reflector } from '@nestjs/core';

/**
 * Limitation de débit par adresse IP et par seau (fenêtre glissante, en mémoire).
 * Limite connue : le compteur est propre à chaque instance ; avec plusieurs instances derrière un
 * répartiteur il faudra un compteur partagé (Redis, prévu avec la file de tâches).
 * L'IP vient de `req.ip` : configurer TRUST_PROXY (nombre de proxys de confiance) derrière un répartiteur,
 * sinon toutes les requêtes semblent venir de lui.
 */
export interface RateLimitSpec { bucket: string; limit: 'auth' | number; windowSec: number }

const KEY = 'nova:rate-limit';
/** `limit: 'auth'` = valeur de RATE_LIMIT_AUTH_PER_MIN (défaut 20 par minute et par IP). */
export const RateLimit = (bucket: string, limit: 'auth' | number = 'auth', windowSec = 60) =>
  SetMetadata(KEY, { bucket, limit, windowSec } satisfies RateLimitSpec);

interface Req { ip?: string; socket?: { remoteAddress?: string } }
interface Res { setHeader(name: string, value: string): void }

@Injectable()
export class RateLimitGuard implements CanActivate {
  private readonly hits = new Map<string, number[]>();
  private lastSweep = Date.now();

  constructor(@Inject(Reflector) private readonly reflector: Reflector) {}

  private authLimit(): number {
    const n = Number(process.env.RATE_LIMIT_AUTH_PER_MIN);
    return Number.isFinite(n) && n > 0 ? n : 20;
  }

  canActivate(ctx: ExecutionContext): boolean {
    const spec = this.reflector.get<RateLimitSpec | undefined>(KEY, ctx.getHandler());
    if (!spec) return true;
    const http = ctx.switchToHttp();
    const req = http.getRequest<Req>();
    const now = Date.now();
    const limit = spec.limit === 'auth' ? this.authLimit() : spec.limit;
    const windowMs = spec.windowSec * 1000;
    const key = `${spec.bucket}|${req.ip ?? req.socket?.remoteAddress ?? 'inconnue'}`;
    const recent = (this.hits.get(key) ?? []).filter((t) => now - t < windowMs);
    if (recent.length >= limit) {
      const retry = Math.max(1, Math.ceil((windowMs - (now - recent[0]!)) / 1000));
      http.getResponse<Res>().setHeader('Retry-After', String(retry));
      throw new HttpException({ error: 'too_many_requests', message: 'Trop de tentatives, réessayez dans quelques instants', retry_after: retry }, 429);
    }
    recent.push(now);
    this.hits.set(key, recent);
    if (now - this.lastSweep > 60_000) this.sweep(now);
    return true;
  }

  private sweep(now: number): void {
    this.lastSweep = now;
    for (const [k, v] of this.hits) if (v.every((t) => now - t > 3_600_000)) this.hits.delete(k);
  }
}

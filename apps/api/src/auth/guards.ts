import { CanActivate, ExecutionContext, Inject, Injectable, SetMetadata } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import type { TenantContext } from '../db/tenant-db.js';
import { AuthService } from './auth.service.js';
import { forbidden, unauthorized } from './errors.js';
import { grantFor } from './permissions.js';

export interface AuthedRequest {
  headers: Record<string, string | string[] | undefined>;
  userId?: string;
  tenant?: TenantContext & { role: string };
}

const PERMISSION_KEY = 'nova:permission';
export const RequirePermission = (permission: string) => SetMetadata(PERMISSION_KEY, permission);

function bearer(req: AuthedRequest): string {
  const h = req.headers.authorization;
  const value = Array.isArray(h) ? h[0] : h;
  if (!value?.startsWith('Bearer ')) throw unauthorized();
  return value.slice(7);
}

/** Jeton d'accès valide, avec ou sans espace de travail. */
@Injectable()
export class UserGuard implements CanActivate {
  constructor(@Inject(AuthService) private readonly auth: AuthService) {}
  async canActivate(ctx: ExecutionContext): Promise<boolean> {
    const req = ctx.switchToHttp().getRequest<AuthedRequest>();
    const claims = await this.auth.verifyAccess(bearer(req));
    if (!claims) throw unauthorized();
    req.userId = claims.sub;
    return true;
  }
}

/**
 * Jeton d'accès rattaché à un espace de travail. L'appartenance est revérifiée en base à CHAQUE requête :
 * une désactivation prend effet immédiatement, sans attendre l'expiration du jeton.
 */
@Injectable()
export class OrgGuard implements CanActivate {
  constructor(@Inject(AuthService) private readonly auth: AuthService, @Inject(Reflector) private readonly reflector: Reflector) {}
  async canActivate(ctx: ExecutionContext): Promise<boolean> {
    const req = ctx.switchToHttp().getRequest<AuthedRequest>();
    const claims = await this.auth.verifyAccess(bearer(req));
    if (!claims) throw unauthorized();
    if (!claims.org) throw forbidden('workspace_required');
    const m = await this.auth.resolveMembership(claims.sub, claims.org);
    if (!m) throw forbidden('not_a_member');
    const permission = this.reflector.get<string | undefined>(PERMISSION_KEY, ctx.getHandler());
    if (permission && grantFor(m.role, permission) === null) throw forbidden('missing_permission');
    req.userId = claims.sub;
    req.tenant = { userId: claims.sub, orgId: claims.org, role: m.role };
    return true;
  }
}

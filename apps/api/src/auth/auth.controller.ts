import { Body, Controller, Get, HttpCode, Headers, Inject, Param, Post, Req, UseGuards } from '@nestjs/common';
import { z } from 'zod';
import { AuthService } from './auth.service.js';
import { AuthError, forbidden } from './errors.js';
import { type AuthedRequest, OrgGuard, RequirePermission, UserGuard } from './guards.js';
import { MIN_PASSWORD_LENGTH } from './crypto.js';

function parse<S extends z.ZodTypeAny>(schema: S, body: unknown): z.infer<S> {
  const r = schema.safeParse(body);
  if (!r.success) throw new AuthError('validation_error', 400, r.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; '));
  return r.data;
}

const uuid = z.string().uuid();
const email = z.string().email().max(254);
const password = z.string().min(MIN_PASSWORD_LENGTH).max(256);

@Controller('auth')
export class AuthController {
  constructor(@Inject(AuthService) private readonly auth: AuthService) {}

  @Post('login') @HttpCode(200)
  login(@Body() body: unknown, @Headers('user-agent') ua?: string) {
    const b = parse(z.object({ email, password: z.string().min(1).max(256) }), body);
    return this.auth.login(b.email, b.password, ua);
  }

  @Post('mfa/verify') @HttpCode(200)
  mfaVerify(@Body() body: unknown, @Headers('user-agent') ua?: string) {
    const b = parse(z.object({ mfa_token: z.string().min(1), code: z.string().min(6).max(16) }), body);
    return this.auth.verifyMfa(b.mfa_token, b.code, ua);
  }

  @Post('refresh') @HttpCode(200)
  refresh(@Body() body: unknown, @Headers('user-agent') ua?: string) {
    const b = parse(z.object({ refresh_token: z.string().min(1), org_id: uuid.optional() }), body);
    return this.auth.refresh(b.refresh_token, ua, b.org_id);
  }

  @Post('logout') @HttpCode(204)
  async logout(@Body() body: unknown) {
    await this.auth.logout(parse(z.object({ refresh_token: z.string().min(1) }), body).refresh_token);
  }
}

@Controller('me')
@UseGuards(UserGuard)
export class MeController {
  constructor(@Inject(AuthService) private readonly auth: AuthService) {}

  @Get('workspaces')
  async workspaces(@Req() req: AuthedRequest) {
    return { workspaces: await this.auth.listWorkspaces(req.userId!) };
  }

  @Post('workspace/switch') @HttpCode(200)
  switch(@Req() req: AuthedRequest, @Body() body: unknown) {
    return this.auth.switchWorkspace(req.userId!, parse(z.object({ org_id: uuid }), body).org_id);
  }

  @Post('mfa/setup') @HttpCode(200)
  mfaSetup(@Req() req: AuthedRequest) {
    return this.auth.mfaSetup(req.userId!);
  }

  @Post('mfa/confirm') @HttpCode(200)
  mfaConfirm(@Req() req: AuthedRequest, @Body() body: unknown) {
    return this.auth.mfaConfirm(req.userId!, parse(z.object({ code: z.string().length(6) }), body).code);
  }

  @Post('invitations/:token/accept') @HttpCode(200)
  acceptExisting(@Req() req: AuthedRequest, @Param('token') token: string) {
    return this.auth.acceptInvitationExisting(token, req.userId!);
  }
}

@Controller()
export class InvitationsController {
  constructor(@Inject(AuthService) private readonly auth: AuthService) {}

  @Post('invitations') @HttpCode(201)
  @UseGuards(OrgGuard) @RequirePermission('user.invite')
  create(@Req() req: AuthedRequest, @Body() body: unknown) {
    return this.auth.createInvitation(req.tenant!, parse(z.object({ email, role: z.string().min(1) }), body));
  }

  /** Public : crée le compte à partir d'une invitation (nouvel utilisateur). */
  @Post('invitations/:token/accept') @HttpCode(200)
  accept(@Param('token') token: string, @Body() body: unknown, @Headers('user-agent') ua?: string) {
    return this.auth.acceptInvitationNew(token, parse(z.object({ password, nom: z.string().min(1).max(200) }), body), ua);
  }

  @Post('organisations/:orgId/members/:userId/deactivate') @HttpCode(204)
  @UseGuards(OrgGuard) @RequirePermission('user.manage')
  async deactivate(@Req() req: AuthedRequest, @Param('orgId') orgId: string, @Param('userId') userId: string) {
    if (orgId !== req.tenant!.orgId) throw forbidden('wrong_workspace');
    parse(uuid, userId);
    await this.auth.deactivateMember(req.tenant!, userId);
  }
}

import { Body, Controller, Get, HttpCode, Inject, Param, Patch, Post, Put, Query, Req, UseGuards } from '@nestjs/common';
import { z } from 'zod';
import { statutPrestataireSchema } from '@nova/shared';
import { AuthService } from '../auth/auth.service.js';
import { AuthError } from '../auth/errors.js';
import { type AuthedRequest, OrgGuard, RequirePermission } from '../auth/guards.js';
import { pageSchema } from '../patrimoine/schemas.js';
import { ContratsService } from './contrats.service.js';
import { DispatchService } from './dispatch.service.js';

function parse<Sc extends z.ZodTypeAny>(schema: Sc, input: unknown): z.infer<Sc> {
  const r = schema.safeParse(input);
  if (!r.success) throw new AuthError('validation_error', 400, r.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; '));
  return r.data;
}
const uuid = z.string().uuid();
const idParam = (v: string) => parse(uuid, v);

@Controller()
@UseGuards(OrgGuard)
export class DispatchController {
  constructor(
    @Inject(DispatchService) private readonly d: DispatchService,
    @Inject(AuthService) private readonly auth: AuthService,
  ) {}

  // Familles de tickets
  @Get('familles') @RequirePermission('annuaire.read')
  async familles(@Req() r: AuthedRequest) { return { items: await this.d.listFamilles(r.tenant!) }; }
  @Post('familles') @HttpCode(201) @RequirePermission('config.manage')
  createFamille(@Req() r: AuthedRequest, @Body() b: unknown) { return this.d.createFamille(r.tenant!, b); }
  @Post('familles/defaults') @HttpCode(200) @RequirePermission('config.manage')
  async defaults(@Req() r: AuthedRequest) { return { items: await this.d.importFamillesStandard(r.tenant!) }; }
  @Patch('familles/:id') @RequirePermission('config.manage')
  patchFamille(@Req() r: AuthedRequest, @Param('id') id: string, @Body() b: unknown) { return this.d.updateFamille(r.tenant!, idParam(id), b); }

  // Annuaire des prestataires
  @Get('annuaire') @RequirePermission('annuaire.read')
  async annuaire(@Req() r: AuthedRequest, @Query() q: unknown) {
    const f = parse(pageSchema.extend({ q: z.string().max(100).optional(), famille_id: uuid.optional(), statut: z.enum(['actif', 'suspendu']).optional() }), q);
    return { items: await this.d.listPrestataires(r.tenant!, f, f) };
  }
  @Post('annuaire') @HttpCode(201) @RequirePermission('config.manage')
  createPrestataire(@Req() r: AuthedRequest, @Body() b: unknown) { return this.d.createPrestataire(r.tenant!, b); }
  @Get('annuaire/:id') @RequirePermission('annuaire.read')
  prestataire(@Req() r: AuthedRequest, @Param('id') id: string) { return this.d.getPrestataire(r.tenant!, idParam(id)); }
  @Patch('annuaire/:id') @RequirePermission('config.manage')
  patchPrestataire(@Req() r: AuthedRequest, @Param('id') id: string, @Body() b: unknown) { return this.d.updatePrestataire(r.tenant!, idParam(id), b); }
  @Post('annuaire/:id/statut') @HttpCode(200) @RequirePermission('config.manage')
  statut(@Req() r: AuthedRequest, @Param('id') id: string, @Body() b: unknown) {
    return this.d.setStatutPrestataire(r.tenant!, idParam(id), parse(statutPrestataireSchema, b).statut);
  }

  /** Invite le prestataire à créer son compte ; le rattachement n'est posé qu'à l'acceptation. */
  @Post('annuaire/:id/invitation') @HttpCode(200) @RequirePermission('config.manage')
  async inviter(@Req() r: AuthedRequest, @Param('id') id: string, @Body() b: unknown) {
    const { email } = parse(z.object({ email: z.string().trim().email().max(254) }), b);
    await this.auth.inviterPrestataire(r.tenant!, idParam(id), email);
    return this.d.getPrestataire(r.tenant!, id);
  }

  // Tickets et affectation
  @Get('tickets') @RequirePermission('ticket.read')
  async tickets(@Req() r: AuthedRequest, @Query() q: unknown) {
    const f = parse(pageSchema.extend({ statut: z.string().max(20).optional(), famille_id: uuid.optional() }), q);
    return { items: await this.d.listTickets(r.tenant!, f, f) };
  }
  @Post('tickets') @HttpCode(201) @RequirePermission('ticket.create')
  createTicket(@Req() r: AuthedRequest, @Body() b: unknown) { return this.d.createTicket(r.tenant!, b); }
  @Get('tickets/:id') @RequirePermission('ticket.read')
  ticket(@Req() r: AuthedRequest, @Param('id') id: string) { return this.d.getTicket(r.tenant!, idParam(id)); }
  @Post('tickets/:id/affectation') @HttpCode(200) @RequirePermission('ticket.assign')
  affecter(@Req() r: AuthedRequest, @Param('id') id: string, @Body() b: unknown) { return this.d.affecter(r.tenant!, idParam(id), b); }
}

/** Calendriers ouvrés, contrats de service, règles SLA et paramètres de dispatch. */
@Controller()
@UseGuards(OrgGuard)
export class ContratsController {
  constructor(@Inject(ContratsService) private readonly c: ContratsService) {}

  @Get('calendriers') @RequirePermission('contrat.read')
  async calendriers(@Req() r: AuthedRequest) { return { items: await this.c.listCalendriers(r.tenant!) }; }
  @Post('calendriers') @HttpCode(201) @RequirePermission('sla.configure')
  creerCalendrier(@Req() r: AuthedRequest, @Body() b: unknown) { return this.c.createCalendrier(r.tenant!, b); }
  @Put('calendriers/:id') @RequirePermission('sla.configure')
  majCalendrier(@Req() r: AuthedRequest, @Param('id') id: string, @Body() b: unknown) { return this.c.updateCalendrier(r.tenant!, idParam(id), b); }

  @Get('contrats') @RequirePermission('contrat.read')
  async contrats(@Req() r: AuthedRequest, @Query() q: unknown) {
    const f = parse(pageSchema.extend({ annuaire_id: uuid.optional(), statut: z.enum(['actif', 'suspendu']).optional() }), q);
    return { items: await this.c.listContrats(r.tenant!, f, f) };
  }
  @Get('contrats/:id') @RequirePermission('contrat.read')
  contrat(@Req() r: AuthedRequest, @Param('id') id: string) { return this.c.getContrat(r.tenant!, idParam(id)); }
  @Post('contrats') @HttpCode(201) @RequirePermission('sla.configure')
  creerContrat(@Req() r: AuthedRequest, @Body() b: unknown) { return this.c.createContrat(r.tenant!, b); }
  @Patch('contrats/:id') @RequirePermission('sla.configure')
  majContrat(@Req() r: AuthedRequest, @Param('id') id: string, @Body() b: unknown) { return this.c.updateContrat(r.tenant!, idParam(id), b); }

  @Get('parametres') @RequirePermission('contrat.read')
  parametres(@Req() r: AuthedRequest) { return this.c.getParametres(r.tenant!); }
  @Put('parametres') @RequirePermission('sla.configure')
  majParametres(@Req() r: AuthedRequest, @Body() b: unknown) { return this.c.setParametres(r.tenant!, b); }
}

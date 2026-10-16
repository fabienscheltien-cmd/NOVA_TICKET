import {
  Body, Controller, Delete, Get, Header, HttpCode, Inject, Param, Patch, Post, Query, Req, StreamableFile, UseGuards,
} from '@nestjs/common';
import { z } from 'zod';
import { AuthError } from '../auth/errors.js';
import { type AuthedRequest, OrgGuard, RequirePermission } from '../auth/guards.js';
import { ImportService, type ImportKind } from './import.service.js';
import { PatrimoineService } from './patrimoine.service.js';
import * as S from './schemas.js';

function parse<Sc extends z.ZodTypeAny>(schema: Sc, input: unknown): z.infer<Sc> {
  const r = schema.safeParse(input);
  if (!r.success) throw new AuthError('validation_error', 400, r.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; '));
  return r.data;
}
const uuid = z.string().uuid();
const idParam = (v: string) => parse(uuid, v);
const optUuid = z.string().uuid().optional();

@Controller()
@UseGuards(OrgGuard)
export class PatrimoineController {
  constructor(
    @Inject(PatrimoineService) private readonly p: PatrimoineService,
    @Inject(ImportService) private readonly imports: ImportService,
  ) {}

  // Portefeuilles
  @Get('portefeuilles') @RequirePermission('patrimoine.read')
  async portefeuilles(@Req() r: AuthedRequest, @Query() q: unknown) { return { items: await this.p.listPortefeuilles(r.tenant!, parse(S.pageSchema, q)) }; }
  @Post('portefeuilles') @HttpCode(201) @RequirePermission('patrimoine.write')
  createPortefeuille(@Req() r: AuthedRequest, @Body() b: unknown) { return this.p.createPortefeuille(r.tenant!, parse(S.portefeuilleSchema, b)); }

  // Sites
  @Get('sites') @RequirePermission('patrimoine.read')
  async sites(@Req() r: AuthedRequest, @Query() q: unknown) {
    const f = parse(S.pageSchema.extend({ portefeuille_id: optUuid, q: z.string().max(100).optional() }), q);
    return { items: await this.p.listSites(r.tenant!, f, f) };
  }
  @Post('sites') @HttpCode(201) @RequirePermission('patrimoine.write')
  createSite(@Req() r: AuthedRequest, @Body() b: unknown) { return this.p.createSite(r.tenant!, parse(S.siteCreateSchema, b)); }
  @Get('sites/:id') @RequirePermission('patrimoine.read')
  site(@Req() r: AuthedRequest, @Param('id') id: string) { return this.p.getSite(r.tenant!, idParam(id)); }
  @Patch('sites/:id') @RequirePermission('patrimoine.write')
  patchSite(@Req() r: AuthedRequest, @Param('id') id: string, @Body() b: unknown) { return this.p.patchSite(r.tenant!, idParam(id), parse(S.sitePatchSchema, b)); }
  @Delete('sites/:id') @HttpCode(204) @RequirePermission('patrimoine.write')
  async archiveSite(@Req() r: AuthedRequest, @Param('id') id: string) { await this.p.archive(r.tenant!, 'site', idParam(id)); }
  @Get('sites/:id/occupants') @RequirePermission('patrimoine.read')
  async siteOccupants(@Req() r: AuthedRequest, @Param('id') id: string) { return { items: await this.p.siteOccupants(r.tenant!, idParam(id)) }; }

  // Bâtiments, niveaux, locaux
  @Get('batiments') @RequirePermission('patrimoine.read')
  async batiments(@Req() r: AuthedRequest, @Query() q: unknown) {
    const f = parse(S.pageSchema.extend({ site_id: optUuid }), q);
    return { items: await this.p.listBatiments(r.tenant!, f.site_id, f) };
  }
  @Post('batiments') @HttpCode(201) @RequirePermission('patrimoine.write')
  createBatiment(@Req() r: AuthedRequest, @Body() b: unknown) { return this.p.createBatiment(r.tenant!, parse(S.batimentSchema, b)); }
  @Get('niveaux') @RequirePermission('patrimoine.read')
  async niveaux(@Req() r: AuthedRequest, @Query() q: unknown) {
    const f = parse(S.pageSchema.extend({ batiment_id: optUuid }), q);
    return { items: await this.p.listNiveaux(r.tenant!, f.batiment_id, f) };
  }
  @Post('niveaux') @HttpCode(201) @RequirePermission('patrimoine.write')
  createNiveau(@Req() r: AuthedRequest, @Body() b: unknown) { return this.p.createNiveau(r.tenant!, parse(S.niveauSchema, b)); }
  @Get('locaux') @RequirePermission('patrimoine.read')
  async locaux(@Req() r: AuthedRequest, @Query() q: unknown) {
    const f = parse(S.pageSchema.extend({ site_id: optUuid, niveau_id: optUuid }), q);
    return { items: await this.p.listLocaux(r.tenant!, f, f) };
  }
  @Post('locaux') @HttpCode(201) @RequirePermission('patrimoine.write')
  createLocal(@Req() r: AuthedRequest, @Body() b: unknown) { return this.p.createLocal(r.tenant!, parse(S.localSchema, b)); }
  @Get('locaux/:id') @RequirePermission('patrimoine.read')
  local(@Req() r: AuthedRequest, @Param('id') id: string) { return this.p.getLocal(r.tenant!, idParam(id)); }
  @Patch('locaux/:id') @RequirePermission('patrimoine.write')
  patchLocal(@Req() r: AuthedRequest, @Param('id') id: string, @Body() b: unknown) { return this.p.patchLocal(r.tenant!, idParam(id), parse(S.localPatchSchema, b)); }
  @Delete('locaux/:id') @HttpCode(204) @RequirePermission('patrimoine.write')
  async archiveLocal(@Req() r: AuthedRequest, @Param('id') id: string) { await this.p.archive(r.tenant!, 'local', idParam(id)); }
  @Get('locaux/:id/qr.png') @Header('Content-Type', 'image/png') @Header('Cache-Control', 'private, max-age=3600') @RequirePermission('patrimoine.read')
  async qr(@Req() r: AuthedRequest, @Param('id') id: string) { return new StreamableFile(await this.p.qrPng(r.tenant!, idParam(id))); }
  @Get('qr/:code') @RequirePermission('patrimoine.read')
  resolveQr(@Req() r: AuthedRequest, @Param('code') code: string) { return this.p.resolveQr(r.tenant!, parse(z.string().min(8).max(64).regex(/^[A-Za-z0-9_-]+$/), code)); }

  // Occupants
  @Get('occupants') @RequirePermission('patrimoine.read')
  async occupants(@Req() r: AuthedRequest, @Query() q: unknown) { return { items: await this.p.listOccupants(r.tenant!, parse(S.pageSchema, q)) }; }
  @Post('occupants') @HttpCode(201) @RequirePermission('patrimoine.write')
  createOccupant(@Req() r: AuthedRequest, @Body() b: unknown) { return this.p.createOccupant(r.tenant!, parse(S.occupantSchema, b)); }
  @Get('contacts') @RequirePermission('patrimoine.read')
  async contacts(@Req() r: AuthedRequest, @Query() q: unknown) {
    const f = parse(S.pageSchema.extend({ occupant_id: uuid }), q);
    return { items: await this.p.listContacts(r.tenant!, f.occupant_id, f) };
  }
  @Post('contacts') @HttpCode(201) @RequirePermission('patrimoine.write')
  createContact(@Req() r: AuthedRequest, @Body() b: unknown) { return this.p.createContact(r.tenant!, parse(S.contactSchema, b)); }
  @Post('occupations') @HttpCode(201) @RequirePermission('patrimoine.write')
  createOccupation(@Req() r: AuthedRequest, @Body() b: unknown) { return this.p.createOccupation(r.tenant!, parse(S.occupationSchema, b)); }
  @Patch('occupations/:id') @RequirePermission('patrimoine.write')
  endOccupation(@Req() r: AuthedRequest, @Param('id') id: string, @Body() b: unknown) { return this.p.endOccupation(r.tenant!, idParam(id), parse(S.occupationEndSchema, b).fin); }

  // Mandats de gestion
  @Get('mandats') @RequirePermission('contrat.read')
  async mandats(@Req() r: AuthedRequest, @Query() q: unknown) { return { items: await this.p.listMandats(r.tenant!, parse(S.pageSchema, q)) }; }
  @Post('mandats') @HttpCode(201) @RequirePermission('contrat.write')
  createMandat(@Req() r: AuthedRequest, @Body() b: unknown) { return this.p.createMandat(r.tenant!, parse(S.mandatSchema, b)); }
  @Post('mandats/:id/end') @HttpCode(200) @RequirePermission('contrat.write')
  endMandat(@Req() r: AuthedRequest, @Param('id') id: string, @Body() b: unknown) { return this.p.endMandat(r.tenant!, idParam(id), parse(S.mandatEndSchema, b).fin); }

  // Import CSV (corps text/csv). ?dry_run=true pour valider sans écrire ; ?owner_org_id= pour un PM qui importe pour un bailleur.
  @Post('imports/:kind') @HttpCode(200) @RequirePermission('patrimoine.write')
  importCsv(@Req() r: AuthedRequest, @Param('kind') kind: string, @Query() q: unknown, @Body() body: unknown) {
    const k = parse(z.enum(['sites', 'locaux', 'occupations']), kind) as ImportKind;
    const o = parse(z.object({ dry_run: z.enum(['true', 'false']).default('false'), owner_org_id: optUuid }), q);
    if (typeof body !== 'string') throw new AuthError('invalid_csv', 400, 'Corps attendu : text/csv');
    return this.imports.run(r.tenant!, k, body, { dryRun: o.dry_run === 'true', ownerOrgId: o.owner_org_id });
  }
}

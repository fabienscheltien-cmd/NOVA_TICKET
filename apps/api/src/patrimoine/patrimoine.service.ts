import type pg from 'pg';
import QRCode from 'qrcode';
import { AuthError } from '../auth/errors.js';
import { randomToken } from '../auth/crypto.js';
import type { TenantContext, TenantDb } from '../db/tenant-db.js';

export type Row = Record<string, unknown>;
export interface Page { limit: number; offset: number }

const IDENT = /^[a-z][a-z0-9_]*$/;
const notFound = () => new AuthError('not_found', 404, 'Introuvable');

/** INSERT à partir d'un objet validé (clés issues des schémas zod, jamais de l'entrée brute). */
export async function insertRow(c: pg.PoolClient, table: string, data: Row): Promise<Row> {
  const keys = Object.keys(data).filter((k) => data[k] !== undefined);
  if (![table, ...keys].every((k) => IDENT.test(k))) throw new Error('identifiant invalide');
  const { rows } = await c.query(
    `INSERT INTO ${table} (${keys.join(', ')}) VALUES (${keys.map((_, i) => `$${i + 1}`).join(', ')}) RETURNING *`,
    keys.map((k) => data[k]));
  return rows[0] as Row;
}

export async function patchRow(c: pg.PoolClient, table: string, id: string, data: Row): Promise<Row> {
  const keys = Object.keys(data).filter((k) => data[k] !== undefined);
  if (![table, ...keys].every((k) => IDENT.test(k))) throw new Error('identifiant invalide');
  if (keys.length === 0) throw new AuthError('validation_error', 400, 'Aucun champ à modifier');
  const { rows } = await c.query(
    `UPDATE ${table} SET ${keys.map((k, i) => `${k} = $${i + 1}`).join(', ')} WHERE id = $${keys.length + 1} AND deleted_at IS NULL RETURNING *`,
    [...keys.map((k) => data[k]), id]);
  if (!rows[0]) throw notFound();
  return rows[0] as Row;
}

async function one(c: pg.PoolClient, sql: string, params: unknown[]): Promise<Row> {
  const { rows } = await c.query(sql, params);
  if (!rows[0]) throw notFound();
  return rows[0] as Row;
}

export class PatrimoineService {
  constructor(private readonly db: TenantDb, private readonly appBaseUrl: string) {}

  private run<T>(ctx: TenantContext, fn: (c: pg.PoolClient) => Promise<T>) {
    return this.db.withTenant(ctx, fn);
  }
  private list(ctx: TenantContext, sql: string, params: unknown[], page: Page) {
    return this.run(ctx, async (c) =>
      (await c.query(`${sql} ORDER BY 1 LIMIT $${params.length + 1} OFFSET $${params.length + 2}`, [...params, page.limit, page.offset])).rows as Row[]);
  }

  // Portefeuilles
  listPortefeuilles(ctx: TenantContext, page: Page) {
    return this.list(ctx, 'SELECT id, org_id, nom FROM portefeuille', [], page);
  }
  createPortefeuille(ctx: TenantContext, i: { nom: string; owner_org_id?: string }) {
    return this.run(ctx, (c) => insertRow(c, 'portefeuille', { org_id: i.owner_org_id ?? ctx.orgId, nom: i.nom }));
  }

  // Sites
  listSites(ctx: TenantContext, f: { portefeuille_id?: string; q?: string }, page: Page) {
    return this.list(ctx,
      `SELECT * FROM site WHERE deleted_at IS NULL AND ($1::uuid IS NULL OR portefeuille_id = $1) AND ($2::text IS NULL OR nom ILIKE '%' || $2 || '%' OR reference ILIKE '%' || $2 || '%')`,
      [f.portefeuille_id ?? null, f.q ?? null], page);
  }
  getSite(ctx: TenantContext, id: string) {
    return this.run(ctx, (c) => one(c, 'SELECT * FROM site WHERE id = $1 AND deleted_at IS NULL', [id]));
  }
  createSite(ctx: TenantContext, i: Row & { owner_org_id?: string }) {
    const { owner_org_id, ...rest } = i;
    return this.run(ctx, (c) => insertRow(c, 'site', { ...rest, org_id: owner_org_id ?? ctx.orgId }));
  }
  patchSite(ctx: TenantContext, id: string, i: Row) {
    return this.run(ctx, (c) => patchRow(c, 'site', id, i));
  }
  archive(ctx: TenantContext, table: 'site' | 'local', id: string) {
    return this.run(ctx, async (c) => { await patchRow(c, table, id, { deleted_at: new Date() }); });
  }
  siteOccupants(ctx: TenantContext, siteId: string) {
    return this.run(ctx, async (c) => (await c.query(
      `SELECT o.id AS occupant_id, o.nom AS occupant, l.id AS local_id, l.nom AS local, x.debut, x.fin, x.type
         FROM occupation x JOIN occupant o ON o.id = x.occupant_id JOIN local l ON l.id = x.local_id
        WHERE x.site_id = $1 AND (x.fin IS NULL OR x.fin > current_date) AND x.debut <= current_date
        ORDER BY o.nom, l.nom`, [siteId])).rows as Row[]);
  }

  // Bâtiments, niveaux, locaux : le bailleur propriétaire et le site sont toujours dérivés du parent.
  listBatiments(ctx: TenantContext, siteId: string | undefined, page: Page) {
    return this.list(ctx, 'SELECT * FROM batiment WHERE deleted_at IS NULL AND ($1::uuid IS NULL OR site_id = $1)', [siteId ?? null], page);
  }
  createBatiment(ctx: TenantContext, i: { site_id: string; nom: string; reference?: string; surface_m2?: number }) {
    return this.run(ctx, async (c) => {
      const s = await one(c, 'SELECT id, org_id FROM site WHERE id = $1 AND deleted_at IS NULL', [i.site_id]);
      return insertRow(c, 'batiment', { ...i, org_id: s.org_id });
    });
  }
  listNiveaux(ctx: TenantContext, batimentId: string | undefined, page: Page) {
    return this.list(ctx, 'SELECT * FROM niveau WHERE deleted_at IS NULL AND ($1::uuid IS NULL OR batiment_id = $1)', [batimentId ?? null], page);
  }
  createNiveau(ctx: TenantContext, i: { batiment_id: string; nom: string; ordre?: number }) {
    return this.run(ctx, async (c) => {
      const b = await one(c, 'SELECT org_id, site_id FROM batiment WHERE id = $1 AND deleted_at IS NULL', [i.batiment_id]);
      return insertRow(c, 'niveau', { ...i, org_id: b.org_id, site_id: b.site_id });
    });
  }
  listLocaux(ctx: TenantContext, f: { site_id?: string; niveau_id?: string }, page: Page) {
    return this.list(ctx,
      'SELECT * FROM local WHERE deleted_at IS NULL AND ($1::uuid IS NULL OR site_id = $1) AND ($2::uuid IS NULL OR niveau_id = $2)',
      [f.site_id ?? null, f.niveau_id ?? null], page);
  }
  getLocal(ctx: TenantContext, id: string) {
    return this.run(ctx, (c) => one(c, 'SELECT * FROM local WHERE id = $1 AND deleted_at IS NULL', [id]));
  }
  createLocal(ctx: TenantContext, i: { niveau_id: string; nom: string; reference?: string; type?: string; surface_m2?: number }) {
    return this.run(ctx, async (c) => {
      const n = await one(c, 'SELECT org_id, site_id FROM niveau WHERE id = $1 AND deleted_at IS NULL', [i.niveau_id]);
      return insertRow(c, 'local', { ...i, org_id: n.org_id, site_id: n.site_id, qr_code: randomToken(12) });
    });
  }
  patchLocal(ctx: TenantContext, id: string, i: Row) {
    return this.run(ctx, (c) => patchRow(c, 'local', id, i));
  }

  // Occupants, contacts, occupations
  listOccupants(ctx: TenantContext, page: Page) {
    return this.list(ctx, 'SELECT id, org_id, nom, type FROM occupant WHERE deleted_at IS NULL', [], page);
  }
  createOccupant(ctx: TenantContext, i: { nom: string; type?: string; owner_org_id?: string }) {
    return this.run(ctx, (c) => insertRow(c, 'occupant', { org_id: i.owner_org_id ?? ctx.orgId, cree_par_org_id: ctx.orgId, nom: i.nom, type: i.type }));
  }
  listContacts(ctx: TenantContext, occupantId: string, page: Page) {
    return this.list(ctx, 'SELECT * FROM contact WHERE deleted_at IS NULL AND occupant_id = $1', [occupantId], page);
  }
  createContact(ctx: TenantContext, i: { occupant_id: string; nom: string; email?: string; telephone?: string; fonction?: string }) {
    return this.run(ctx, async (c) => {
      const o = await one(c, 'SELECT org_id FROM occupant WHERE id = $1 AND deleted_at IS NULL', [i.occupant_id]);
      return insertRow(c, 'contact', { ...i, org_id: o.org_id });
    });
  }
  createOccupation(ctx: TenantContext, i: { local_id: string; occupant_id: string; debut?: string; fin?: string | null; type?: string; surface_m2?: number }) {
    return this.run(ctx, async (c) => {
      const l = await one(c, 'SELECT org_id, site_id FROM local WHERE id = $1 AND deleted_at IS NULL', [i.local_id]);
      return insertRow(c, 'occupation', { ...i, org_id: l.org_id, site_id: l.site_id });
    });
  }
  endOccupation(ctx: TenantContext, id: string, fin: string) {
    return this.run(ctx, (c) => one(c, 'UPDATE occupation SET fin = $1 WHERE id = $2 RETURNING *', [fin, id]));
  }

  // Mandats de gestion : créés et clos par le bailleur mandant (espace actif = bailleur)
  listMandats(ctx: TenantContext, page: Page) {
    return this.list(ctx, 'SELECT * FROM mandat_gestion', [], page);
  }
  createMandat(ctx: TenantContext, i: { pm_org_id: string; portefeuille_id?: string; site_id?: string; debut?: string; fin?: string }) {
    return this.run(ctx, (c) => insertRow(c, 'mandat_gestion', { ...i, bailleur_org_id: ctx.orgId, created_by: ctx.userId }));
  }
  endMandat(ctx: TenantContext, id: string, fin: string) {
    return this.run(ctx, (c) => one(c, 'UPDATE mandat_gestion SET fin = $1 WHERE id = $2 RETURNING *', [fin, id]));
  }

  // QR : résolution limitée au périmètre visible (RLS) ; 404 identique si le code n'existe pas ou n'est pas visible.
  resolveQr(ctx: TenantContext, code: string) {
    return this.run(ctx, async (c) => {
      const l = await one(c,
        `SELECT 'local' AS type, l.id, l.nom, l.reference, l.type AS local_type, l.site_id, s.nom AS site, n.nom AS niveau, b.nom AS batiment
           FROM local l JOIN site s ON s.id = l.site_id JOIN niveau n ON n.id = l.niveau_id JOIN batiment b ON b.id = n.batiment_id
          WHERE l.qr_code = $1 AND l.deleted_at IS NULL`, [code]);
      return l;
    });
  }
  async qrPng(ctx: TenantContext, localId: string): Promise<Buffer> {
    const l = await this.getLocal(ctx, localId);
    return QRCode.toBuffer(`${this.appBaseUrl}/q/${l.qr_code as string}`, { type: 'png', errorCorrectionLevel: 'M', margin: 2, width: 512 });
  }
}

import { parse } from 'csv-parse/sync';
import type pg from 'pg';
import { z } from 'zod';
import { AuthError } from '../auth/errors.js';
import { randomToken } from '../auth/crypto.js';
import type { TenantContext, TenantDb } from '../db/tenant-db.js';
import { LOCAL_TYPES } from './schemas.js';
import { type Row, insertRow } from './patrimoine.service.js';

export type ImportKind = 'sites' | 'locaux' | 'occupations';
export interface ImportReport {
  kind: ImportKind;
  dry_run: boolean;
  committed: boolean;
  rows: number;
  created: Record<string, number>;
  errors: Array<{ ligne: number; message: string }>;
}

const MAX_ROWS = 5000;
const empty = (v: unknown) => (typeof v === 'string' && v.trim() === '' ? undefined : v);
const t = (max = 200) => z.preprocess(empty, z.string().trim().min(1).max(max).optional());
const req = (max = 200) => z.string().trim().min(1).max(max);
const num = z.preprocess((v) => (typeof v === 'string' ? empty(v.replace(',', '.')) : v), z.coerce.number().optional());
const date = z.preprocess(empty, z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'format AAAA-MM-JJ').optional());

const sitesRow = z.object({
  reference: req(60), nom: req(), adresse: t(300), code_postal: t(20), ville: t(120), pays: t(2),
  latitude: num, longitude: num, surface_m2: num, usage: t(60), portefeuille: t(),
});
const locauxRow = z.object({
  site_reference: req(60), batiment: req(), niveau: req(), reference: t(60), nom: req(),
  type: z.preprocess(empty, z.enum(LOCAL_TYPES).optional()), surface_m2: num,
});
const occupationsRow = z.object({
  site_reference: req(60), local_reference: req(60), occupant: req(), type_occupant: z.preprocess(empty, z.enum(['societe', 'particulier']).optional()),
  debut: date, fin: date, contact_nom: t(), contact_email: z.preprocess(empty, z.string().email().optional()), contact_telephone: t(40),
});

/** Excel français exporte avec « ; » (la virgule sert de séparateur décimal) : on choisit d'après l'en-tête. */
export function detectDelimiter(csv: string): ',' | ';' | '\t' {
  const header = csv.replace(/^\uFEFF/, '').split(/\r?\n/, 1)[0] ?? '';
  const count = (ch: string) => header.split(ch).length - 1;
  const best = ([';', ',', '\t'] as const).reduce((a, b) => (count(b) > count(a) ? b : a));
  return best;
}

class Rollback extends Error { constructor(readonly report: ImportReport) { super('rollback'); } }

/**
 * Import CSV : validation complète (schéma + contraintes de la base) avec un point de sauvegarde par ligne,
 * rapport de TOUTES les erreurs, et validation tout-ou-rien. `dry_run` va jusqu'au bout puis annule.
 */
export class ImportService {
  constructor(private readonly db: TenantDb) {}

  async run(ctx: TenantContext, kind: ImportKind, csv: string, opts: { dryRun: boolean; ownerOrgId?: string }): Promise<ImportReport> {
    let records: Array<Record<string, string>>;
    try {
      records = parse(csv, { columns: (h: string[]) => h.map((x) => x.trim().toLowerCase()), skip_empty_lines: true, trim: true, bom: true, delimiter: detectDelimiter(csv) });
    } catch (err) {
      throw new AuthError('invalid_csv', 400, `CSV illisible : ${(err as Error).message}`);
    }
    if (records.length === 0) throw new AuthError('invalid_csv', 400, 'Fichier vide');
    if (records.length > MAX_ROWS) throw new AuthError('too_many_rows', 400, `Maximum ${MAX_ROWS} lignes par import`);
    const owner = opts.ownerOrgId ?? ctx.orgId;
    const report: ImportReport = { kind, dry_run: opts.dryRun, committed: false, rows: records.length, created: {}, errors: [] };
    const bump = (k: string) => { report.created[k] = (report.created[k] ?? 0) + 1; };

    try {
      await this.db.withTenant(ctx, async (c) => {
        const cache = new Map<string, string>();
        for (const [i, rec] of records.entries()) {
          const ligne = i + 2; // 1 = en-tête
          await c.query('SAVEPOINT ligne');
          try {
            if (kind === 'sites') await this.importSite(c, owner, rec, cache, bump);
            else if (kind === 'locaux') await this.importLocal(c, owner, rec, cache, bump);
            else await this.importOccupation(c, owner, ctx.orgId, rec, cache, bump);
            await c.query('RELEASE SAVEPOINT ligne');
          } catch (err) {
            await c.query('ROLLBACK TO SAVEPOINT ligne');
            cache.clear(); // des entrées en cache peuvent désigner des lignes annulées par le point de sauvegarde
            report.errors.push({ ligne, message: describe(err) });
          }
        }
        if (report.errors.length > 0 || opts.dryRun) throw new Rollback(report);
        report.committed = true;
      });
    } catch (err) {
      if (!(err instanceof Rollback)) throw err;
    }
    if (report.errors.length > 0) report.created = {};
    return report;
  }

  private async importSite(c: pg.PoolClient, owner: string, rec: Record<string, string>, cache: Map<string, string>, bump: (k: string) => void) {
    const r = sitesRow.parse(rec);
    let portefeuille_id: string | undefined;
    if (r.portefeuille) {
      const key = `pf:${r.portefeuille}`;
      portefeuille_id = cache.get(key) ?? (await c.query('SELECT id FROM portefeuille WHERE org_id = $1 AND nom = $2', [owner, r.portefeuille])).rows[0]?.id;
      if (!portefeuille_id) {
        portefeuille_id = (await insertRow(c, 'portefeuille', { org_id: owner, nom: r.portefeuille })).id as string;
        bump('portefeuilles');
      }
      cache.set(key, portefeuille_id);
    }
    const { portefeuille, ...rest } = r;
    void portefeuille;
    const site = await insertRow(c, 'site', { ...rest, pays: r.pays?.toUpperCase(), org_id: owner, portefeuille_id });
    cache.set(`site:${r.reference}`, site.id as string);
    bump('sites');
  }

  private async siteId(c: pg.PoolClient, owner: string, ref: string, cache: Map<string, string>): Promise<string> {
    const key = `site:${ref}`;
    const hit = cache.get(key);
    if (hit) return hit;
    const row = (await c.query('SELECT id FROM site WHERE org_id = $1 AND reference = $2 AND deleted_at IS NULL', [owner, ref])).rows[0];
    if (!row) throw new Error(`site « ${ref} » introuvable`);
    cache.set(key, row.id);
    return row.id as string;
  }

  private async importLocal(c: pg.PoolClient, owner: string, rec: Record<string, string>, cache: Map<string, string>, bump: (k: string) => void) {
    const r = locauxRow.parse(rec);
    const siteId = await this.siteId(c, owner, r.site_reference, cache);
    const bKey = `bat:${siteId}:${r.batiment}`;
    let batimentId = cache.get(bKey) ?? (await c.query('SELECT id FROM batiment WHERE site_id = $1 AND nom = $2 AND deleted_at IS NULL', [siteId, r.batiment])).rows[0]?.id;
    if (!batimentId) { batimentId = (await insertRow(c, 'batiment', { org_id: owner, site_id: siteId, nom: r.batiment })).id as string; bump('batiments'); }
    cache.set(bKey, batimentId);
    const nKey = `niv:${batimentId}:${r.niveau}`;
    let niveauId = cache.get(nKey) ?? (await c.query('SELECT id FROM niveau WHERE batiment_id = $1 AND nom = $2 AND deleted_at IS NULL', [batimentId, r.niveau])).rows[0]?.id;
    if (!niveauId) { niveauId = (await insertRow(c, 'niveau', { org_id: owner, site_id: siteId, batiment_id: batimentId, nom: r.niveau })).id as string; bump('niveaux'); }
    cache.set(nKey, niveauId);
    const local = await insertRow(c, 'local', {
      org_id: owner, site_id: siteId, niveau_id: niveauId, nom: r.nom, reference: r.reference, type: r.type, surface_m2: r.surface_m2, qr_code: randomToken(12),
    });
    cache.set(`loc:${siteId}:${r.reference ?? r.nom}`, local.id as string);
    bump('locaux');
  }

  private async importOccupation(c: pg.PoolClient, owner: string, creator: string, rec: Record<string, string>, cache: Map<string, string>, bump: (k: string) => void) {
    const r = occupationsRow.parse(rec);
    const siteId = await this.siteId(c, owner, r.site_reference, cache);
    const lKey = `loc:${siteId}:${r.local_reference}`;
    let localId = cache.get(lKey) ?? (await c.query('SELECT id FROM local WHERE site_id = $1 AND reference = $2 AND deleted_at IS NULL', [siteId, r.local_reference])).rows[0]?.id;
    if (!localId) throw new Error(`local « ${r.local_reference} » introuvable sur le site « ${r.site_reference} »`);
    cache.set(lKey, localId);
    const oKey = `occ:${r.occupant}`;
    let occupantId = cache.get(oKey) ?? (await c.query('SELECT id FROM occupant WHERE org_id = $1 AND nom = $2 AND deleted_at IS NULL', [owner, r.occupant])).rows[0]?.id;
    if (!occupantId) {
      occupantId = (await insertRow(c, 'occupant', { org_id: owner, cree_par_org_id: creator, nom: r.occupant, type: r.type_occupant })).id as string;
      bump('occupants');
    }
    cache.set(oKey, occupantId);
    if (r.contact_nom) {
      await insertRow(c, 'contact', { org_id: owner, occupant_id: occupantId, nom: r.contact_nom, email: r.contact_email, telephone: r.contact_telephone });
      bump('contacts');
    }
    await insertRow(c, 'occupation', { org_id: owner, site_id: siteId, local_id: localId, occupant_id: occupantId, debut: r.debut, fin: r.fin });
    bump('occupations');
  }
}

function describe(err: unknown): string {
  if (err instanceof z.ZodError) return err.issues.map((i) => `${i.path.join('.') || 'ligne'} : ${i.message}`).join(' ; ');
  const e = err as { code?: string; constraint?: string; message?: string };
  if (e.code === '23505') return `doublon (${e.constraint ?? 'unicité'})`;
  if (e.code === '23P01') return 'occupation qui chevauche une occupation existante du même occupant';
  if (e.code === '23503') return 'référence invalide';
  if (e.message?.includes('row-level security')) return 'accès refusé sur ce périmètre';
  return e.message ?? 'erreur inconnue';
}

export type { Row };

import type pg from 'pg';
import {
  type Calendrier, type CalendrierCalc, type Contrat, type ContratEntree, type Parametres,
  calendrierInputSchema, contratInputSchema, contratPatchSchema, parametresSchema,
} from '@nova/shared';
import { AuthError } from '../auth/errors.js';
import type { TenantContext, TenantDb } from '../db/tenant-db.js';

const notFound = (what: string) => new AuthError('not_found', 404, `${what} introuvable`);
const invalid = (msg: string) => new AuthError('validation_error', 400, msg);

function parse<T>(schema: { safeParse(v: unknown): { success: true; data: T } | { success: false; error: { issues: Array<{ path: PropertyKey[]; message: string }> } } }, input: unknown): T {
  const r = schema.safeParse(input ?? {});
  if (!r.success) throw invalid(r.error.issues.map((x) => `${x.path.map(String).join('.') || 'valeur'} : ${x.message}`).join(' ; '));
  return r.data;
}

const CALENDRIER_SQL = `
  SELECT k.id, k.nom, k.fuseau, k.plages,
         COALESCE((SELECT json_agg(json_build_object('du', to_char(f.du, 'YYYY-MM-DD'), 'au', to_char(f.au, 'YYYY-MM-DD'), 'libelle', f.libelle) ORDER BY f.du, f.au)
                     FROM calendrier_fermeture f WHERE f.calendrier_id = k.id), '[]'::json) AS fermetures
    FROM calendrier_ouvre k`;

const CONTRAT_SQL = `
  SELECT c.id, c.annuaire_id, a.nom AS prestataire_nom, c.libelle,
         to_char(c.date_debut, 'YYYY-MM-DD') AS date_debut, to_char(c.date_fin, 'YYYY-MM-DD') AS date_fin,
         c.statut, c.calendrier_id, c.notes, c.created_at,
         COALESCE((SELECT json_agg(json_build_object('site_id', p.site_id, 'famille_id', p.famille_id) ORDER BY p.site_id, p.famille_id NULLS FIRST)
                     FROM contrat_perimetre p WHERE p.contrat_id = c.id), '[]'::json) AS perimetre,
         COALESCE((SELECT json_agg(json_build_object('priorite', r.priorite, 'delai_prise_en_compte_min', r.delai_prise_en_compte_min,
                                                     'delai_resolution_min', r.delai_resolution_min, 'calendrier_id', r.calendrier_id) ORDER BY r.priorite)
                     FROM sla_regle r WHERE r.contrat_id = c.id), '[]'::json) AS regles
    FROM contrat_service c
    JOIN prestataire_annuaire a ON a.id = c.annuaire_id AND a.org_id = c.org_id`;

/** Contrats et calendriers de l'organisation courante, au format utilisé pour l'éligibilité et le SLA. */
export async function chargerPourSla(c: pg.PoolClient): Promise<{ contrats: ContratEntree[]; calendriers: Map<string, CalendrierCalc> }> {
  const contrats = (await c.query(`${CONTRAT_SQL} WHERE c.org_id = app.current_org()`)).rows as ContratEntree[];
  const cals = (await c.query(`${CALENDRIER_SQL} WHERE k.org_id = app.current_org()`)).rows as Calendrier[];
  return { contrats, calendriers: new Map(cals.map((k) => [k.id, { fuseau: k.fuseau, plages: k.plages, fermetures: k.fermetures }])) };
}

/** Calendriers, contrats de service, règles SLA et paramètres de dispatch (migration 0007). */
export class ContratsService {
  constructor(private readonly db: TenantDb) {}
  private run<T>(ctx: TenantContext, fn: (c: pg.PoolClient) => Promise<T>) { return this.db.withTenant(ctx, fn); }

  // --- Calendriers ------------------------------------------------------------------------------
  listCalendriers(ctx: TenantContext) {
    return this.run(ctx, async (c) => (await c.query(`${CALENDRIER_SQL} WHERE k.org_id = app.current_org() ORDER BY k.nom COLLATE "C"`)).rows as Calendrier[]);
  }

  private async fermetures(c: pg.PoolClient, orgId: string, id: string, liste: Array<{ du: string; au: string; libelle: string | null }>) {
    await c.query('DELETE FROM calendrier_fermeture WHERE calendrier_id = $1', [id]);
    for (const f of liste) {
      await c.query('INSERT INTO calendrier_fermeture (org_id, calendrier_id, du, au, libelle) VALUES ($1, $2, $3, $4, $5)', [orgId, id, f.du, f.au, f.libelle]);
    }
  }
  private async calendrier(c: pg.PoolClient, id: string): Promise<Calendrier> {
    const k = (await c.query(`${CALENDRIER_SQL} WHERE k.id = $1 AND k.org_id = app.current_org()`, [id])).rows[0] as Calendrier | undefined;
    if (!k) throw notFound('Calendrier');
    return k;
  }

  createCalendrier(ctx: TenantContext, input: unknown) {
    const i = parse(calendrierInputSchema, input);
    return this.run(ctx, async (c) => {
      const r = await c.query<{ id: string }>('INSERT INTO calendrier_ouvre (org_id, nom, fuseau, plages) VALUES ($1, $2, $3, $4::jsonb) RETURNING id', [ctx.orgId, i.nom, i.fuseau, JSON.stringify(i.plages)]);
      await this.fermetures(c, ctx.orgId, r.rows[0]!.id, i.fermetures);
      return this.calendrier(c, r.rows[0]!.id);
    });
  }

  updateCalendrier(ctx: TenantContext, id: string, input: unknown) {
    const i = parse(calendrierInputSchema, input);
    return this.run(ctx, async (c) => {
      const r = await c.query('UPDATE calendrier_ouvre SET nom = $1, fuseau = $2, plages = $3::jsonb WHERE id = $4 AND org_id = app.current_org() RETURNING id', [i.nom, i.fuseau, JSON.stringify(i.plages), id]);
      if (!r.rows[0]) throw notFound('Calendrier');
      await this.fermetures(c, ctx.orgId, id, i.fermetures);
      return this.calendrier(c, id);
    });
  }

  // --- Contrats ---------------------------------------------------------------------------------
  private async contrat(c: pg.PoolClient, id: string): Promise<Contrat> {
    const r = (await c.query(`${CONTRAT_SQL} WHERE c.id = $1 AND c.org_id = app.current_org()`, [id])).rows[0] as Contrat | undefined;
    if (!r) throw notFound('Contrat');
    return r;
  }

  listContrats(ctx: TenantContext, f: { annuaire_id?: string; statut?: string }, page: { limit: number; offset: number }) {
    return this.run(ctx, async (c) => (await c.query(
      `${CONTRAT_SQL} WHERE c.org_id = app.current_org() AND ($1::uuid IS NULL OR c.annuaire_id = $1) AND ($2::text IS NULL OR c.statut = $2)
        ORDER BY c.libelle COLLATE "C", c.id LIMIT $3 OFFSET $4`, [f.annuaire_id ?? null, f.statut ?? null, page.limit, page.offset])).rows as Contrat[]);
  }
  getContrat(ctx: TenantContext, id: string) { return this.run(ctx, (c) => this.contrat(c, id)); }

  /** Les clés étrangères ne passent pas par la RLS : on vérifie ici que tout ce qui est référencé appartient à l'organisation ou lui est visible. */
  private async verifier(c: pg.PoolClient, i: { annuaire_id?: string; calendrier_id?: string | null; perimetre?: Array<{ site_id: string; famille_id: string | null }>; regles?: Array<{ calendrier_id: string | null }> }) {
    if (i.annuaire_id !== undefined) {
      const ok = (await c.query('SELECT 1 FROM prestataire_annuaire WHERE id = $1 AND org_id = app.current_org() AND deleted_at IS NULL', [i.annuaire_id])).rows[0];
      if (!ok) throw invalid('annuaire_id : prestataire inconnu');
    }
    const cals = [...new Set([i.calendrier_id, ...(i.regles ?? []).map((r) => r.calendrier_id)].filter((x): x is string => !!x))];
    if (cals.length) {
      const n = (await c.query<{ n: number }>('SELECT count(*)::int AS n FROM calendrier_ouvre WHERE id = ANY($1::uuid[]) AND org_id = app.current_org()', [cals])).rows[0]!.n;
      if (n !== cals.length) throw invalid('calendrier_id : calendrier inconnu');
    }
    const sites = [...new Set((i.perimetre ?? []).map((p) => p.site_id))];
    if (sites.length) {
      const n = (await c.query<{ n: number }>('SELECT count(*)::int AS n FROM site WHERE id = ANY($1::uuid[]) AND deleted_at IS NULL', [sites])).rows[0]!.n;
      if (n !== sites.length) throw invalid('perimetre : site inconnu');
    }
    const familles = [...new Set((i.perimetre ?? []).map((p) => p.famille_id).filter((x): x is string => !!x))];
    if (familles.length) {
      const n = (await c.query<{ n: number }>('SELECT count(*)::int AS n FROM famille_ticket WHERE id = ANY($1::uuid[]) AND org_id = app.current_org()', [familles])).rows[0]!.n;
      if (n !== familles.length) throw invalid('perimetre : famille inconnue');
    }
  }

  private async remplacerPerimetre(c: pg.PoolClient, orgId: string, id: string, liste: Array<{ site_id: string; famille_id: string | null }>) {
    await c.query('DELETE FROM contrat_perimetre WHERE contrat_id = $1', [id]);
    for (const p of liste) await c.query('INSERT INTO contrat_perimetre (org_id, contrat_id, site_id, famille_id) VALUES ($1, $2, $3, $4)', [orgId, id, p.site_id, p.famille_id]);
  }
  private async remplacerRegles(c: pg.PoolClient, orgId: string, id: string, liste: Array<{ priorite: string; delai_prise_en_compte_min: number; delai_resolution_min: number; calendrier_id: string | null }>) {
    await c.query('DELETE FROM sla_regle WHERE contrat_id = $1', [id]);
    for (const r of liste) {
      await c.query('INSERT INTO sla_regle (org_id, contrat_id, priorite, delai_prise_en_compte_min, delai_resolution_min, calendrier_id) VALUES ($1, $2, $3, $4, $5, $6)',
        [orgId, id, r.priorite, r.delai_prise_en_compte_min, r.delai_resolution_min, r.calendrier_id]);
    }
  }

  createContrat(ctx: TenantContext, input: unknown) {
    const i = parse(contratInputSchema, input);
    return this.run(ctx, async (c) => {
      await this.verifier(c, i);
      const r = await c.query<{ id: string }>(
        `INSERT INTO contrat_service (org_id, annuaire_id, libelle, date_debut, date_fin, statut, calendrier_id, notes)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8) RETURNING id`,
        [ctx.orgId, i.annuaire_id, i.libelle, i.date_debut, i.date_fin, i.statut, i.calendrier_id, i.notes]);
      const id = r.rows[0]!.id;
      await this.remplacerPerimetre(c, ctx.orgId, id, i.perimetre);
      await this.remplacerRegles(c, ctx.orgId, id, i.regles);
      return this.contrat(c, id);
    });
  }

  updateContrat(ctx: TenantContext, id: string, input: unknown) {
    const p = parse(contratPatchSchema, input);
    return this.run(ctx, async (c) => {
      const actuel = await this.contrat(c, id);
      await this.verifier(c, p);
      const debut = p.date_debut ?? actuel.date_debut;
      const fin = p.date_fin === undefined ? actuel.date_fin : p.date_fin;
      if (fin !== null && fin < debut) throw invalid('date_fin : antérieure à la date de début');
      const champs: Array<[string, unknown]> = (['libelle', 'date_debut', 'date_fin', 'statut', 'calendrier_id', 'notes'] as const)
        .filter((k) => p[k] !== undefined).map((k) => [k, p[k]]);
      if (champs.length) {
        await c.query(`UPDATE contrat_service SET ${champs.map(([k], n) => `${k} = $${n + 1}`).join(', ')}, updated_at = now() WHERE id = $${champs.length + 1} AND org_id = app.current_org()`,
          [...champs.map(([, v]) => v), id]);
      }
      if (p.perimetre) await this.remplacerPerimetre(c, ctx.orgId, id, p.perimetre);
      if (p.regles) await this.remplacerRegles(c, ctx.orgId, id, p.regles);
      return this.contrat(c, id);
    });
  }

  // --- Paramètres -------------------------------------------------------------------------------
  getParametres(ctx: TenantContext) {
    return this.run(ctx, async (c) => {
      const r = (await c.query<Parametres>('SELECT exiger_contrat FROM organisation WHERE id = app.current_org()')).rows[0];
      return { exiger_contrat: r?.exiger_contrat ?? false };
    });
  }
  setParametres(ctx: TenantContext, input: unknown) {
    const i = parse(parametresSchema, input);
    return this.run(ctx, async (c) => {
      try {
        await c.query('SAVEPOINT parametres');
        await c.query('SELECT app.set_exiger_contrat($1)', [i.exiger_contrat]);
      } catch (err) {
        await c.query('ROLLBACK TO SAVEPOINT parametres');
        if ((err as { code?: string }).code === '42501') throw new AuthError('forbidden', 403, 'Réservé à un property manager');
        throw err;
      }
      return { exiger_contrat: i.exiger_contrat };
    });
  }
}

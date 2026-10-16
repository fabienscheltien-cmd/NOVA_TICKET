import type pg from 'pg';
import {
  FAMILLES_STANDARD, codeDepuisLibelle, type Famille, type Prestataire, type Selection, type Ticket, type TicketDetail,
  affectationInputSchema, famillePatchSchema, familleCreateSchema, prestataireInputSchema, prestatairePatchSchema, ticketCreateSchema,
} from '@nova/shared';
import { AuthError } from '../auth/errors.js';
import type { TenantContext, TenantDb } from '../db/tenant-db.js';
import { type Page, insertRow } from '../patrimoine/patrimoine.service.js';

type Row = Record<string, unknown>;
const notFound = (what: string) => new AuthError('not_found', 404, `${what} introuvable`);
const invalid = (msg: string) => new AuthError('validation_error', 400, msg);

const FAMILLE_SQL = `
  SELECT f.id, f.code, f.libelle, f.actif, f.ordre,
         (SELECT count(*)::int FROM prestataire_famille pf
            JOIN prestataire_annuaire a ON a.id = pf.annuaire_id AND a.deleted_at IS NULL
           WHERE pf.famille_id = f.id) AS nb_prestataires
    FROM famille_ticket f`;

const PRESTATAIRE_SQL = `
  SELECT a.id, a.nom, a.contact_nom, a.contact_email, a.contact_telephone, a.zone, a.statut,
         to_char(a.assurance_expire_le, 'YYYY-MM-DD') AS assurance_expire_le,
         a.prestataire_org_id, a.notes, a.created_at,
         COALESCE((SELECT json_agg(json_build_object('famille_id', pf.famille_id, 'priorite', pf.priorite) ORDER BY pf.priorite, pf.famille_id)
                     FROM prestataire_famille pf WHERE pf.annuaire_id = a.id), '[]'::json) AS familles
    FROM prestataire_annuaire a`;

const TICKET_SQL = `
  SELECT t.id, t.titre, t.description, t.famille_id, f.libelle AS famille_libelle, t.site_id, s.nom AS site_nom,
         t.local_id, l.nom AS local_nom, t.priorite, t.statut, t.created_at, af.prestataire_nom AS prestataire_actuel
    FROM ticket t
    LEFT JOIN famille_ticket f ON f.id = t.famille_id
    LEFT JOIN site s ON s.id = t.site_id
    LEFT JOIN local l ON l.id = t.local_id
    LEFT JOIN affectation_ticket af ON af.ticket_id = t.id AND af.fin_at IS NULL`;

/** Familles de tickets, annuaire des prestataires, création de tickets et affectation (voir migration 0004). */
export class DispatchService {
  constructor(private readonly db: TenantDb) {}

  private run<T>(ctx: TenantContext, fn: (c: pg.PoolClient) => Promise<T>) { return this.db.withTenant(ctx, fn); }

  // --- Familles ---------------------------------------------------------------------------------
  private listFamillesTx(c: pg.PoolClient): Promise<Famille[]> {
    return c.query(`${FAMILLE_SQL} WHERE f.org_id = app.current_org() ORDER BY f.ordre, f.libelle COLLATE "C"`).then((r) => r.rows as Famille[]);
  }
  listFamilles(ctx: TenantContext) { return this.run(ctx, (c) => this.listFamillesTx(c)); }

  createFamille(ctx: TenantContext, input: unknown) {
    const { libelle } = this.parse(familleCreateSchema, input);
    const code = codeDepuisLibelle(libelle);
    if (!code) throw invalid('libelle : doit contenir des lettres ou des chiffres');
    return this.run(ctx, async (c) => {
      const ordre = (await c.query<{ n: number }>('SELECT COALESCE(max(ordre), 0)::int + 10 AS n FROM famille_ticket WHERE org_id = $1', [ctx.orgId])).rows[0]!.n;
      const f = await insertRow(c, 'famille_ticket', { org_id: ctx.orgId, code, libelle, ordre });
      return (await c.query(`${FAMILLE_SQL} WHERE f.id = $1`, [f.id])).rows[0] as Famille;
    });
  }

  updateFamille(ctx: TenantContext, id: string, input: unknown) {
    const p = this.parse(famillePatchSchema, input);
    return this.run(ctx, async (c) => {
      const keys = Object.keys(p);
      const r = await c.query(
        `UPDATE famille_ticket SET ${keys.map((k, i) => `${k} = $${i + 1}`).join(', ')} WHERE id = $${keys.length + 1} AND org_id = app.current_org() RETURNING id`,
        [...keys.map((k) => (p as Row)[k]), id]);
      if (!r.rows[0]) throw notFound('Famille');
      return (await c.query(`${FAMILLE_SQL} WHERE f.id = $1`, [id])).rows[0] as Famille;
    });
  }

  importFamillesStandard(ctx: TenantContext) {
    return this.run(ctx, async (c) => {
      await seedFamillesStandard(c, ctx.orgId);
      return this.listFamillesTx(c);
    });
  }

  // --- Annuaire ---------------------------------------------------------------------------------
  listPrestataires(ctx: TenantContext, f: { q?: string; famille_id?: string; statut?: string }, page: Page) {
    return this.run(ctx, async (c) => (await c.query(
      `${PRESTATAIRE_SQL}
        WHERE a.org_id = app.current_org() AND a.deleted_at IS NULL
          AND ($1::text IS NULL OR a.statut = $1)
          AND ($2::uuid IS NULL OR EXISTS (SELECT 1 FROM prestataire_famille pf WHERE pf.annuaire_id = a.id AND pf.famille_id = $2))
          AND ($3::text IS NULL OR a.nom ILIKE '%' || $3 || '%' OR a.contact_nom ILIKE '%' || $3 || '%' OR a.zone ILIKE '%' || $3 || '%')
        ORDER BY a.nom COLLATE "C" LIMIT $4 OFFSET $5`,
      [f.statut ?? null, f.famille_id ?? null, f.q ?? null, page.limit, page.offset])).rows as Prestataire[]);
  }

  private async prestataire(c: pg.PoolClient, id: string): Promise<Prestataire> {
    const r = await c.query(`${PRESTATAIRE_SQL} WHERE a.id = $1 AND a.org_id = app.current_org() AND a.deleted_at IS NULL`, [id]);
    if (!r.rows[0]) throw notFound('Prestataire');
    return r.rows[0] as Prestataire;
  }
  getPrestataire(ctx: TenantContext, id: string) { return this.run(ctx, (c) => this.prestataire(c, id)); }

  private async remplacerReferencements(c: pg.PoolClient, orgId: string, annuaireId: string, familles: Array<{ famille_id: string; priorite: number }>) {
    await c.query('DELETE FROM prestataire_famille WHERE annuaire_id = $1', [annuaireId]);
    for (const r of familles) {
      await c.query('INSERT INTO prestataire_famille (org_id, annuaire_id, famille_id, priorite) VALUES ($1, $2, $3, $4)', [orgId, annuaireId, r.famille_id, r.priorite]);
    }
  }

  createPrestataire(ctx: TenantContext, input: unknown) {
    const { familles, ...p } = this.parse(prestataireInputSchema, input);
    return this.run(ctx, async (c) => {
      const a = await insertRow(c, 'prestataire_annuaire', { ...p, org_id: ctx.orgId });
      await this.remplacerReferencements(c, ctx.orgId, a.id as string, familles);
      return this.prestataire(c, a.id as string);
    });
  }

  updatePrestataire(ctx: TenantContext, id: string, input: unknown) {
    const parsed = this.parse(prestatairePatchSchema, input);
    const given = (input ?? {}) as Row;
    // zod applique les valeurs par défaut aux champs absents : on ne retient que ceux réellement fournis
    const { familles, ...champs } = Object.fromEntries(Object.entries(parsed).filter(([k]) => given[k] !== undefined)) as Row & { familles?: Array<{ famille_id: string; priorite: number }> };
    return this.run(ctx, async (c) => {
      await this.prestataire(c, id);
      const keys = Object.keys(champs);
      if (keys.length) {
        await c.query(`UPDATE prestataire_annuaire SET ${keys.map((k, i) => `${k} = $${i + 1}`).join(', ')} WHERE id = $${keys.length + 1} AND org_id = app.current_org()`,
          [...keys.map((k) => champs[k]), id]);
      }
      if (familles) await this.remplacerReferencements(c, ctx.orgId, id, familles);
      return this.prestataire(c, id);
    });
  }

  setStatutPrestataire(ctx: TenantContext, id: string, statut: 'actif' | 'suspendu') {
    return this.run(ctx, async (c) => {
      const r = await c.query('UPDATE prestataire_annuaire SET statut = $1 WHERE id = $2 AND org_id = app.current_org() AND deleted_at IS NULL RETURNING id', [statut, id]);
      if (!r.rows[0]) throw notFound('Prestataire');
      return this.prestataire(c, id);
    });
  }

  // --- Tickets ----------------------------------------------------------------------------------
  listTickets(ctx: TenantContext, f: { statut?: string; famille_id?: string }, page: Page) {
    return this.run(ctx, async (c) => (await c.query(
      `${TICKET_SQL} WHERE ($1::text IS NULL OR t.statut = $1) AND ($2::uuid IS NULL OR t.famille_id = $2)
        ORDER BY t.created_at DESC, t.id LIMIT $3 OFFSET $4`,
      [f.statut ?? null, f.famille_id ?? null, page.limit, page.offset])).rows as Ticket[]);
  }

  private async selection(c: pg.PoolClient, ticketId: string): Promise<Selection> {
    const rows = (await c.query('SELECT annuaire_id, nom, priorite, eligible, raison FROM app.prestataires_eligibles($1)', [ticketId])).rows as Selection['eligibles'];
    return { eligibles: rows, suggere: rows.find((r) => r.eligible)?.annuaire_id ?? null };
  }

  private async detail(c: pg.PoolClient, ticketId: string): Promise<TicketDetail> {
    const t = (await c.query(`${TICKET_SQL} WHERE t.id = $1`, [ticketId])).rows[0] as Ticket | undefined;
    if (!t) throw notFound('Ticket');
    const historique = (await c.query(
      `SELECT id, annuaire_id, prestataire_nom, affecte_at, fin_at, motif FROM affectation_ticket
        WHERE ticket_id = $1 ORDER BY affecte_at DESC, rang DESC`, [ticketId])).rows as TicketDetail['historique'];
    return { ...t, historique, selection: await this.selection(c, ticketId) };
  }
  getTicket(ctx: TenantContext, id: string) { return this.run(ctx, (c) => this.detail(c, id)); }

  /** Crée le ticket ; sa famille détermine immédiatement les prestataires éligibles (renvoyés dans le détail). */
  createTicket(ctx: TenantContext, input: unknown) {
    const i = this.parse(ticketCreateSchema, input);
    return this.run(ctx, async (c) => {
      const site = (await c.query<{ org_id: string }>('SELECT org_id FROM site WHERE id = $1 AND deleted_at IS NULL', [i.site_id])).rows[0];
      if (!site) throw invalid('site_id : site inconnu');
      const famille = (await c.query<{ actif: boolean }>('SELECT actif FROM famille_ticket WHERE id = $1 AND org_id = app.current_org()', [i.famille_id])).rows[0];
      if (!famille) throw invalid('famille_id : famille inconnue');
      if (!famille.actif) throw invalid('famille_id : cette famille est désactivée');
      if (i.local_id) {
        const ok = (await c.query('SELECT 1 FROM local WHERE id = $1 AND site_id = $2 AND deleted_at IS NULL', [i.local_id, i.site_id])).rows[0];
        if (!ok) throw invalid('local_id : ce local n\'appartient pas au site');
      }
      const t = await insertRow(c, 'ticket', {
        owner_org_id: site.org_id, managing_org_id: site.org_id === ctx.orgId ? null : ctx.orgId,
        site_id: i.site_id, local_id: i.local_id, famille_id: i.famille_id, titre: i.titre, description: i.description, priorite: i.priorite,
      });
      return this.detail(c, t.id as string);
    });
  }

  affecter(ctx: TenantContext, ticketId: string, input: unknown) {
    const i = this.parse(affectationInputSchema, input);
    return this.run(ctx, async (c) => {
      if (!(await c.query('SELECT 1 FROM ticket WHERE id = $1', [ticketId])).rows[0]) throw notFound('Ticket');
      await c.query('SAVEPOINT affecter');
      try {
        await c.query('SELECT app.affecter_ticket($1, $2, $3)', [ticketId, i.annuaire_id, i.motif]);
      } catch (err) {
        await c.query('ROLLBACK TO SAVEPOINT affecter');
        const e = err as { code?: string; message?: string; detail?: string };
        if (e.code === 'NV001') throw new AuthError('non_eligible', 422, e.message, { raison: e.detail });
        if (e.code === 'NV002') throw new AuthError('deja_affecte', 409, e.message);
        if (e.code === 'NV003') throw new AuthError('statut_incompatible', 409, e.message);
        if (e.code === '42501') throw notFound('Ticket');
        throw err;
      }
      return this.detail(c, ticketId);
    });
  }

  private parse<S extends { safeParse(v: unknown): { success: true; data: unknown } | { success: false; error: { issues: Array<{ path: PropertyKey[]; message: string }> } } }>(
    schema: S, input: unknown): S extends { safeParse(v: unknown): { success: true; data: infer D } | { success: false; error: unknown } } ? D : never {
    const r = schema.safeParse(input ?? {});
    if (!r.success) throw invalid(r.error.issues.map((x) => `${x.path.map(String).join('.') || 'valeur'} : ${x.message}`).join(' ; '));
    return r.data as never;
  }
}

/** Ajoute les familles standard manquantes pour une organisation (idempotent). */
export async function seedFamillesStandard(c: pg.PoolClient | pg.Client, orgId: string): Promise<void> {
  for (const [i, f] of FAMILLES_STANDARD.entries()) {
    await c.query('INSERT INTO famille_ticket (org_id, code, libelle, ordre) VALUES ($1, $2, $3, $4) ON CONFLICT (org_id, code) DO NOTHING', [orgId, f.code, f.libelle, (i + 1) * 10]);
  }
}

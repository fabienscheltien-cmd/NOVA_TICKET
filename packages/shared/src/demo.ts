import { type DemoData, type FamilleRow, type PrestataireRow, type TicketRow, creerDonneesDemo } from './demo-data.js';
import { aujourdhuiParis, evaluerEligibilite } from './eligibilite.js';
import { FAMILLES_STANDARD, codeDepuisLibelle } from './familles.js';
import { RepositoryError, type PrestataireFilters, type Repository, type TicketFilters } from './repository.js';
import {
  type AffectationInput, type FamilleCreate, type FamillePatch, type PrestataireInput, type PrestatairePatch, type TicketCreate,
  affectationInputSchema, familleCreateSchema, famillePatchSchema, prestataireInputSchema, prestatairePatchSchema, ticketCreateSchema,
} from './schemas.js';
import type { Affectation, Famille, Local, Prestataire, Site, StatutPrestataire, Ticket, TicketDetail } from './types.js';
import { z } from 'zod';

export interface DemoOptions {
  seed?: DemoData;
  /** Latence simulée (ms) pour que les états de chargement soient visibles dans la console. */
  latencyMs?: number;
  today?: () => string;
  now?: () => Date;
  uuid?: () => string;
}

const clone = <T>(v: T): T => JSON.parse(JSON.stringify(v)) as T;
const cmp = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);
const STATUTS_AFFECTABLES = ['nouveau', 'qualifie', 'affecte'];

function parse<S extends z.ZodTypeAny>(schema: S, input: unknown): z.output<S> {
  const r = schema.safeParse(input);
  if (!r.success) throw new RepositoryError('validation', r.error.issues.map((i) => `${i.path.join('.') || 'valeur'} : ${i.message}`).join(' ; '), r.error.issues);
  return r.data;
}

/** Implémentation en mémoire : mêmes règles que l'API (éligibilité, statuts, conflits), données de démonstration. */
export class DemoRepository implements Repository {
  readonly mode = 'demo' as const;
  private data: DemoData;
  private readonly today: () => string;
  private readonly now: () => Date;
  private readonly newId: () => string;

  constructor(private readonly opts: DemoOptions = {}) {
    this.now = opts.now ?? (() => new Date());
    this.today = opts.today ?? (() => aujourdhuiParis(this.now()));
    this.newId = opts.uuid ?? (() => crypto.randomUUID());
    this.data = clone(opts.seed ?? creerDonneesDemo(this.today()));
  }

  /** Remet le jeu de démonstration d'origine. */
  reset(): void {
    this.data = clone(this.opts.seed ?? creerDonneesDemo(this.today()));
  }

  private async tick(): Promise<void> {
    if (this.opts.latencyMs) await new Promise((r) => setTimeout(r, this.opts.latencyMs));
  }

  // --- Familles ---------------------------------------------------------------------------------
  private familleVue(f: FamilleRow): Famille {
    return { ...f, nb_prestataires: this.data.prestataires.filter((p) => p.familles.some((r) => r.famille_id === f.id)).length };
  }
  private famille(id: string): FamilleRow {
    const f = this.data.familles.find((x) => x.id === id);
    if (!f) throw new RepositoryError('not_found', 'Famille introuvable');
    return f;
  }

  async listFamilles(): Promise<Famille[]> {
    await this.tick();
    return [...this.data.familles].sort((a, b) => a.ordre - b.ordre || cmp(a.libelle, b.libelle)).map((f) => this.familleVue(f));
  }
  async createFamille(input: FamilleCreate): Promise<Famille> {
    await this.tick();
    const { libelle } = parse(familleCreateSchema, input);
    const code = codeDepuisLibelle(libelle);
    if (!code) throw new RepositoryError('validation', 'libellé : doit contenir des lettres ou des chiffres');
    if (this.data.familles.some((f) => f.code === code)) throw new RepositoryError('conflict', 'Une famille de même nom existe déjà');
    const ordre = Math.max(0, ...this.data.familles.map((f) => f.ordre)) + 10;
    const row: FamilleRow = { id: this.newId(), code, libelle, actif: true, ordre };
    this.data.familles.push(row);
    return this.familleVue(row);
  }
  async updateFamille(id: string, patch: FamillePatch): Promise<Famille> {
    await this.tick();
    const p = parse(famillePatchSchema, patch);
    const f = this.famille(id);
    Object.assign(f, p);
    return this.familleVue(f);
  }
  async importFamillesStandard(): Promise<Famille[]> {
    await this.tick();
    FAMILLES_STANDARD.forEach((s, i) => {
      if (!this.data.familles.some((f) => f.code === s.code)) {
        this.data.familles.push({ id: this.newId(), code: s.code, libelle: s.libelle, actif: true, ordre: (i + 1) * 10 });
      }
    });
    return this.listFamilles();
  }

  // --- Annuaire ---------------------------------------------------------------------------------
  private prestataireVue(p: PrestataireRow): Prestataire {
    return clone({ ...p, familles: [...p.familles].sort((a, b) => a.priorite - b.priorite || cmp(a.famille_id, b.famille_id)) });
  }
  private prestataire(id: string): PrestataireRow {
    const p = this.data.prestataires.find((x) => x.id === id);
    if (!p) throw new RepositoryError('not_found', 'Prestataire introuvable');
    return p;
  }
  private verifierFamilles(familles: Array<{ famille_id: string }>): void {
    for (const r of familles) {
      if (!this.data.familles.some((f) => f.id === r.famille_id)) throw new RepositoryError('validation', 'familles : famille inconnue');
    }
  }
  /** Démonstration uniquement : simule l'acceptation de l'invitation par le prestataire. */
  simulerAcceptation(id: string, orgId: string = this.newId()): void {
    const row = this.prestataire(id);
    if (this.data.prestataires.some((p) => p.prestataire_org_id === orgId && p.id !== id)) {
      throw new RepositoryError('conflict', 'Ce compte prestataire est déjà dans l\'annuaire');
    }
    row.prestataire_org_id = orgId;
  }

  async listPrestataires(filters: PrestataireFilters = {}): Promise<Prestataire[]> {
    await this.tick();
    const q = filters.q?.trim().toLowerCase();
    return this.data.prestataires
      .filter((p) => !filters.statut || p.statut === filters.statut)
      .filter((p) => !filters.famille_id || p.familles.some((r) => r.famille_id === filters.famille_id))
      .filter((p) => !q || [p.nom, p.contact_nom, p.zone].some((v) => v?.toLowerCase().includes(q)))
      .sort((a, b) => cmp(a.nom, b.nom))
      .map((p) => this.prestataireVue(p));
  }
  async getPrestataire(id: string): Promise<Prestataire> {
    await this.tick();
    return this.prestataireVue(this.prestataire(id));
  }
  async createPrestataire(input: PrestataireInput): Promise<Prestataire> {
    await this.tick();
    const i = parse(prestataireInputSchema, input);
    this.verifierFamilles(i.familles);
    const row: PrestataireRow = {
      id: this.newId(), ...i, prestataire_org_id: null, invitation_email: null, invitation_envoyee_le: null, created_at: this.now().toISOString(),
    };
    this.data.prestataires.push(row);
    return this.prestataireVue(row);
  }
  async updatePrestataire(id: string, patch: PrestatairePatch): Promise<Prestataire> {
    await this.tick();
    const raw = parse(prestatairePatchSchema, patch);
    const given = patch as Record<string, unknown>;
    // zod applique les valeurs par défaut aux champs absents : on ne retient que ceux réellement fournis
    const p = Object.fromEntries(Object.entries(raw).filter(([k]) => given[k] !== undefined)) as Partial<PrestataireRow>;
    const row = this.prestataire(id);
    if (p.familles) this.verifierFamilles(p.familles);
    Object.assign(row, p);
    return this.prestataireVue(row);
  }
  async inviterPrestataire(id: string, email: string): Promise<Prestataire> {
    await this.tick();
    const e = parse(z.string().trim().email('adresse invalide').max(254), email).toLowerCase();
    const row = this.prestataire(id);
    if (row.prestataire_org_id) throw new RepositoryError('conflict', 'Ce prestataire a déjà un compte rattaché');
    row.invitation_email = e;
    row.invitation_envoyee_le = this.now().toISOString();
    return this.prestataireVue(row);
  }
  async setStatutPrestataire(id: string, statut: StatutPrestataire): Promise<Prestataire> {
    await this.tick();
    if (statut !== 'actif' && statut !== 'suspendu') throw new RepositoryError('validation', 'statut : valeur inconnue');
    const row = this.prestataire(id);
    row.statut = statut;
    return this.prestataireVue(row);
  }

  // --- Sites et locaux --------------------------------------------------------------------------
  async listSites(): Promise<Site[]> {
    await this.tick();
    return clone(this.data.sites).sort((a, b) => cmp(a.nom, b.nom));
  }
  async listLocaux(siteId: string): Promise<Local[]> {
    await this.tick();
    return clone(this.data.locaux.filter((l) => l.site_id === siteId)).sort((a, b) => cmp(a.nom, b.nom));
  }

  // --- Tickets ----------------------------------------------------------------------------------
  private ticketVue(t: TicketRow): Ticket {
    const actuelle = this.data.affectations.find((a) => a.ticket_id === t.id && a.fin_at === null);
    return {
      id: t.id, titre: t.titre, description: t.description, famille_id: t.famille_id,
      famille_libelle: this.data.familles.find((f) => f.id === t.famille_id)?.libelle ?? null,
      site_id: t.site_id, site_nom: this.data.sites.find((s) => s.id === t.site_id)?.nom ?? null,
      local_id: t.local_id, local_nom: this.data.locaux.find((l) => l.id === t.local_id)?.nom ?? null,
      priorite: t.priorite, statut: t.statut, created_at: t.created_at, prestataire_actuel: actuelle?.prestataire_nom ?? null,
    };
  }
  private detail(t: TicketRow): TicketDetail {
    const historique: Affectation[] = this.data.affectations
      .filter((a) => a.ticket_id === t.id)
      .reverse() // à horodatage égal, la plus récemment insérée passe devant (tri stable)
      .sort((a, b) => cmp(b.affecte_at, a.affecte_at))
      .map((a) => ({ id: a.id, annuaire_id: a.annuaire_id, prestataire_nom: a.prestataire_nom, affecte_at: a.affecte_at, fin_at: a.fin_at, motif: a.motif }));
    return { ...this.ticketVue(t), historique, selection: evaluerEligibilite(t.famille_id, this.data.prestataires, this.today()) };
  }
  private ticket(id: string): TicketRow {
    const t = this.data.tickets.find((x) => x.id === id);
    if (!t) throw new RepositoryError('not_found', 'Ticket introuvable');
    return t;
  }

  async listTickets(filters: TicketFilters = {}): Promise<Ticket[]> {
    await this.tick();
    return this.data.tickets
      .filter((t) => !filters.statut || t.statut === filters.statut)
      .filter((t) => !filters.famille_id || t.famille_id === filters.famille_id)
      .sort((a, b) => cmp(b.created_at, a.created_at) || cmp(a.id, b.id))
      .map((t) => this.ticketVue(t));
  }
  async createTicket(input: TicketCreate): Promise<TicketDetail> {
    await this.tick();
    const i = parse(ticketCreateSchema, input);
    const famille = this.data.familles.find((f) => f.id === i.famille_id);
    if (!famille) throw new RepositoryError('validation', 'famille_id : famille inconnue');
    if (!famille.actif) throw new RepositoryError('validation', 'famille_id : cette famille est désactivée');
    if (!this.data.sites.some((s) => s.id === i.site_id)) throw new RepositoryError('validation', 'site_id : site inconnu');
    if (i.local_id && !this.data.locaux.some((l) => l.id === i.local_id && l.site_id === i.site_id)) {
      throw new RepositoryError('validation', 'local_id : ce local n\'appartient pas au site');
    }
    const row: TicketRow = { id: this.newId(), ...i, statut: 'nouveau', created_at: this.now().toISOString() };
    this.data.tickets.push(row);
    return this.detail(row);
  }
  async getTicket(id: string): Promise<TicketDetail> {
    await this.tick();
    return this.detail(this.ticket(id));
  }
  async affecter(ticketId: string, input: AffectationInput): Promise<TicketDetail> {
    await this.tick();
    const i = parse(affectationInputSchema, input);
    const t = this.ticket(ticketId);
    if (!STATUTS_AFFECTABLES.includes(t.statut)) throw new RepositoryError('statut_incompatible', `Un ticket « ${t.statut} » ne peut plus être affecté`);
    const ligne = evaluerEligibilite(t.famille_id, this.data.prestataires, this.today()).eligibles.find((e) => e.annuaire_id === i.annuaire_id);
    if (!ligne) throw new RepositoryError('non_eligible', 'Ce prestataire n\'est pas référencé sur la famille du ticket', { raison: 'famille_non_referencee' });
    if (!ligne.eligible) throw new RepositoryError('non_eligible', 'Ce prestataire n\'est pas éligible', { raison: ligne.raison });
    const actuelle = this.data.affectations.find((a) => a.ticket_id === t.id && a.fin_at === null);
    if (actuelle?.annuaire_id === i.annuaire_id) throw new RepositoryError('deja_affecte', 'Ce prestataire est déjà affecté à ce ticket');
    const maintenant = this.now().toISOString();
    if (actuelle) actuelle.fin_at = maintenant;
    this.data.affectations.push({
      id: this.newId(), ticket_id: t.id, annuaire_id: ligne.annuaire_id, prestataire_nom: ligne.nom, affecte_at: maintenant, fin_at: null, motif: i.motif,
    });
    t.statut = 'affecte';
    return this.detail(t);
  }
}

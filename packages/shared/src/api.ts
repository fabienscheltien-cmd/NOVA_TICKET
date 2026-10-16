import type { AffectationInput, FamilleCreate, FamillePatch, PrestataireInput, PrestatairePatch, TicketCreate } from './schemas.js';
import { type ErrorCode, RepositoryError, type PrestataireFilters, type Repository, type TicketFilters } from './repository.js';
import type { Famille, Local, Prestataire, Site, StatutPrestataire, Ticket, TicketDetail } from './types.js';

export interface ApiOptions {
  baseUrl: string;
  /** Jeton d'accès rattaché à l'espace de travail actif (voir POST /me/workspace/switch). */
  getToken: () => string | Promise<string>;
  fetchImpl?: typeof fetch;
}

const PASS_THROUGH: ErrorCode[] = ['not_found', 'conflict', 'forbidden', 'unauthorized', 'non_eligible', 'deja_affecte', 'statut_incompatible'];

function codeDepuis(status: number, error: unknown): ErrorCode {
  if (typeof error === 'string' && (PASS_THROUGH as string[]).includes(error)) return error as ErrorCode;
  if (error === 'validation_error') return 'validation';
  if (status === 400) return 'validation';
  if (status === 401) return 'unauthorized';
  if (status === 403) return 'forbidden';
  if (status === 404) return 'not_found';
  if (status === 409) return 'conflict';
  return 'unknown';
}

/** Implémentation REST de Repository. Les routes correspondent à docs/phase1/07-api.md (section annuaire et affectation). */
export class ApiRepository implements Repository {
  readonly mode = 'api' as const;
  private readonly fetchImpl: typeof fetch;

  constructor(private readonly opts: ApiOptions) {
    this.fetchImpl = opts.fetchImpl ?? ((...a) => fetch(...a));
  }

  private async call<T>(method: string, path: string, body?: unknown): Promise<T> {
    let res: Response;
    try {
      res = await this.fetchImpl(this.opts.baseUrl.replace(/\/$/, '') + path, {
        method,
        headers: { authorization: `Bearer ${await this.opts.getToken()}`, ...(body !== undefined ? { 'content-type': 'application/json' } : {}) },
        body: body === undefined ? undefined : JSON.stringify(body),
      });
    } catch (err) {
      throw new RepositoryError('network', 'Le serveur est injoignable', err);
    }
    const text = await res.text();
    const json = text ? (JSON.parse(text) as Record<string, unknown>) : null;
    if (!res.ok) {
      throw new RepositoryError(codeDepuis(res.status, json?.error), typeof json?.message === 'string' ? json.message : `Erreur ${res.status}`, json);
    }
    return json as T;
  }

  private qs(params: Record<string, string | number | undefined>): string {
    const e = Object.entries(params).filter(([, v]) => v !== undefined && v !== '');
    return e.length ? `?${new URLSearchParams(e.map(([k, v]) => [k, String(v)]))}` : '';
  }

  async listFamilles() { return (await this.call<{ items: Famille[] }>('GET', '/familles')).items; }
  createFamille(input: FamilleCreate) { return this.call<Famille>('POST', '/familles', input); }
  updateFamille(id: string, patch: FamillePatch) { return this.call<Famille>('PATCH', `/familles/${id}`, patch); }
  async importFamillesStandard() { return (await this.call<{ items: Famille[] }>('POST', '/familles/defaults')).items; }

  async listPrestataires(f: PrestataireFilters = {}) {
    return (await this.call<{ items: Prestataire[] }>('GET', `/annuaire${this.qs({ q: f.q, famille_id: f.famille_id, statut: f.statut, limit: 500 })}`)).items;
  }
  getPrestataire(id: string) { return this.call<Prestataire>('GET', `/annuaire/${id}`); }
  createPrestataire(input: PrestataireInput) { return this.call<Prestataire>('POST', '/annuaire', input); }
  updatePrestataire(id: string, patch: PrestatairePatch) { return this.call<Prestataire>('PATCH', `/annuaire/${id}`, patch); }
  inviterPrestataire(id: string, email: string) { return this.call<Prestataire>('POST', `/annuaire/${id}/invitation`, { email }); }
  setStatutPrestataire(id: string, statut: StatutPrestataire) { return this.call<Prestataire>('POST', `/annuaire/${id}/statut`, { statut }); }

  async listSites(): Promise<Site[]> {
    return (await this.call<{ items: Array<{ id: string; nom: string }> }>('GET', '/sites?limit=500')).items.map((s) => ({ id: s.id, nom: s.nom }));
  }
  async listLocaux(siteId: string): Promise<Local[]> {
    return (await this.call<{ items: Array<{ id: string; nom: string; site_id: string }> }>('GET', `/locaux${this.qs({ site_id: siteId, limit: 500 })}`)).items
      .map((l) => ({ id: l.id, nom: l.nom, site_id: l.site_id }));
  }

  async listTickets(f: TicketFilters = {}) {
    return (await this.call<{ items: Ticket[] }>('GET', `/tickets${this.qs({ statut: f.statut, famille_id: f.famille_id, limit: 500 })}`)).items;
  }
  createTicket(input: TicketCreate) { return this.call<TicketDetail>('POST', '/tickets', input); }
  getTicket(id: string) { return this.call<TicketDetail>('GET', `/tickets/${id}`); }
  affecter(ticketId: string, input: AffectationInput) { return this.call<TicketDetail>('POST', `/tickets/${ticketId}/affectation`, input); }
}

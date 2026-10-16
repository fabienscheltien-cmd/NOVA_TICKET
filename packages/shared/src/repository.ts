import type {
  AffectationInput, CalendrierInput, ContratInput, ContratPatch, FamilleCreate, FamillePatch, ParametresInput, PrestataireInput, PrestatairePatch, TicketCreate,
} from './schemas.js';
import type { Calendrier, Contrat, Famille, Local, Parametres, Prestataire, Site, StatutPrestataire, StatutTicket, Ticket, TicketDetail } from './types.js';

export type ErrorCode =
  | 'validation' | 'not_found' | 'conflict' | 'forbidden' | 'unauthorized'
  | 'non_eligible' | 'deja_affecte' | 'statut_incompatible' | 'network' | 'unknown';

export class RepositoryError extends Error {
  constructor(readonly code: ErrorCode, message: string, readonly details?: unknown) {
    super(message);
    this.name = 'RepositoryError';
  }
}

export interface PrestataireFilters { q?: string; famille_id?: string; statut?: StatutPrestataire }
export interface ContratFilters { annuaire_id?: string; statut?: 'actif' | 'suspendu' }
export interface TicketFilters { statut?: StatutTicket; famille_id?: string }

/**
 * Seule porte d'accès aux données pour la console. Deux implémentations interchangeables :
 * DemoRepository (mémoire, données de démonstration) et ApiRepository (API REST). Une suite de tests
 * de contrat commune garantit qu'elles se comportent de la même façon.
 */
export interface Repository {
  readonly mode: 'demo' | 'api';

  listFamilles(): Promise<Famille[]>;
  createFamille(input: FamilleCreate): Promise<Famille>;
  updateFamille(id: string, patch: FamillePatch): Promise<Famille>;
  /** Ajoute les familles standard manquantes (idempotent). */
  importFamillesStandard(): Promise<Famille[]>;

  listPrestataires(filters?: PrestataireFilters): Promise<Prestataire[]>;
  getPrestataire(id: string): Promise<Prestataire>;
  createPrestataire(input: PrestataireInput): Promise<Prestataire>;
  /** Si `familles` est fourni, il REMPLACE l'ensemble des référencements. */
  updatePrestataire(id: string, patch: PrestatairePatch): Promise<Prestataire>;
  setStatutPrestataire(id: string, statut: StatutPrestataire): Promise<Prestataire>;
  /**
   * Invite le prestataire à créer son compte NOVA (e-mail simulé tant que le prestataire d'envoi n'est pas choisi).
   * Le rattachement (`prestataire_org_id`) n'est posé qu'à l'acceptation, jamais ici. Refusé si déjà rattaché.
   */
  inviterPrestataire(id: string, email: string): Promise<Prestataire>;

  /** Calendriers ouvrés (heures d'ouverture et fermetures saisies par le client). */
  listCalendriers(): Promise<Calendrier[]>;
  createCalendrier(input: CalendrierInput): Promise<Calendrier>;
  /** Remplace entièrement le calendrier (plages et fermetures comprises). */
  updateCalendrier(id: string, input: CalendrierInput): Promise<Calendrier>;

  listContrats(filters?: ContratFilters): Promise<Contrat[]>;
  getContrat(id: string): Promise<Contrat>;
  createContrat(input: ContratInput): Promise<Contrat>;
  /** Si `perimetre` ou `regles` est fourni, il REMPLACE l'ensemble existant. */
  updateContrat(id: string, patch: ContratPatch): Promise<Contrat>;

  getParametres(): Promise<Parametres>;
  setParametres(input: ParametresInput): Promise<Parametres>;

  listSites(): Promise<Site[]>;
  listLocaux(siteId: string): Promise<Local[]>;

  listTickets(filters?: TicketFilters): Promise<Ticket[]>;
  /** Crée le ticket et renvoie son détail, avec la sélection des prestataires éligibles de sa famille. */
  createTicket(input: TicketCreate): Promise<TicketDetail>;
  getTicket(id: string): Promise<TicketDetail>;
  /** Affecte (ou réaffecte) le ticket ; refuse tout prestataire non éligible. */
  affecter(ticketId: string, input: AffectationInput): Promise<TicketDetail>;
}

/** Types partagés entre l'API, la console web et les implémentations de données (démo / API). */

export type StatutPrestataire = 'actif' | 'suspendu';
export type RaisonIneligibilite = 'suspendu' | 'non_rattache' | 'assurance_expiree';
export type Priorite = 'p1' | 'p2' | 'p3' | 'p4';
export type StatutTicket =
  | 'nouveau' | 'qualifie' | 'affecte' | 'planifie' | 'en_cours' | 'en_attente' | 'resolu' | 'clos' | 'rejete' | 'annule';

export interface Famille {
  id: string;
  code: string;
  libelle: string;
  actif: boolean;
  ordre: number;
  /** Nombre de prestataires référencés sur la famille (calculé). */
  nb_prestataires: number;
}

export interface Referencement {
  famille_id: string;
  /** 1 = prestataire préféré. */
  priorite: number;
}

export interface Prestataire {
  id: string;
  nom: string;
  contact_nom: string | null;
  contact_email: string | null;
  contact_telephone: string | null;
  zone: string | null;
  statut: StatutPrestataire;
  /** Échéance de l'attestation d'assurance (AAAA-MM-JJ), incluse. */
  assurance_expire_le: string | null;
  /** Compte prestataire sur la plateforme ; null = pas encore rattaché (aucune affectation possible). */
  prestataire_org_id: string | null;
  notes: string | null;
  familles: Referencement[];
  created_at: string;
}

export interface Site { id: string; nom: string }
export interface Local { id: string; nom: string; site_id: string }

export interface Eligibilite {
  annuaire_id: string;
  nom: string;
  priorite: number;
  eligible: boolean;
  raison: 'ok' | RaisonIneligibilite;
}

export interface Selection {
  /** Prestataires référencés sur la famille : éligibles d'abord (par priorité), puis exclus avec motif. */
  eligibles: Eligibilite[];
  /** Prestataire proposé par défaut (premier éligible), null s'il n'y en a aucun. */
  suggere: string | null;
}

export interface Affectation {
  id: string;
  annuaire_id: string;
  prestataire_nom: string;
  affecte_at: string;
  /** null = affectation en cours. */
  fin_at: string | null;
  motif: string | null;
}

export interface Ticket {
  id: string;
  titre: string;
  description: string | null;
  famille_id: string;
  famille_libelle: string | null;
  site_id: string;
  site_nom: string | null;
  local_id: string | null;
  local_nom: string | null;
  priorite: Priorite;
  statut: StatutTicket;
  created_at: string;
  prestataire_actuel: string | null;
}

export interface TicketDetail extends Ticket {
  historique: Affectation[];
  selection: Selection;
}

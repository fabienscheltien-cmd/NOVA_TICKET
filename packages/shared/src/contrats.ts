import { type CalendrierCalc, CALENDRIER_24_7, echeanceOuvree } from './sla.js';
import type { Priorite } from './types.js';

/** Données d'un contrat nécessaires à l'éligibilité et au SLA (sous-ensemble de Contrat). */
export interface ContratEntree {
  id: string;
  annuaire_id: string;
  statut: 'actif' | 'suspendu';
  date_debut: string;
  date_fin: string | null;
  calendrier_id: string | null;
  perimetre: Array<{ site_id: string; famille_id: string | null }>;
  regles: Array<{ priorite: Priorite; delai_prise_en_compte_min: number; delai_resolution_min: number; calendrier_id: string | null }>;
}

export interface CibleContrat { annuaire_id: string; site_id: string; famille_id: string }

/** Une ligne de périmètre couvre-t-elle le site et la famille ? (famille NULL = toutes les familles) */
const couvre = (p: ContratEntree['perimetre'][number], c: CibleContrat) => p.site_id === c.site_id && (p.famille_id === null || p.famille_id === c.famille_id);

/** Contrat actif, en cours à la date du jour (bornes incluses), dont le périmètre couvre le site et la famille. */
export function contratsCouvrants(contrats: ContratEntree[], cible: CibleContrat, aujourdhui: string): ContratEntree[] {
  return contrats.filter((c) =>
    c.annuaire_id === cible.annuaire_id && c.statut === 'actif' && c.date_debut <= aujourdhui && (c.date_fin === null || c.date_fin >= aujourdhui)
    && c.perimetre.some((p) => couvre(p, cible)));
}

/**
 * Contrat qui porte le SLA d'un ticket : parmi les contrats couvrants qui définissent une règle pour la priorité,
 * le plus spécifique (une ligne de périmètre qui nomme la famille), puis le plus récent, puis l'identifiant.
 */
export function contratPourSla(contrats: ContratEntree[], cible: CibleContrat, priorite: Priorite, aujourdhui: string): ContratEntree | undefined {
  const specificite = (c: ContratEntree) => (c.perimetre.some((p) => couvre(p, cible) && p.famille_id !== null) ? 1 : 0);
  return contratsCouvrants(contrats, cible, aujourdhui)
    .filter((c) => c.regles.some((r) => r.priorite === priorite))
    .sort((a, b) => specificite(b) - specificite(a) || (a.date_debut < b.date_debut ? 1 : a.date_debut > b.date_debut ? -1 : 0) || (a.id < b.id ? -1 : 1))[0];
}

export interface InstanceSlaPlanifiee { type: 'prise_en_compte' | 'resolution'; depart: Date; delai_minutes: number; echeance: Date }

/**
 * Instances SLA d'une affectation (06-sla.md, point 1) : la prise en compte part de l'affectation ; la résolution part de la
 * création du ticket (durée totale côté client, hypothèse configurable par contrat à terme). Calendrier : celui de la règle,
 * sinon celui du contrat, sinon 24/7.
 */
export function planifierSla(args: {
  contrat: ContratEntree; priorite: Priorite; creeLe: Date; affecteLe: Date;
  calendriers: Map<string, CalendrierCalc>;
}): InstanceSlaPlanifiee[] {
  const regle = args.contrat.regles.find((r) => r.priorite === args.priorite);
  if (!regle) return [];
  const calId = regle.calendrier_id ?? args.contrat.calendrier_id;
  const cal = (calId && args.calendriers.get(calId)) || CALENDRIER_24_7;
  return [
    { type: 'prise_en_compte', depart: args.affecteLe, delai_minutes: regle.delai_prise_en_compte_min, echeance: echeanceOuvree(args.affecteLe, regle.delai_prise_en_compte_min, cal) },
    { type: 'resolution', depart: args.creeLe, delai_minutes: regle.delai_resolution_min, echeance: echeanceOuvree(args.creeLe, regle.delai_resolution_min, cal) },
  ];
}

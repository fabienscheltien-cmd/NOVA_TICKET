import type { Priorite, StatutPrestataire, StatutTicket } from '@nova/shared';

export const STATUTS_TICKET: Record<StatutTicket, string> = {
  nouveau: 'Nouveau', qualifie: 'Qualifié', affecte: 'Affecté', planifie: 'Planifié', en_cours: 'En cours',
  en_attente: 'En attente', resolu: 'Résolu', clos: 'Clos', rejete: 'Rejeté', annule: 'Annulé',
};
export const STATUTS_AFFECTABLES: StatutTicket[] = ['nouveau', 'qualifie', 'affecte'];

export const PRIORITES: Record<Priorite, string> = { p1: 'Urgente (P1)', p2: 'Haute (P2)', p3: 'Normale (P3)', p4: 'Basse (P4)' };
export const STATUTS_PRESTATAIRE: Record<StatutPrestataire, string> = { actif: 'Actif', suspendu: 'Suspendu' };

/** « 2026-10-16 » → « 16/10/2026 » (sans passer par un fuseau : ce sont des dates civiles). */
export function dateCivile(iso: string | null): string {
  if (!iso) return '—';
  const [y, m, d] = iso.slice(0, 10).split('-');
  return `${d}/${m}/${y}`;
}
export function dateHeure(iso: string): string {
  return new Date(iso).toLocaleString('fr-FR', { dateStyle: 'short', timeStyle: 'short', timeZone: 'Europe/Paris' });
}

export type EtatAssurance = 'valide' | 'bientot' | 'echue' | 'inconnue';
export function etatAssurance(expire: string | null, aujourdhui: string): EtatAssurance {
  if (!expire) return 'inconnue';
  if (expire < aujourdhui) return 'echue';
  const jours = (Date.parse(`${expire}T00:00:00Z`) - Date.parse(`${aujourdhui}T00:00:00Z`)) / 86_400_000;
  return jours <= 30 ? 'bientot' : 'valide';
}

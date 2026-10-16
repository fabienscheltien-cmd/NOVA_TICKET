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

/** 90 → « 1 h 30 », 2880 → « 2 j » (jours de 24 h) : les délais sont saisis en minutes. */
export function duree(minutes: number): string {
  const j = Math.floor(minutes / 1440); const h = Math.floor((minutes % 1440) / 60); const m = minutes % 60;
  const parts = [j ? `${j} j` : '', h ? `${h} h` : '', m ? `${m} min` : ''].filter(Boolean);
  return parts.length ? parts.join(' ') : '0 min';
}

export const JOURS_SEMAINE = ['Lun', 'Mar', 'Mer', 'Jeu', 'Ven', 'Sam', 'Dim'];
/** [1,2,3,4,5] → « Lun–Ven » ; sinon liste. */
export function libelleJours(jours: number[]): string {
  const j = [...jours].sort((a, b) => a - b);
  const continu = j.every((v, i) => i === 0 || v === j[i - 1]! + 1);
  if (j.length > 2 && continu) return `${JOURS_SEMAINE[j[0]! - 1]}–${JOURS_SEMAINE[j[j.length - 1]! - 1]}`;
  return j.map((v) => JOURS_SEMAINE[v - 1]).join(', ');
}
export const ETATS_SLA = { en_cours: 'En cours', depasse: 'Dépassé' } as const;
export const TYPES_SLA = { prise_en_compte: 'Prise en compte', resolution: 'Résolution' } as const;

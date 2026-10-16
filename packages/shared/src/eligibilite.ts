import type { Eligibilite, Referencement, RaisonIneligibilite, Selection, StatutPrestataire } from './types.js';

export interface EntreeAnnuaire {
  id: string;
  nom: string;
  statut: StatutPrestataire;
  assurance_expire_le: string | null;
  prestataire_org_id: string | null;
  familles: Referencement[];
}

/** Date du jour au format AAAA-MM-JJ, à l'heure de Paris (les échéances sont des dates civiles françaises). */
export function aujourdhuiParis(now: Date = new Date()): string {
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Paris', year: 'numeric', month: '2-digit', day: '2-digit' }).format(now);
}

export function raisonIneligibilite(e: EntreeAnnuaire, aujourdhui: string): 'ok' | RaisonIneligibilite {
  if (e.statut !== 'actif') return 'suspendu';
  if (e.prestataire_org_id === null) return 'non_rattache';
  if (e.assurance_expire_le !== null && e.assurance_expire_le < aujourdhui) return 'assurance_expiree';
  return 'ok';
}

const cmp = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);

/**
 * Règle d'éligibilité : un prestataire est candidat s'il est référencé sur la famille du ticket ;
 * il est éligible s'il est actif, rattaché à un compte et si son assurance n'est pas échue.
 * Tri : éligibles d'abord, par priorité croissante puis par nom (ordre des codes, identique à la base).
 * MIROIR de la fonction SQL app.prestataires_eligibles : un test de contrat commun garde les deux alignées.
 */
export function evaluerEligibilite(familleId: string, annuaire: EntreeAnnuaire[], aujourdhui: string): Selection {
  const lignes: Eligibilite[] = [];
  for (const e of annuaire) {
    const ref = e.familles.find((f) => f.famille_id === familleId);
    if (!ref) continue;
    const raison = raisonIneligibilite(e, aujourdhui);
    lignes.push({ annuaire_id: e.id, nom: e.nom, priorite: ref.priorite, eligible: raison === 'ok', raison });
  }
  lignes.sort((a, b) => Number(b.eligible) - Number(a.eligible) || a.priorite - b.priorite || cmp(a.nom, b.nom));
  return { eligibles: lignes, suggere: lignes.find((l) => l.eligible)?.annuaire_id ?? null };
}

export const RAISONS_LIBELLES: Record<'ok' | RaisonIneligibilite, string> = {
  ok: 'Éligible',
  suspendu: 'Prestataire suspendu',
  non_rattache: 'Pas encore rattaché à un compte NOVA',
  assurance_expiree: 'Attestation d\'assurance échue',
};

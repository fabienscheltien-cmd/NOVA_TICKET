import { FAMILLES_STANDARD } from './familles.js';
import { type ContratEntree, contratPourSla, planifierSla } from './contrats.js';
import type { CalendrierCalc } from './sla.js';
import type { Calendrier, Contrat, Priorite, StatutPrestataire, StatutTicket } from './types.js';

/** Libellé affiché partout où des données de démonstration apparaissent : jamais de données factices non signalées. */
export const DEMO_LABEL = 'Données de démonstration — fictives, non enregistrées';

export interface FamilleRow { id: string; code: string; libelle: string; actif: boolean; ordre: number }
export interface PrestataireRow {
  id: string; nom: string; contact_nom: string | null; contact_email: string | null; contact_telephone: string | null;
  zone: string | null; statut: StatutPrestataire; assurance_expire_le: string | null; prestataire_org_id: string | null;
  invitation_email: string | null; invitation_envoyee_le: string | null;
  notes: string | null; familles: Array<{ famille_id: string; priorite: number }>; created_at: string;
}
export interface SiteRow { id: string; nom: string }
export interface LocalRow { id: string; nom: string; site_id: string }
export interface TicketRow {
  id: string; titre: string; description: string | null; famille_id: string; site_id: string; local_id: string | null;
  priorite: Priorite; statut: StatutTicket; created_at: string;
}
export interface AffectationRow {
  id: string; ticket_id: string; annuaire_id: string; prestataire_nom: string; affecte_at: string; fin_at: string | null; motif: string | null;
}
export type CalendrierRow = Calendrier;
export type ContratRow = Omit<Contrat, 'prestataire_nom'>;
export interface SlaRow {
  id: string; ticket_id: string; affectation_id: string; contrat_id: string; type: 'prise_en_compte' | 'resolution';
  depart_at: string; delai_minutes: number; echeance_at: string; remplace_at: string | null;
}
export interface DemoData {
  familles: FamilleRow[]; prestataires: PrestataireRow[]; sites: SiteRow[]; locaux: LocalRow[]; tickets: TicketRow[]; affectations: AffectationRow[];
  calendriers: CalendrierRow[]; contrats: ContratRow[]; sla: SlaRow[]; parametres: { exiger_contrat: boolean };
}

const uuid = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const jour = (base: string, delta: number): string => {
  const d = new Date(`${base}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() + delta);
  return d.toISOString().slice(0, 10);
};

/**
 * Jeu de démonstration entièrement fictif. Les échéances sont calculées par rapport à `aujourdhui` pour que les cas
 * (assurance échue, suspendu, non rattaché) restent visibles quelle que soit la date.
 */
export function creerDonneesDemo(aujourdhui: string): DemoData {
  const familles: FamilleRow[] = FAMILLES_STANDARD.map((f, i) => ({ id: uuid(100 + i), code: f.code, libelle: f.libelle, actif: true, ordre: (i + 1) * 10 }));
  const fam = (code: string) => familles.find((f) => f.code === code)!.id;
  const horodatage = `${jour(aujourdhui, -90)}T09:00:00.000Z`;
  const p = (n: number, nom: string, o: Partial<PrestataireRow> & { familles: PrestataireRow['familles'] }): PrestataireRow => ({
    id: uuid(200 + n), nom, contact_nom: null, contact_email: null, contact_telephone: null, zone: null, statut: 'actif',
    assurance_expire_le: jour(aujourdhui, 200), prestataire_org_id: uuid(900 + n), invitation_email: null, invitation_envoyee_le: null, notes: null, created_at: horodatage, ...o,
  });
  const prestataires: PrestataireRow[] = [
    p(1, 'Hydro-Services (démo)', { contact_nom: 'Camille Martin', contact_email: 'contact@hydro-services.demo.invalid', contact_telephone: '01 00 00 00 01', zone: 'Lyon et agglomération',
      familles: [{ famille_id: fam('plomberie'), priorite: 1 }, { famille_id: fam('cvc'), priorite: 2 }] }),
    p(2, 'Aqua-Rapide (démo)', { contact_nom: 'Samir Benali', contact_email: 'astreinte@aqua-rapide.demo.invalid', contact_telephone: '01 00 00 00 02', zone: 'Lyon', assurance_expire_le: jour(aujourdhui, 25),
      notes: 'Astreinte week-end.', familles: [{ famille_id: fam('plomberie'), priorite: 2 }] }),
    p(3, 'Électro-Plus (démo)', { contact_nom: 'Julie Perrin', contact_email: 'contact@electro-plus.demo.invalid', contact_telephone: '01 00 00 00 03', zone: 'Rhône',
      assurance_expire_le: jour(aujourdhui, -12), notes: 'Attestation à renouveler.', familles: [{ famille_id: fam('electricite'), priorite: 1 }] }),
    p(4, 'Courant-Fort (démo)', { contact_nom: 'Antoine Roux', contact_email: 'contact@courant-fort.demo.invalid', contact_telephone: '01 00 00 00 04', zone: 'Rhône',
      familles: [{ famille_id: fam('electricite'), priorite: 2 }, { famille_id: fam('controle_acces'), priorite: 1 }] }),
    p(5, 'ClimaConfort (démo)', { contact_nom: 'Nadia Lopes', contact_email: 'contact@climaconfort.demo.invalid', contact_telephone: '01 00 00 00 05', zone: 'Lyon',
      statut: 'suspendu', notes: 'Suspendu : litige en cours.', familles: [{ famille_id: fam('cvc'), priorite: 1 }] }),
    p(6, 'Thermi-Air (démo)', { contact_nom: 'Paul Girard', contact_email: 'contact@thermi-air.demo.invalid', contact_telephone: '01 00 00 00 06', zone: 'Lyon',
      prestataire_org_id: null, invitation_email: 'contact@thermi-air.demo.invalid', invitation_envoyee_le: `${jour(aujourdhui, -3)}T10:00:00.000Z`, notes: null, familles: [{ famille_id: fam('cvc'), priorite: 3 }] }),
    p(7, 'Clés & Sécurité (démo)', { contact_nom: 'Élodie Fabre', contact_email: 'contact@cles-securite.demo.invalid', contact_telephone: '01 00 00 00 07', zone: 'Lyon',
      familles: [{ famille_id: fam('serrurerie'), priorite: 1 }, { famille_id: fam('controle_acces'), priorite: 2 }] }),
    p(8, 'Serrures Express (démo)', { contact_nom: 'Karim Haddad', contact_email: 'contact@serrures-express.demo.invalid', contact_telephone: '01 00 00 00 08', zone: 'Lyon 24 h/24',
      familles: [{ famille_id: fam('serrurerie'), priorite: 2 }] }),
    p(9, 'Net-Propre (démo)', { contact_nom: 'Léa Chevalier', contact_email: 'contact@net-propre.demo.invalid', contact_telephone: '01 00 00 00 09', zone: 'Rhône',
      familles: [{ famille_id: fam('nettoyage'), priorite: 1 }, { famille_id: fam('espaces_verts'), priorite: 2 }] }),
    p(10, 'Ascenso-Démo', { contact_nom: 'Marc Dupuis', contact_email: 'contact@ascenso.demo.invalid', contact_telephone: '01 00 00 00 10', zone: 'Auvergne-Rhône-Alpes',
      familles: [{ famille_id: fam('ascenseurs'), priorite: 1 }] }),
  ];
  const sites: SiteRow[] = [
    { id: uuid(300), nom: 'Tour Horizon (démo)' },
    { id: uuid(301), nom: 'Résidence des Lilas (démo)' },
    { id: uuid(302), nom: 'Centre commercial Atlas (démo)' },
  ];
  const locaux: LocalRow[] = [
    { id: uuid(400), nom: 'Accueil RDC', site_id: sites[0]!.id },
    { id: uuid(401), nom: 'Plateau R+3', site_id: sites[0]!.id },
    { id: uuid(402), nom: 'Local technique sous-sol', site_id: sites[0]!.id },
    { id: uuid(403), nom: 'Hall bâtiment A', site_id: sites[1]!.id },
    { id: uuid(404), nom: 'Logement 12', site_id: sites[1]!.id },
    { id: uuid(405), nom: 'Galerie marchande niveau 1', site_id: sites[2]!.id },
    { id: uuid(406), nom: 'Parking P2', site_id: sites[2]!.id },
  ];
  const t = (n: number, titre: string, familleCode: string, siteIdx: number, localIdx: number | null, priorite: Priorite, statut: StatutTicket, joursAvant: number, description: string): TicketRow => ({
    id: uuid(500 + n), titre, description, famille_id: fam(familleCode), site_id: sites[siteIdx]!.id, local_id: localIdx === null ? null : locaux[localIdx]!.id,
    priorite, statut, created_at: `${jour(aujourdhui, -joursAvant)}T08:30:00.000Z`,
  });
  const tickets: TicketRow[] = [
    t(1, 'Fuite sous le lavabo des sanitaires', 'plomberie', 0, 1, 'p2', 'nouveau', 0, 'Écoulement au pied du lavabo, sol mouillé depuis ce matin.'),
    t(2, 'Prises de courant hors service au R+3', 'electricite', 0, 1, 'p3', 'nouveau', 1, 'Plusieurs postes de travail sans alimentation.'),
    t(3, 'Climatisation en panne dans la galerie', 'cvc', 2, 5, 'p2', 'nouveau', 1, 'Température élevée signalée par les commerçants.'),
    t(4, 'Serrure de la porte du hall bloquée', 'serrurerie', 1, 3, 'p1', 'nouveau', 0, 'La porte ne se verrouille plus.'),
    t(5, 'Chauffe-eau du logement 12 : plus d\'eau chaude', 'plomberie', 1, 4, 'p3', 'affecte', 3, 'Occupant sans eau chaude depuis trois jours.'),
    t(6, 'Ascenseur nord immobilisé', 'ascenseurs', 0, 0, 'p1', 'nouveau', 0, 'Cabine bloquée au 2e étage, sans personne à bord.'),
  ];
  const affectations: AffectationRow[] = [
    { id: uuid(600), ticket_id: tickets[4]!.id, annuaire_id: prestataires[0]!.id, prestataire_nom: prestataires[0]!.nom, affecte_at: `${jour(aujourdhui, -2)}T10:00:00.000Z`, fin_at: null, motif: null },
  ];
  const cal = (n: number, nom: string, plages: Calendrier['plages'], fermetures: Calendrier['fermetures'] = []): CalendrierRow => ({ id: uuid(700 + n), nom, fuseau: 'Europe/Paris', plages, fermetures });
  const calendriers: CalendrierRow[] = [
    cal(1, 'Heures de bureau (démo)', [{ jours: [1, 2, 3, 4, 5], debut: '08:00', fin: '12:00' }, { jours: [1, 2, 3, 4, 5], debut: '14:00', fin: '18:00' }],
      [{ du: jour(aujourdhui, 30), au: jour(aujourdhui, 30), libelle: 'Fermeture exceptionnelle (démo)' }]),
    cal(2, 'Astreinte 24 h/24 (démo)', [{ jours: [1, 2, 3, 4, 5, 6, 7], debut: '00:00', fin: '24:00' }]),
  ];
  const contrat = (n: number, p: PrestataireRow, libelle: string, perimetre: ContratRow['perimetre'], regles: ContratRow['regles'], o: Partial<ContratRow> = {}): ContratRow => ({
    id: uuid(800 + n), annuaire_id: p.id, libelle, date_debut: jour(aujourdhui, -200), date_fin: jour(aujourdhui, 165), statut: 'actif',
    calendrier_id: calendriers[0]!.id, notes: null, perimetre, regles, created_at: horodatage, ...o,
  });
  const contrats: ContratRow[] = [
    contrat(1, prestataires[0]!, 'Plomberie et CVC — Horizon, Lilas, Atlas (démo)',
      [{ site_id: sites[0]!.id, famille_id: fam('plomberie') }, { site_id: sites[0]!.id, famille_id: fam('cvc') }, { site_id: sites[1]!.id, famille_id: fam('plomberie') }, { site_id: sites[2]!.id, famille_id: null }],
      [{ priorite: 'p1', delai_prise_en_compte_min: 60, delai_resolution_min: 480, calendrier_id: calendriers[1]!.id },
        { priorite: 'p2', delai_prise_en_compte_min: 120, delai_resolution_min: 960, calendrier_id: null },
        { priorite: 'p3', delai_prise_en_compte_min: 240, delai_resolution_min: 2400, calendrier_id: null }]),
    contrat(2, prestataires[1]!, 'Plomberie — Résidence des Lilas (démo)', [{ site_id: sites[1]!.id, famille_id: fam('plomberie') }],
      [{ priorite: 'p3', delai_prise_en_compte_min: 480, delai_resolution_min: 2880, calendrier_id: null }]),
    contrat(3, prestataires[3]!, 'Électricité — tous sites (démo)', sites.map((s) => ({ site_id: s.id, famille_id: fam('electricite') })), [], { date_fin: null }),
    contrat(4, prestataires[6]!, 'Serrurerie — contrat échu (démo)', [{ site_id: sites[1]!.id, famille_id: fam('serrurerie') }],
      [{ priorite: 'p1', delai_prise_en_compte_min: 60, delai_resolution_min: 240, calendrier_id: calendriers[1]!.id }], { date_debut: jour(aujourdhui, -400), date_fin: jour(aujourdhui, -35) }),
  ];
  const parametres = { exiger_contrat: false };
  // L'affectation de démonstration (ticket 5, chauffe-eau, P3) suit le SLA de son contrat, calculé comme par l'API.
  const sla: SlaRow[] = [];
  const cals = new Map<string, CalendrierCalc>(calendriers.map((c) => [c.id, c]));
  const t5 = tickets[4]!;
  const a5 = affectations[0]!;
  const c5 = contratPourSla(contrats satisfies ContratEntree[], { annuaire_id: a5.annuaire_id, site_id: t5.site_id, famille_id: t5.famille_id }, t5.priorite, aujourdhui);
  if (c5) {
    planifierSla({ contrat: c5, priorite: t5.priorite, creeLe: new Date(t5.created_at), affecteLe: new Date(a5.affecte_at), calendriers: cals }).forEach((i, n) => sla.push({
      id: uuid(960 + n), ticket_id: t5.id, affectation_id: a5.id, contrat_id: c5.id, type: i.type, depart_at: i.depart.toISOString(),
      delai_minutes: i.delai_minutes, echeance_at: i.echeance.toISOString(), remplace_at: null,
    }));
  }
  return { familles, prestataires, sites, locaux, tickets, affectations, calendriers, contrats, sla, parametres };
}

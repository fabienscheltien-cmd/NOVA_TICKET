import { DateTime } from 'luxon';

/**
 * Calcul des délais en MINUTES OUVRÉES (docs/phase1/06-sla.md). Les fuseaux et les changements d'heure sont
 * délégués à luxon : aucun calcul d'heure locale à la main.
 *
 * Un calendrier est un fuseau, des plages hebdomadaires (jours ISO 1 = lundi … 7 = dimanche, heures locales
 * « HH:MM », `24:00` accepté pour minuit) et des fermetures (dates locales incluses, saisies par le client :
 * la liste des jours fériés n'est volontairement pas figée dans le code, voir « À valider » du document 06).
 */
export interface PlageHoraire { jours: number[]; debut: string; fin: string }
export interface FermetureCalc { du: string; au: string }
export interface CalendrierCalc { fuseau: string; plages: PlageHoraire[]; fermetures: FermetureCalc[] }

const HORIZON_JOURS = 366 * 3;

export class CalendrierInvalide extends Error {}

function minutesDuJour(hhmm: string): number {
  const m = /^(\d{2}):(\d{2})$/.exec(hhmm);
  if (!m) throw new CalendrierInvalide(`heure invalide : ${hhmm}`);
  const h = Number(m[1]); const mi = Number(m[2]);
  if (mi > 59 || h > 24 || (h === 24 && mi !== 0)) throw new CalendrierInvalide(`heure invalide : ${hhmm}`);
  return h * 60 + mi;
}

/** Valide un calendrier (fuseau IANA, plages non vides, début < fin, jours 1 à 7, fermetures cohérentes). */
export function validerCalendrier(c: CalendrierCalc): void {
  if (!DateTime.local().setZone(c.fuseau).isValid) throw new CalendrierInvalide(`fuseau inconnu : ${c.fuseau}`);
  if (c.plages.length === 0) throw new CalendrierInvalide('au moins une plage horaire est nécessaire');
  for (const p of c.plages) {
    if (p.jours.length === 0 || p.jours.some((j) => !Number.isInteger(j) || j < 1 || j > 7)) throw new CalendrierInvalide('jours : entiers de 1 (lundi) à 7 (dimanche)');
    if (minutesDuJour(p.debut) >= minutesDuJour(p.fin)) throw new CalendrierInvalide(`plage ${p.debut}–${p.fin} : le début doit précéder la fin`);
  }
  for (const f of c.fermetures) if (f.au < f.du) throw new CalendrierInvalide(`fermeture ${f.du} → ${f.au} : la fin précède le début`);
}

interface Intervalle { debut: number; fin: number }

/** Instant (ms) correspondant à une heure murale d'une date locale ; 1440 = minuit du lendemain. luxon gère les heures inexistantes ou doublées. */
function heureLocale(jour: DateTime, minutes: number): number {
  const base = minutes === 1440 ? jour.plus({ days: 1 }) : jour;
  const m = minutes === 1440 ? 0 : minutes;
  return DateTime.fromObject({ year: base.year, month: base.month, day: base.day, hour: Math.floor(m / 60), minute: m % 60 }, { zone: jour.zoneName! }).toMillis();
}

/** Plages ouvrées d'une date locale, en instants (ms), fusionnées et triées ; vide si fermée. */
function plagesDuJour(jour: DateTime, c: CalendrierCalc): Intervalle[] {
  const iso = jour.toISODate()!;
  if (c.fermetures.some((f) => iso >= f.du && iso <= f.au)) return [];
  const brut: Intervalle[] = [];
  for (const p of c.plages) {
    if (!p.jours.includes(jour.weekday)) continue;
    brut.push({ debut: heureLocale(jour, minutesDuJour(p.debut)), fin: heureLocale(jour, minutesDuJour(p.fin)) });
  }
  brut.sort((a, b) => a.debut - b.debut);
  const fusion: Intervalle[] = [];
  for (const i of brut) {
    const dernier = fusion[fusion.length - 1];
    if (dernier && i.debut <= dernier.fin) dernier.fin = Math.max(dernier.fin, i.fin); else fusion.push({ ...i });
  }
  return fusion;
}

/** Parcourt les plages ouvrées à partir de `depart` ; `visite` renvoie true pour arrêter. */
function parcourir(depart: Date, c: CalendrierCalc, visite: (i: Intervalle) => boolean): void {
  let jour = DateTime.fromJSDate(depart, { zone: c.fuseau }).startOf('day');
  for (let n = 0; n < HORIZON_JOURS; n++) {
    for (const i of plagesDuJour(jour, c)) {
      if (i.fin <= depart.getTime()) continue;
      if (visite({ debut: Math.max(i.debut, depart.getTime()), fin: i.fin })) return;
    }
    jour = jour.plus({ days: 1 });
  }
  throw new CalendrierInvalide('aucune plage ouvrée dans les trois ans qui suivent : calendrier inutilisable');
}

/** Échéance = départ + `minutes` minutes ouvrées (départ hors plage : le chrono démarre à la prochaine ouverture). */
export function echeanceOuvree(depart: Date, minutes: number, c: CalendrierCalc): Date {
  if (!Number.isInteger(minutes) || minutes <= 0) throw new RangeError('minutes : entier strictement positif');
  validerCalendrier(c);
  let reste = minutes;
  let fin = depart.getTime();
  parcourir(depart, c, (i) => {
    const dispo = Math.round((i.fin - i.debut) / 60000);
    if (dispo >= reste) { fin = i.debut + reste * 60000; return true; }
    reste -= dispo;
    return false;
  });
  return new Date(fin);
}

/** Minutes ouvrées écoulées entre `a` et `b` (0 si b ≤ a). */
export function minutesOuvreesEntre(a: Date, b: Date, c: CalendrierCalc): number {
  if (b.getTime() <= a.getTime()) return 0;
  validerCalendrier(c);
  let total = 0;
  parcourir(a, c, (i) => {
    if (i.debut >= b.getTime()) return true;
    total += (Math.min(i.fin, b.getTime()) - i.debut) / 60000;
    return i.fin >= b.getTime();
  });
  return Math.round(total);
}

/**
 * Pause puis reprise : l'échéance est recalculée à partir du temps ouvré RESTANT à la reprise
 * (06-sla, point 3). Le temps ouvré écoulé pendant la pause ne compte pas.
 */
export function echeanceApresPause(depart: Date, delaiMinutes: number, pauseDebut: Date, reprise: Date, c: CalendrierCalc): Date {
  const ecoule = minutesOuvreesEntre(depart, pauseDebut, c);
  const reste = delaiMinutes - ecoule;
  if (reste <= 0) return pauseDebut;
  return echeanceOuvree(reprise, reste, c);
}

export const CALENDRIER_24_7: CalendrierCalc = { fuseau: 'Europe/Paris', plages: [{ jours: [1, 2, 3, 4, 5, 6, 7], debut: '00:00', fin: '24:00' }], fermetures: [] };

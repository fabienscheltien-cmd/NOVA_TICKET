import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { CALENDRIER_24_7, type CalendrierCalc, CalendrierInvalide, echeanceApresPause, echeanceOuvree, minutesOuvreesEntre, validerCalendrier } from '../src/sla.js';

const BUREAU: CalendrierCalc = {
  fuseau: 'Europe/Paris',
  plages: [{ jours: [1, 2, 3, 4, 5], debut: '08:00', fin: '12:00' }, { jours: [1, 2, 3, 4, 5], debut: '14:00', fin: '18:00' }],
  fermetures: [],
};
const paris = (iso: string) => new Date(new Date(`${iso}:00Z`).getTime() - parisOffset(iso) * 60000);
/** Décalage de Paris (minutes) à la date locale donnée, calculé indépendamment de luxon pour contrôler le résultat. */
function parisOffset(iso: string): number {
  const d = new Date(`${iso}:00Z`);
  const fmt = new Intl.DateTimeFormat('en-GB', { timeZone: 'Europe/Paris', timeZoneName: 'shortOffset' }).formatToParts(d).find((p) => p.type === 'timeZoneName')!.value;
  const m = /GMT([+-]\d+)/.exec(fmt)!;
  return Number(m[1]) * 60;
}
const local = (d: Date) => new Intl.DateTimeFormat('sv-SE', { timeZone: 'Europe/Paris', dateStyle: 'short', timeStyle: 'short' }).format(d);

describe('minutes ouvrées', () => {
  it('critère 1 : ticket créé un vendredi à 17 h 30, 120 min → lundi 09 h 30 (30 min vendredi + 90 min lundi)', () => {
    assert.equal(local(echeanceOuvree(paris('2026-10-16T17:30'), 120, BUREAU)), '2026-10-19 09:30');
  });
  it('saute la pause déjeuner et le week-end', () => {
    assert.equal(local(echeanceOuvree(paris('2026-10-15T11:00'), 120, BUREAU)), '2026-10-15 15:00');
    assert.equal(local(echeanceOuvree(paris('2026-10-17T10:00'), 60, BUREAU)), '2026-10-19 09:00', 'départ un samedi : le chrono démarre lundi à l\'ouverture');
  });
  it('une échéance pile à la fermeture reste dans la journée', () => {
    assert.equal(local(echeanceOuvree(paris('2026-10-15T16:00'), 120, BUREAU)), '2026-10-15 18:00');
  });
  it('calendrier 24/7 : minutes réelles', () => {
    assert.equal(local(echeanceOuvree(paris('2026-10-16T17:30'), 24 * 60, CALENDRIER_24_7)), '2026-10-17 17:30');
  });
  it('fermetures (jours fériés saisis par le client) : le jour fermé est ignoré', () => {
    const c = { ...BUREAU, fermetures: [{ du: '2026-10-19', au: '2026-10-19' }] };
    assert.equal(local(echeanceOuvree(paris('2026-10-16T17:30'), 120, c)), '2026-10-20 09:30');
  });
  it('plages qui se chevauchent : fusionnées, aucune minute comptée deux fois', () => {
    const c: CalendrierCalc = { fuseau: 'Europe/Paris', plages: [{ jours: [1], debut: '08:00', fin: '12:00' }, { jours: [1], debut: '10:00', fin: '14:00' }], fermetures: [] };
    assert.equal(minutesOuvreesEntre(paris('2026-10-19T00:00'), paris('2026-10-20T00:00'), c), 6 * 60);
  });

  it('changement d\'heure de printemps (29 mars 2026, 02:00 → 03:00) : 24 h ouvrées = 24 h réelles', () => {
    const fin = echeanceOuvree(paris('2026-03-28T12:00'), 24 * 60, CALENDRIER_24_7);
    assert.equal(fin.getTime() - paris('2026-03-28T12:00').getTime(), 24 * 3600_000, '24 h ouvrées = 24 h réelles');
    assert.equal(local(fin), '2026-03-29 13:00', 'l\'heure murale avance d\'une heure de plus à cause du passage à l\'heure d\'été');
  });
  it('changement d\'heure d\'automne (25 octobre 2026) : la nuit compte 25 h réelles en 24/7', () => {
    assert.equal(minutesOuvreesEntre(paris('2026-10-25T00:00'), paris('2026-10-26T00:00'), CALENDRIER_24_7), 25 * 60);
  });
  it('plage de bureau traversant le changement d\'heure : 8 h–18 h murales inchangées, durées réelles identiques', () => {
    // dimanche 29 mars 2026 fermé ; lundi 30 mars 2026 : journée normale à l'heure d'été
    assert.equal(local(echeanceOuvree(paris('2026-03-27T17:00'), 120, BUREAU)), '2026-03-30 09:00');
    assert.equal(minutesOuvreesEntre(paris('2026-03-27T00:00'), paris('2026-03-31T00:00'), BUREAU), 2 * 8 * 60, 'vendredi et lundi seulement');
  });
  it('fuseau autre que Paris : les plages suivent l\'horloge locale', () => {
    const ny: CalendrierCalc = { ...BUREAU, fuseau: 'America/New_York' };
    const e = echeanceOuvree(new Date('2026-10-15T12:00:00Z'), 60, ny); // 08:00 à New York (UTC−4)
    assert.equal(e.toISOString(), '2026-10-15T13:00:00.000Z');
  });
});

describe('pause et reprise (critère 2)', () => {
  const depart = paris('2026-10-15T09:00');
  const sans = echeanceOuvree(depart, 360, BUREAU);
  it('l\'échéance se décale exactement du temps ouvré de pause', () => {
    // pause jeudi 11:00 → vendredi 10:00 ; temps ouvré de pause : 1 h (jeudi matin) + 4 h (jeudi après-midi) + 2 h (vendredi matin)
    const pauseDebut = paris('2026-10-15T11:00');
    const reprise = paris('2026-10-16T10:00');
    const apres = echeanceApresPause(depart, 360, pauseDebut, reprise, BUREAU);
    const pauseOuvree = minutesOuvreesEntre(pauseDebut, reprise, BUREAU);
    assert.equal(pauseOuvree, 60 + 4 * 60 + 2 * 60);
    assert.equal(minutesOuvreesEntre(sans, apres, BUREAU), pauseOuvree);
    assert.equal(local(apres), '2026-10-16 16:00', '2 h écoulées avant la pause, 4 h restantes : vendredi 10–12 puis 14–16');
  });
  it('pause qui commence après l\'échéance : inchangée ; délai déjà consommé : arrêt à la pause', () => {
    assert.equal(echeanceApresPause(depart, 60, paris('2026-10-15T12:00'), paris('2026-10-16T08:00'), BUREAU).getTime(), paris('2026-10-15T12:00').getTime());
  });
});

describe('validation des calendriers', () => {
  it('refuse fuseau inconnu, plage vide ou inversée, jour hors 1–7, heure invalide, fermeture inversée', () => {
    const ok = BUREAU;
    assert.doesNotThrow(() => validerCalendrier(ok));
    assert.throws(() => validerCalendrier({ ...ok, fuseau: 'Mars/Olympus' }), CalendrierInvalide);
    assert.throws(() => validerCalendrier({ ...ok, plages: [] }), CalendrierInvalide);
    assert.throws(() => validerCalendrier({ ...ok, plages: [{ jours: [1], debut: '18:00', fin: '08:00' }] }), CalendrierInvalide);
    assert.throws(() => validerCalendrier({ ...ok, plages: [{ jours: [0], debut: '08:00', fin: '18:00' }] }), CalendrierInvalide);
    assert.throws(() => validerCalendrier({ ...ok, plages: [{ jours: [1], debut: '25:00', fin: '26:00' }] }), CalendrierInvalide);
    assert.throws(() => validerCalendrier({ ...ok, fermetures: [{ du: '2026-10-20', au: '2026-10-19' }] }), CalendrierInvalide);
    assert.throws(() => echeanceOuvree(new Date(), 0, ok), RangeError);
  });
  it('calendrier dont toutes les journées sont fermées : erreur explicite, pas de boucle infinie', () => {
    const ferme: CalendrierCalc = { ...BUREAU, fermetures: [{ du: '2000-01-01', au: '2100-12-31' }] };
    assert.throws(() => echeanceOuvree(new Date('2026-10-15T08:00:00Z'), 60, ferme), CalendrierInvalide);
  });
});

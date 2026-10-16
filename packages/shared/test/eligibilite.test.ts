import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { type EntreeAnnuaire, aujourdhuiParis, evaluerEligibilite, raisonIneligibilite } from '../src/eligibilite.js';
import { codeDepuisLibelle } from '../src/familles.js';

const FAM = 'f1';
const e = (id: string, nom: string, o: Partial<EntreeAnnuaire> = {}): EntreeAnnuaire => ({
  id, nom, statut: 'actif', assurance_expire_le: '2030-01-01', prestataire_org_id: `org-${id}`, familles: [{ famille_id: FAM, priorite: 1 }], ...o,
});

describe('règle d\'éligibilité', () => {
  const AUJ = '2026-10-16';

  it('un prestataire actif, rattaché et assuré est éligible', () => {
    assert.equal(raisonIneligibilite(e('a', 'A'), AUJ), 'ok');
  });
  it('l\'échéance d\'assurance est incluse : éligible le jour même, exclu le lendemain', () => {
    assert.equal(raisonIneligibilite(e('a', 'A', { assurance_expire_le: AUJ }), AUJ), 'ok');
    assert.equal(raisonIneligibilite(e('a', 'A', { assurance_expire_le: '2026-10-15' }), AUJ), 'assurance_expiree');
  });
  it('sans échéance renseignée, l\'assurance ne bloque pas', () => {
    assert.equal(raisonIneligibilite(e('a', 'A', { assurance_expire_le: null }), AUJ), 'ok');
  });
  it('priorité des motifs : suspendu, puis non rattaché, puis assurance échue', () => {
    const tout = e('a', 'A', { statut: 'suspendu', prestataire_org_id: null, assurance_expire_le: '2000-01-01' });
    assert.equal(raisonIneligibilite(tout, AUJ), 'suspendu');
    assert.equal(raisonIneligibilite({ ...tout, statut: 'actif' }, AUJ), 'non_rattache');
    assert.equal(raisonIneligibilite({ ...tout, statut: 'actif', prestataire_org_id: 'o' }, AUJ), 'assurance_expiree');
  });
  it('seuls les prestataires référencés sur la famille sont candidats', () => {
    const autre = e('x', 'X', { familles: [{ famille_id: 'f2', priorite: 1 }] });
    const sel = evaluerEligibilite(FAM, [e('a', 'A'), autre], AUJ);
    assert.deepEqual(sel.eligibles.map((l) => l.annuaire_id), ['a']);
  });
  it('tri : éligibles d\'abord par priorité puis nom, exclus ensuite ; suggestion = premier éligible', () => {
    const liste = [
      e('s', 'Suspendu', { statut: 'suspendu' }),
      e('b', 'Bravo', { familles: [{ famille_id: FAM, priorite: 2 }] }),
      e('z', 'Zulu', { familles: [{ famille_id: FAM, priorite: 1 }] }),
      e('a', 'Alpha', { familles: [{ famille_id: FAM, priorite: 2 }] }),
    ];
    const sel = evaluerEligibilite(FAM, liste, AUJ);
    assert.deepEqual(sel.eligibles.map((l) => l.nom), ['Zulu', 'Alpha', 'Bravo', 'Suspendu']);
    assert.equal(sel.suggere, 'z');
  });
  it('aucun éligible : pas de suggestion', () => {
    const sel = evaluerEligibilite(FAM, [e('s', 'S', { statut: 'suspendu' })], AUJ);
    assert.equal(sel.suggere, null);
    assert.equal(sel.eligibles.length, 1);
    assert.deepEqual(evaluerEligibilite('inconnue', [e('a', 'A')], AUJ), { eligibles: [], suggere: null });
  });
  it('la date du jour est celle de Paris, pas celle d\'UTC', () => {
    assert.equal(aujourdhuiParis(new Date('2026-06-30T22:30:00Z')), '2026-07-01');
    assert.equal(aujourdhuiParis(new Date('2026-01-15T22:30:00Z')), '2026-01-15');
  });
});

describe('code de famille', () => {
  it('dérive un identifiant stable sans accents ni ponctuation', () => {
    assert.equal(codeDepuisLibelle('Contrôle d\'accès'), 'controle_d_acces');
    assert.equal(codeDepuisLibelle('  CVC (chauffage) '), 'cvc_chauffage');
    assert.equal(codeDepuisLibelle('???'), '');
  });
});

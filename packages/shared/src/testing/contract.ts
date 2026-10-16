import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import { FAMILLES_STANDARD } from '../familles.js';
import { RepositoryError, type Repository } from '../repository.js';
import type { Famille, Prestataire, TicketDetail } from '../types.js';

export interface ContractHarness {
  repo: Repository;
  fixtures: {
    siteId: string;
    localId: string;
    /** Local d'un AUTRE site, pour tester l'incohérence site / local. */
    localAutreSiteId: string;
    /** Au moins cinq identifiants de comptes prestataires distincts (rattachement). */
    orgIds: string[];
  };
}

const jour = (delta: number): string => {
  const d = new Date();
  d.setUTCDate(d.getUTCDate() + delta);
  return d.toISOString().slice(0, 10);
};

async function refus(promesse: Promise<unknown>, code: string, raison?: string): Promise<RepositoryError> {
  try {
    await promesse;
  } catch (err) {
    assert.ok(err instanceof RepositoryError, `RepositoryError attendue, reçu : ${String(err)}`);
    assert.equal(err.code, code, `code attendu « ${code} », reçu « ${err.code} » (${err.message})`);
    if (raison) assert.equal((err.details as { raison?: string } | undefined)?.raison ?? (err.details as { raison?: string })?.raison, raison);
    return err;
  }
  assert.fail(`Un refus « ${code} » était attendu`);
}

/**
 * Suite de contrat : exécutée à l'identique contre DemoRepository et ApiRepository (base réelle).
 * Toute divergence de comportement entre la démonstration et l'API fait échouer l'une des deux exécutions.
 */
export function runRepositoryContract(nom: string, preparer: () => Promise<ContractHarness> | ContractHarness, nettoyer?: () => Promise<void>): void {
  describe(`contrat Repository — ${nom}`, () => {
    let h: ContractHarness;
    const s = Math.random().toString(36).slice(2, 8);
    let f1: Famille; let f2: Famille; let f3: Famille;
    const p: Record<string, Prestataire> = {};
    let ticket: TicketDetail;

    before(async () => { h = await preparer(); });
    after(async () => { await nettoyer?.(); });

    it('familles : création, doublon refusé, désactivation, import des familles standard idempotent', async () => {
      const { repo } = h;
      f1 = await repo.createFamille({ libelle: `Fuites ${s}` });
      f2 = await repo.createFamille({ libelle: `Pannes ${s}` });
      f3 = await repo.createFamille({ libelle: `Vide ${s}` });
      assert.equal(f1.libelle, `Fuites ${s}`);
      assert.equal(f1.actif, true);
      assert.equal(f1.nb_prestataires, 0);
      await refus(repo.createFamille({ libelle: `Fuites ${s}` }), 'conflict');
      await refus(repo.createFamille({ libelle: '   ' }), 'validation');
      const renommee = await repo.updateFamille(f3.id, { libelle: `Vide renommée ${s}` });
      assert.equal(renommee.libelle, `Vide renommée ${s}`);
      assert.equal(renommee.code, f3.code, 'le code reste stable après renommage');
      await refus(repo.updateFamille('00000000-0000-4000-8000-0000000000ff', { libelle: 'X' }), 'not_found');
      const premier = await repo.importFamillesStandard();
      for (const std of FAMILLES_STANDARD) assert.ok(premier.some((x) => x.code === std.code), `famille standard ${std.code}`);
      const second = await repo.importFamillesStandard();
      assert.equal(second.length, premier.length, 'import idempotent');
    });

    it('annuaire : création avec référencements, filtres, validation, unicité du compte rattaché', async () => {
      const { repo, fixtures } = h;
      const mk = (cle: string, nom: string, o: Record<string, unknown>) =>
        repo.createPrestataire({ nom: `${nom} ${s}`, contact_nom: 'Contact', contact_email: `${cle}@exemple.invalid`, ...o } as never).then((r) => { p[cle] = r; });
      await mk('b', 'Bravo', { prestataire_org_id: fixtures.orgIds[0], assurance_expire_le: jour(100), familles: [{ famille_id: f1.id, priorite: 2 }] });
      await mk('a', 'Alpha', { prestataire_org_id: fixtures.orgIds[1], assurance_expire_le: jour(100), familles: [{ famille_id: f1.id, priorite: 1 }, { famille_id: f2.id, priorite: 3 }] });
      await mk('c', 'Charlie', { prestataire_org_id: fixtures.orgIds[2], assurance_expire_le: jour(-2), familles: [{ famille_id: f1.id, priorite: 1 }] });
      await mk('d', 'Delta', { prestataire_org_id: fixtures.orgIds[3], statut: 'suspendu', familles: [{ famille_id: f1.id, priorite: 1 }] });
      await mk('e', 'Echo', { familles: [{ famille_id: f1.id, priorite: 1 }] });
      await mk('f', 'Foxtrot', { prestataire_org_id: fixtures.orgIds[4], familles: [{ famille_id: f2.id, priorite: 1 }] });
      assert.equal(p.a!.statut, 'actif');
      assert.equal(p.e!.prestataire_org_id, null);
      assert.deepEqual(p.a!.familles.map((x) => x.famille_id), [f1.id, f2.id], 'référencements triés par priorité');

      const dansF1 = (await repo.listPrestataires({ famille_id: f1.id })).map((x) => x.nom.split(' ')[0]);
      assert.deepEqual(dansF1, ['Alpha', 'Bravo', 'Charlie', 'Delta', 'Echo']);
      assert.deepEqual((await repo.listPrestataires({ famille_id: f1.id, statut: 'suspendu' })).map((x) => x.nom.split(' ')[0]), ['Delta']);
      assert.deepEqual((await repo.listPrestataires({ q: `echo ${s}` })).map((x) => x.nom.split(' ')[0]), ['Echo']);
      assert.equal((await repo.listFamilles()).find((x) => x.id === f1.id)!.nb_prestataires, 5);
      assert.equal((await repo.getPrestataire(p.a!.id)).nom, p.a!.nom);

      await refus(repo.createPrestataire({ nom: '', familles: [] }), 'validation');
      await refus(repo.createPrestataire({ nom: `X ${s}`, contact_email: 'pas-un-courriel', familles: [] }), 'validation');
      await refus(repo.createPrestataire({ nom: `X ${s}`, familles: [{ famille_id: f1.id, priorite: 0 }] }), 'validation');
      await refus(repo.createPrestataire({ nom: `X ${s}`, familles: [{ famille_id: f1.id, priorite: 1 }, { famille_id: f1.id, priorite: 2 }] }), 'validation');
      await refus(repo.createPrestataire({ nom: `X ${s}`, familles: [{ famille_id: '00000000-0000-4000-8000-0000000000ee', priorite: 1 }] }), 'validation');
      await refus(repo.createPrestataire({ nom: `Doublon ${s}`, prestataire_org_id: fixtures.orgIds[0], familles: [] }), 'conflict');
      await refus(repo.getPrestataire('00000000-0000-4000-8000-0000000000dd'), 'not_found');
    });

    it('annuaire : modification (les référencements sont remplacés seulement s\'ils sont fournis), suspension et réactivation', async () => {
      const { repo } = h;
      const modif = await repo.updatePrestataire(p.f!.id, { zone: 'Zone test' });
      assert.equal(modif.zone, 'Zone test');
      assert.deepEqual(modif.familles.map((x) => x.famille_id), [f2.id], 'référencements conservés');
      const remplace = await repo.updatePrestataire(p.f!.id, { familles: [{ famille_id: f2.id, priorite: 1 }, { famille_id: f3.id, priorite: 1 }] });
      assert.equal(remplace.familles.length, 2);
      const retire = await repo.updatePrestataire(p.f!.id, { familles: [{ famille_id: f2.id, priorite: 1 }] });
      assert.equal(retire.familles.length, 1);
      const suspendu = await repo.setStatutPrestataire(p.f!.id, 'suspendu');
      assert.equal(suspendu.statut, 'suspendu');
      assert.equal((await repo.setStatutPrestataire(p.f!.id, 'actif')).statut, 'actif');
      await refus(repo.updatePrestataire(p.f!.id, { contact_email: 'invalide' }), 'validation');
      await refus(repo.updatePrestataire('00000000-0000-4000-8000-0000000000dd', { zone: 'x' }), 'not_found');
    });

    it('création d\'un ticket : la famille détermine les prestataires éligibles et le premier éligible est suggéré', async () => {
      const { repo, fixtures } = h;
      ticket = await repo.createTicket({ titre: `Fuite ${s}`, description: 'Écoulement', famille_id: f1.id, site_id: fixtures.siteId, local_id: fixtures.localId, priorite: 'p2' });
      assert.equal(ticket.statut, 'nouveau');
      assert.equal(ticket.famille_libelle, f1.libelle);
      assert.equal(ticket.local_id, fixtures.localId);
      assert.equal(ticket.prestataire_actuel, null);
      assert.deepEqual(ticket.historique, []);
      const lignes = ticket.selection.eligibles.map((e) => [e.nom.split(' ')[0], e.eligible, e.raison, e.priorite]);
      assert.deepEqual(lignes, [
        ['Alpha', true, 'ok', 1], ['Bravo', true, 'ok', 2],
        ['Charlie', false, 'assurance_expiree', 1], ['Delta', false, 'suspendu', 1], ['Echo', false, 'non_rattache', 1],
      ]);
      assert.equal(ticket.selection.suggere, p.a!.id);
      const autre = await repo.createTicket({ titre: `Panne ${s}`, famille_id: f2.id, site_id: fixtures.siteId });
      assert.deepEqual(autre.selection.eligibles.map((e) => e.nom.split(' ')[0]), ['Foxtrot', 'Alpha']);
      const vide = await repo.createTicket({ titre: `Sans prestataire ${s}`, famille_id: f3.id, site_id: fixtures.siteId });
      assert.deepEqual(vide.selection, { eligibles: [], suggere: null });
    });

    it('création d\'un ticket : validation (famille désactivée ou inconnue, site ou local incohérent, champs obligatoires)', async () => {
      const { repo, fixtures } = h;
      const eteinte = await repo.createFamille({ libelle: `Éteinte ${s}` });
      await repo.updateFamille(eteinte.id, { actif: false });
      await refus(repo.createTicket({ titre: 'x', famille_id: eteinte.id, site_id: fixtures.siteId }), 'validation');
      await refus(repo.createTicket({ titre: 'x', famille_id: '00000000-0000-4000-8000-0000000000aa', site_id: fixtures.siteId }), 'validation');
      await refus(repo.createTicket({ titre: 'x', famille_id: f1.id, site_id: '00000000-0000-4000-8000-0000000000bb' }), 'validation');
      await refus(repo.createTicket({ titre: 'x', famille_id: f1.id, site_id: fixtures.siteId, local_id: fixtures.localAutreSiteId }), 'validation');
      await refus(repo.createTicket({ titre: '', famille_id: f1.id, site_id: fixtures.siteId }), 'validation');
      await refus(repo.createTicket({ titre: 'x', famille_id: f1.id, site_id: fixtures.siteId, priorite: 'urgent' as never }), 'validation');
    });

    it('affectation : un prestataire éligible est affecté depuis le détail ; la réaffectation clôt la précédente', async () => {
      const { repo } = h;
      const apres = await repo.affecter(ticket.id, { annuaire_id: p.a!.id, motif: 'Suggestion retenue' });
      assert.equal(apres.statut, 'affecte');
      assert.equal(apres.prestataire_actuel, p.a!.nom);
      assert.equal(apres.historique.length, 1);
      assert.equal(apres.historique[0]!.fin_at, null);
      assert.equal(apres.historique[0]!.motif, 'Suggestion retenue');
      await refus(repo.affecter(ticket.id, { annuaire_id: p.a!.id }), 'deja_affecte');
      const re = await repo.affecter(ticket.id, { annuaire_id: p.b!.id, motif: 'Alpha indisponible' });
      assert.equal(re.prestataire_actuel, p.b!.nom);
      assert.equal(re.statut, 'affecte');
      assert.equal(re.historique.length, 2);
      assert.deepEqual(re.historique.map((x) => x.fin_at === null), [true, false], 'la plus récente est en cours, l\'ancienne est clôturée');
      const lu = await repo.getTicket(ticket.id);
      assert.equal(lu.prestataire_actuel, p.b!.nom);
      assert.equal((await repo.listTickets({ famille_id: f1.id })).find((x) => x.id === ticket.id)!.prestataire_actuel, p.b!.nom);
    });

    it('affectation : refus motivé pour un prestataire non éligible, non référencé ou inconnu', async () => {
      const { repo } = h;
      await refus(repo.affecter(ticket.id, { annuaire_id: p.c!.id }), 'non_eligible', 'assurance_expiree');
      await refus(repo.affecter(ticket.id, { annuaire_id: p.d!.id }), 'non_eligible', 'suspendu');
      await refus(repo.affecter(ticket.id, { annuaire_id: p.e!.id }), 'non_eligible', 'non_rattache');
      await refus(repo.affecter(ticket.id, { annuaire_id: p.f!.id }), 'non_eligible', 'famille_non_referencee');
      await refus(repo.affecter(ticket.id, { annuaire_id: '00000000-0000-4000-8000-0000000000cc' }), 'non_eligible', 'famille_non_referencee');
      await refus(repo.affecter(ticket.id, { annuaire_id: 'pas-un-uuid' }), 'validation');
      await refus(repo.affecter('00000000-0000-4000-8000-0000000000dd', { annuaire_id: p.a!.id }), 'not_found');
      assert.equal((await repo.getTicket(ticket.id)).prestataire_actuel, p.b!.nom, 'aucune affectation modifiée par les refus');
    });

    it('l\'éligibilité suit l\'état de l\'annuaire : suspension, réactivation, changement de référencement', async () => {
      const { repo } = h;
      await repo.setStatutPrestataire(p.a!.id, 'suspendu');
      const t = await repo.getTicket(ticket.id);
      assert.deepEqual(t.selection.eligibles.find((e) => e.annuaire_id === p.a!.id), { annuaire_id: p.a!.id, nom: p.a!.nom, priorite: 1, eligible: false, raison: 'suspendu' });
      assert.equal(t.selection.suggere, p.b!.id);
      await repo.setStatutPrestataire(p.a!.id, 'actif');
      assert.equal((await repo.getTicket(ticket.id)).selection.suggere, p.a!.id);
      await repo.updatePrestataire(p.a!.id, { familles: [{ famille_id: f2.id, priorite: 3 }] });
      assert.ok(!(await repo.getTicket(ticket.id)).selection.eligibles.some((e) => e.annuaire_id === p.a!.id), 'plus référencé sur la famille');
      await refus(repo.affecter(ticket.id, { annuaire_id: p.a!.id }), 'non_eligible', 'famille_non_referencee');
    });

    it('listes de tickets : filtres par famille et par statut ; sites et locaux', async () => {
      const { repo, fixtures } = h;
      assert.ok((await repo.listTickets({ famille_id: f2.id })).every((t) => t.famille_id === f2.id));
      const affectes = await repo.listTickets({ statut: 'affecte' });
      assert.ok(affectes.length >= 1 && affectes.every((t) => t.statut === 'affecte'));
      assert.ok((await repo.listSites()).some((x) => x.id === fixtures.siteId));
      assert.ok((await repo.listLocaux(fixtures.siteId)).some((x) => x.id === fixtures.localId));
      assert.ok(!(await repo.listLocaux(fixtures.siteId)).some((x) => x.id === fixtures.localAutreSiteId));
    });
  });
}

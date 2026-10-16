import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import { FAMILLES_STANDARD } from '../familles.js';
import { CALENDRIER_24_7 } from '../sla.js';
import { RepositoryError, type Repository } from '../repository.js';
import type { Famille, Prestataire, TicketDetail } from '../types.js';

export interface ContractHarness {
  repo: Repository;
  fixtures: {
    siteId: string;
    localId: string;
    /** Local d'un AUTRE site, pour tester l'incohérence site / local. */
    localAutreSiteId: string;
    /** Un AUTRE site que `siteId` (périmètre des contrats). */
    autreSiteId: string;
    /** Au moins dix identifiants de comptes prestataires distincts (rattachement). */
    orgIds: string[];
  };
  /**
   * Simule l'acceptation d'une invitation : rattache la fiche à un compte prestataire. Aucune API ne permet de
   * rattacher un compte sans son consentement, donc la suite passe par ce crochet (SQL côté API, méthode de démonstration).
   */
  rattacher: (annuaireId: string, orgId: string) => Promise<void>;
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
      const mk = async (cle: string, nom: string, o: Record<string, unknown>) => {
        const { prestataire_org_id: org, ...champs } = o;
        const cree = await repo.createPrestataire({ nom: `${nom} ${s}`, contact_nom: 'Contact', contact_email: `${cle}@exemple.invalid`, ...champs } as never);
        if (org) await h.rattacher(cree.id, org as string);
        p[cle] = await repo.getPrestataire(cree.id);
      };
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
      const forge = await repo.createPrestataire({ nom: `Forgé ${s}`, prestataire_org_id: fixtures.orgIds[0], familles: [] } as never);
      assert.equal(forge.prestataire_org_id, null, 'un compte ne se rattache pas par identifiant : seule l\'invitation le permet');
      await refus(repo.getPrestataire('00000000-0000-4000-8000-0000000000dd'), 'not_found');
    });

    it('invitation d\'un prestataire : e-mail valide exigé, refus si déjà rattaché ou inconnu, ré-invitation possible, aucun rattachement avant acceptation', async () => {
      const { repo } = h;
      assert.equal(p.e!.invitation_email, null);
      await refus(repo.inviterPrestataire(p.e!.id, 'pas-un-courriel'), 'validation');
      const invite = await repo.inviterPrestataire(p.e!.id, `Echo.${s}@Exemple.invalid`);
      assert.equal(invite.invitation_email, `echo.${s}@exemple.invalid`, 'adresse normalisée');
      assert.ok(invite.invitation_envoyee_le);
      assert.equal(invite.prestataire_org_id, null, 'pas de rattachement tant que le prestataire n\'a pas accepté');
      const encore = await repo.inviterPrestataire(p.e!.id, `echo2.${s}@exemple.invalid`);
      assert.equal(encore.invitation_email, `echo2.${s}@exemple.invalid`);
      await refus(repo.inviterPrestataire(p.a!.id, 'a@exemple.invalid'), 'conflict');
      await refus(repo.inviterPrestataire('00000000-0000-4000-8000-0000000000dd', 'a@exemple.invalid'), 'not_found');
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

    describe('calendriers, contrats, éligibilité par contrat et SLA', () => {
      const BUREAU = [{ jours: [1, 2, 3, 4, 5], debut: '08:00', fin: '12:00' }, { jours: [1, 2, 3, 4, 5], debut: '14:00', fin: '18:00' }];
      const H24 = [{ jours: [1, 2, 3, 4, 5, 6, 7], debut: '00:00', fin: '24:00' }];
      const ID_INCONNU = '00000000-0000-4000-8000-0000000000ab';
      let famille: Famille; let calBureau: string; let cal24: string;
      const pr: Record<string, Prestataire> = {};

      it('calendriers : création, validation, doublon, remplacement complet, introuvable', async () => {
        const { repo } = h;
        const bureau = await repo.createCalendrier({ nom: `Bureau ${s}`, plages: BUREAU, fermetures: [{ du: '2026-12-25', au: '2026-12-25', libelle: 'Noël' }] });
        calBureau = bureau.id;
        assert.equal(bureau.fuseau, 'Europe/Paris');
        assert.deepEqual(bureau.fermetures, [{ du: '2026-12-25', au: '2026-12-25', libelle: 'Noël' }]);
        cal24 = (await repo.createCalendrier({ nom: `24h ${s}`, plages: H24 })).id;
        await refus(repo.createCalendrier({ nom: `Bureau ${s}`, plages: BUREAU }), 'conflict');
        await refus(repo.createCalendrier({ nom: `X ${s}`, plages: [] }), 'validation');
        await refus(repo.createCalendrier({ nom: `X ${s}`, plages: [{ jours: [1], debut: '18:00', fin: '08:00' }] }), 'validation');
        await refus(repo.createCalendrier({ nom: `X ${s}`, plages: [{ jours: [8], debut: '08:00', fin: '18:00' }] }), 'validation');
        await refus(repo.createCalendrier({ nom: `X ${s}`, fuseau: 'Mars/Olympus', plages: BUREAU }), 'validation');
        await refus(repo.createCalendrier({ nom: `X ${s}`, plages: BUREAU, fermetures: [{ du: '2026-12-26', au: '2026-12-25' }] }), 'validation');
        await refus(repo.createCalendrier({ nom: '  ', plages: BUREAU }), 'validation');
        const modifie = await repo.updateCalendrier(calBureau, { nom: `Bureau ${s}`, plages: [{ jours: [1, 2, 3, 4], debut: '09:00', fin: '17:00' }], fermetures: [] });
        assert.deepEqual(modifie.plages, [{ jours: [1, 2, 3, 4], debut: '09:00', fin: '17:00' }]);
        assert.deepEqual(modifie.fermetures, []);
        await repo.updateCalendrier(calBureau, { nom: `Bureau ${s}`, plages: BUREAU });
        await refus(repo.updateCalendrier(calBureau, { nom: `24h ${s}`, plages: BUREAU }), 'conflict');
        await refus(repo.updateCalendrier(ID_INCONNU, { nom: `Z ${s}`, plages: BUREAU }), 'not_found');
        const liste = await repo.listCalendriers();
        assert.ok(liste.some((c) => c.id === calBureau) && liste.some((c) => c.id === cal24));
      });

      it('contrats : création avec périmètre et règles, validation, filtres, remplacement, introuvable', async () => {
        const { repo, fixtures } = h;
        famille = await repo.createFamille({ libelle: `Contrat ${s}` });
        const mk = async (cle: string, nom: string, orgIdx: number) => {
          const c = await repo.createPrestataire({ nom: `${nom} ${s}`, familles: [{ famille_id: famille.id, priorite: orgIdx }] });
          await h.rattacher(c.id, fixtures.orgIds[orgIdx]!);
          pr[cle] = await repo.getPrestataire(c.id);
        };
        await mk('couvert', 'Couvert', 5); await mk('autreSite', 'AutreSite', 6); await mk('echu', 'Echu', 7); await mk('suspendu', 'SuspenduContrat', 8); await mk('sans', 'Sans', 9);
        const base = { annuaire_id: pr.couvert!.id, libelle: `Contrat A ${s}`, date_debut: jour(-30), date_fin: jour(30), calendrier_id: calBureau, perimetre: [{ site_id: fixtures.siteId, famille_id: famille.id }] };
        const c = await repo.createContrat({ ...base, regles: [
          { priorite: 'p2', delai_prise_en_compte_min: 60, delai_resolution_min: 480, calendrier_id: cal24 },
          { priorite: 'p3', delai_prise_en_compte_min: 120, delai_resolution_min: 960 },
        ] });
        assert.equal(c.prestataire_nom, pr.couvert!.nom);
        assert.equal(c.statut, 'actif');
        assert.deepEqual(c.regles.map((r) => [r.priorite, r.calendrier_id]), [['p2', cal24], ['p3', null]]);
        assert.deepEqual(c.perimetre, [{ site_id: fixtures.siteId, famille_id: famille.id }]);
        const sansRegle = await repo.createContrat({ ...base, annuaire_id: pr.autreSite!.id, libelle: `Contrat B ${s}`, perimetre: [{ site_id: fixtures.autreSiteId, famille_id: null }] });
        assert.deepEqual(sansRegle.regles, []);
        assert.equal((await repo.getContrat(c.id)).libelle, c.libelle);
        assert.deepEqual((await repo.listContrats({ annuaire_id: pr.couvert!.id })).map((x) => x.id), [c.id]);
        assert.ok((await repo.listContrats({ statut: 'suspendu' })).every((x) => x.statut === 'suspendu'));

        await refus(repo.createContrat({ ...base, perimetre: [] }), 'validation');
        await refus(repo.createContrat({ ...base, libelle: '' }), 'validation');
        await refus(repo.createContrat({ ...base, date_fin: jour(-31) }), 'validation');
        await refus(repo.createContrat({ ...base, regles: [{ priorite: 'p1', delai_prise_en_compte_min: 60, delai_resolution_min: 30 }] }), 'validation');
        await refus(repo.createContrat({ ...base, regles: [{ priorite: 'p1', delai_prise_en_compte_min: 0, delai_resolution_min: 30 }] }), 'validation');
        await refus(repo.createContrat({ ...base, regles: [{ priorite: 'p1', delai_prise_en_compte_min: 1, delai_resolution_min: 2 }, { priorite: 'p1', delai_prise_en_compte_min: 1, delai_resolution_min: 2 }] }), 'validation');
        await refus(repo.createContrat({ ...base, perimetre: [{ site_id: fixtures.siteId, famille_id: null }, { site_id: fixtures.siteId, famille_id: null }] }), 'validation');
        await refus(repo.createContrat({ ...base, annuaire_id: ID_INCONNU }), 'validation');
        await refus(repo.createContrat({ ...base, calendrier_id: ID_INCONNU }), 'validation');
        await refus(repo.createContrat({ ...base, perimetre: [{ site_id: ID_INCONNU, famille_id: null }] }), 'validation');
        await refus(repo.createContrat({ ...base, perimetre: [{ site_id: fixtures.siteId, famille_id: ID_INCONNU }] }), 'validation');
        await refus(repo.getContrat(ID_INCONNU), 'not_found');

        const maj = await repo.updateContrat(c.id, { notes: 'Note' });
        assert.equal(maj.notes, 'Note');
        assert.equal(maj.regles.length, 2, 'règles conservées quand elles ne sont pas fournies');
        const remplace = await repo.updateContrat(c.id, { regles: [{ priorite: 'p1', delai_prise_en_compte_min: 30, delai_resolution_min: 240 }], perimetre: [{ site_id: fixtures.autreSiteId, famille_id: null }] });
        assert.deepEqual(remplace.regles.map((r) => r.priorite), ['p1']);
        assert.deepEqual(remplace.perimetre, [{ site_id: fixtures.autreSiteId, famille_id: null }]);
        await repo.updateContrat(c.id, { regles: base.perimetre ? [{ priorite: 'p2', delai_prise_en_compte_min: 60, delai_resolution_min: 480, calendrier_id: cal24 }, { priorite: 'p3', delai_prise_en_compte_min: 120, delai_resolution_min: 960 }] : [], perimetre: base.perimetre });
        await refus(repo.updateContrat(c.id, { date_fin: jour(-31) }), 'validation');
        await refus(repo.updateContrat(c.id, { perimetre: [] }), 'validation');
        await refus(repo.updateContrat(ID_INCONNU, { notes: 'x' }), 'not_found');
        await refus(repo.updateContrat(c.id, {} as never), 'validation');
        // contrats complémentaires pour les cas d'éligibilité
        await repo.createContrat({ ...base, annuaire_id: pr.echu!.id, libelle: `Echu ${s}`, date_debut: jour(-60), date_fin: jour(-1), regles: [] });
        await repo.createContrat({ ...base, annuaire_id: pr.suspendu!.id, libelle: `Suspendu ${s}`, statut: 'suspendu', regles: [] });
      });

      it('éligibilité par contrat : sans effet par défaut ; avec « exiger un contrat », motif sans_contrat (autre site, échu, suspendu, absent)', async () => {
        const { repo, fixtures } = h;
        assert.deepEqual(await repo.getParametres(), { exiger_contrat: false });
        const t = await repo.createTicket({ titre: `Contrat ${s}`, famille_id: famille.id, site_id: fixtures.siteId, priorite: 'p2' });
        assert.ok(t.selection.eligibles.every((e) => e.eligible), 'par défaut, aucun contrat n\'est exigé');
        assert.deepEqual(await repo.setParametres({ exiger_contrat: true }), { exiger_contrat: true });
        try {
          const exige = await repo.getTicket(t.id);
          const raison = (cle: string) => exige.selection.eligibles.find((e) => e.annuaire_id === pr[cle]!.id)!.raison;
          assert.equal(raison('couvert'), 'ok');
          assert.equal(raison('autreSite'), 'sans_contrat', 'le contrat couvre un autre site');
          assert.equal(raison('echu'), 'sans_contrat', 'contrat échu hier');
          assert.equal(raison('suspendu'), 'sans_contrat', 'contrat suspendu');
          assert.equal(raison('sans'), 'sans_contrat', 'aucun contrat');
          assert.equal(exige.selection.suggere, pr.couvert!.id);
          await refus(repo.affecter(t.id, { annuaire_id: pr.autreSite!.id }), 'non_eligible', 'sans_contrat');
          // famille NULL = toutes les familles ; une ligne de périmètre pour ce site suffit
          const larges = await repo.createContrat({ annuaire_id: pr.sans!.id, libelle: `Large ${s}`, date_debut: jour(0), perimetre: [{ site_id: fixtures.siteId, famille_id: null }], regles: [] });
          assert.equal((await repo.getTicket(t.id)).selection.eligibles.find((e) => e.annuaire_id === pr.sans!.id)!.raison, 'ok', 'contrat à date de début = aujourd\'hui, famille = toutes');
          await repo.updateContrat(larges.id, { statut: 'suspendu' });
          assert.equal((await repo.getTicket(t.id)).selection.eligibles.find((e) => e.annuaire_id === pr.sans!.id)!.raison, 'sans_contrat');
        } finally {
          await repo.setParametres({ exiger_contrat: false });
        }
        await refus(repo.setParametres({ exiger_contrat: 'oui' as never }), 'validation');
        assert.equal((await repo.getTicket(t.id)).selection.eligibles.find((e) => e.annuaire_id === pr.autreSite!.id)!.raison, 'ok');
      });

      it('SLA : l\'affectation ouvre la prise en compte (depuis l\'affectation) et la résolution (depuis la création) ; la réaffectation les remplace', async () => {
        const { repo, fixtures } = h;
        const t = await repo.createTicket({ titre: `SLA ${s}`, famille_id: famille.id, site_id: fixtures.siteId, priorite: 'p2' });
        assert.deepEqual(t.sla, []);
        const a = await repo.affecter(t.id, { annuaire_id: pr.couvert!.id });
        assert.deepEqual(a.sla.map((x) => x.type), ['prise_en_compte', 'resolution']);
        const [pec, res] = a.sla as [typeof a.sla[number], typeof a.sla[number]];
        const ms = (x: string) => new Date(x).getTime();
        assert.equal(pec.delai_minutes, 60);
        assert.equal(ms(pec.depart_at), ms(a.historique[0]!.affecte_at));
        assert.equal(ms(pec.echeance_at) - ms(pec.depart_at), 60 * 60_000, 'calendrier 24/7 de la règle : minutes réelles');
        assert.equal(res.delai_minutes, 480);
        assert.equal(ms(res.depart_at), ms(a.created_at));
        assert.equal(ms(res.echeance_at) - ms(res.depart_at), 480 * 60_000);
        assert.equal(res.etat, 'en_cours');
        assert.equal(pec.contrat_libelle, `Contrat A ${s}`);
        // priorité sans règle : pas de SLA, et ce n'est pas une erreur
        const sansRegle = await repo.createTicket({ titre: `Sans règle ${s}`, famille_id: famille.id, site_id: fixtures.siteId, priorite: 'p4' });
        assert.deepEqual((await repo.affecter(sansRegle.id, { annuaire_id: pr.couvert!.id })).sla, []);
        // réaffectation vers un prestataire sans contrat actif couvrant : les anciennes échéances ne sont plus suivies
        const re = await repo.affecter(t.id, { annuaire_id: pr.sans!.id });
        assert.deepEqual(re.sla, []);
        assert.equal((await repo.getTicket(t.id)).sla.length, 0);
      });

      it('SLA : calendrier de bureau du contrat (règle sans calendrier propre) → échéance en minutes ouvrées', async () => {
        const { repo, fixtures } = h;
        const t = await repo.createTicket({ titre: `Ouvré ${s}`, famille_id: famille.id, site_id: fixtures.siteId, priorite: 'p3' });
        const a = await repo.affecter(t.id, { annuaire_id: pr.couvert!.id });
        const [pec] = a.sla;
        // Même calcul que le serveur, avec le calendrier du contrat (bureau) : la suite vérifie le branchement, sla.test.ts le calcul.
        const { echeanceOuvree } = await import('../sla.js');
        const attendu = echeanceOuvree(new Date(pec!.depart_at), 120, { fuseau: 'Europe/Paris', plages: BUREAU, fermetures: [] });
        assert.equal(new Date(pec!.echeance_at).getTime(), attendu.getTime());
        assert.ok(CALENDRIER_24_7.plages.length === 1);
      });
    });
  });
}

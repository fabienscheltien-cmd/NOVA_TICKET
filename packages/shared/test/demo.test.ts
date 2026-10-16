import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { DemoRepository } from '../src/demo.js';
import { creerDonneesDemo } from '../src/demo-data.js';
import { aujourdhuiParis } from '../src/eligibilite.js';
import { runRepositoryContract } from '../src/testing/contract.js';

const uuid = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;

runRepositoryContract('DemoRepository', () => {
  const repo = new DemoRepository();
  return {
    repo,
    fixtures: {
      siteId: uuid(300), localId: uuid(400), localAutreSiteId: uuid(403),
      orgIds: [uuid(801), uuid(802), uuid(803), uuid(804), uuid(805)],
    },
  };
});

describe('jeu de démonstration', () => {
  it('est cohérent : familles, annuaire, tickets, et chaque cas d\'éligibilité est représenté', async () => {
    const repo = new DemoRepository();
    const familles = await repo.listFamilles();
    assert.equal(familles.length, 12);
    const prestataires = await repo.listPrestataires();
    assert.ok(prestataires.length >= 8);
    assert.ok(prestataires.every((p) => /démo/i.test(p.nom)), 'tout nom de démonstration est signalé « démo »');
    const raisons = new Set<string>();
    for (const t of await repo.listTickets()) {
      for (const l of (await repo.getTicket(t.id)).selection.eligibles) raisons.add(l.raison);
    }
    assert.deepEqual([...raisons].sort(), ['assurance_expiree', 'non_rattache', 'ok', 'suspendu']);
    const tickets = await repo.listTickets();
    assert.ok(tickets.some((t) => t.statut === 'nouveau') && tickets.some((t) => t.statut === 'affecte'));
    assert.ok(familles.every((f) => f.nb_prestataires >= 0));
  });
  it('les échéances restent pertinentes quelle que soit la date', () => {
    const d = creerDonneesDemo('2031-03-04');
    assert.ok(d.prestataires.some((p) => p.assurance_expire_le !== null && p.assurance_expire_le < '2031-03-04'));
    assert.ok(d.prestataires.some((p) => p.assurance_expire_le !== null && p.assurance_expire_le > '2031-03-04'));
  });
  it('reset() restaure les données d\'origine', async () => {
    const repo = new DemoRepository();
    await repo.createFamille({ libelle: 'Temporaire' });
    assert.equal((await repo.listFamilles()).length, 13);
    repo.reset();
    assert.equal((await repo.listFamilles()).length, 12);
  });
  it('utilise l\'horloge injectée pour l\'éligibilité', async () => {
    const seed = creerDonneesDemo('2026-01-01');
    const futur = new DemoRepository({ seed, today: () => '2040-01-01' });
    const t = (await futur.listTickets()).find((x) => x.famille_libelle === 'Plomberie')!;
    const sel = (await futur.getTicket(t.id)).selection;
    assert.equal(sel.suggere, null, 'à cette date, toutes les assurances sont échues');
    assert.ok(aujourdhuiParis() >= '2026-10-16');
  });
});

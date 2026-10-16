import { screen, within } from '@testing-library/react';
import { RepositoryError } from '@nova/shared';
import { avecPannes, demo, renderApp } from './helpers';

const lignes = () => screen.getAllByRole('row').slice(1);
const ligne = (nom: RegExp) => lignes().find((r) => nom.test(r.textContent ?? ''))!;

describe('contrats de service', () => {
  it('liste : prestataire, période, périmètre, délais, état (en cours, échu)', async () => {
    renderApp('/contrats');
    expect(await screen.findByRole('heading', { name: 'Contrats de service' })).toBeInTheDocument();
    await screen.findAllByRole('row');
    const horizon = within(ligne(/Plomberie et CVC/));
    expect(horizon.getByText(/Hydro-Services/)).toBeInTheDocument();
    expect(horizon.getByText(/Tour Horizon \(démo\) · Plomberie/)).toBeInTheDocument();
    expect(horizon.getByText(/P2 : prise en compte 2 h, résolution 16 h/)).toBeInTheDocument();
    expect(horizon.getByText('En cours')).toBeInTheDocument();
    expect(within(ligne(/contrat échu/)).getByText('Échu')).toBeInTheDocument();
    expect(within(ligne(/Électricité — tous sites/)).getByText('Aucun délai défini')).toBeInTheDocument();
  });

  it('exiger un contrat : bascule enregistrée et annoncée, effet sur l\'éligibilité', async () => {
    const { user, repo } = renderApp('/contrats');
    const case_ = await screen.findByRole('checkbox', { name: /Exiger un contrat actif/ });
    expect(case_).not.toBeChecked();
    await user.click(case_);
    expect(await screen.findByText(/Un contrat actif est désormais exigé/)).toBeInTheDocument();
    expect(await repo.getParametres()).toEqual({ exiger_contrat: true });
    expect(await screen.findByRole('checkbox', { name: /Exiger un contrat actif/ })).toBeChecked();
  });

  it('suspend puis réactive un contrat', async () => {
    const { user, repo } = renderApp('/contrats');
    await screen.findAllByRole('row');
    await user.click(within(ligne(/Plomberie — Résidence des Lilas/)).getByRole('button', { name: /Suspendre/ }));
    expect(await screen.findByText(/est maintenant suspendu/)).toBeInTheDocument();
    expect((await repo.listContrats()).find((c) => /Résidence des Lilas/.test(c.libelle))!.statut).toBe('suspendu');
    expect(within(ligne(/Plomberie — Résidence des Lilas/)).getByText('Suspendu')).toBeInTheDocument();
  });

  it('ajoute un contrat : validation puis création avec périmètre et délais', async () => {
    const { user, repo } = renderApp('/contrats');
    await screen.findAllByRole('row');
    await user.click(screen.getByRole('button', { name: 'Ajouter un contrat' }));
    const f = await screen.findByRole('dialog', { name: /Ajouter un contrat/ });
    await user.click(within(f).getByRole('button', { name: 'Enregistrer' }));
    expect(within(f).getByText('Choisissez un prestataire.')).toBeInTheDocument();
    expect(within(f).getByText('Le libellé est obligatoire.')).toBeInTheDocument();
    await user.selectOptions(within(f).getByLabelText(/Prestataire/), 'Net-Propre (démo)');
    await user.type(within(f).getByLabelText(/Libellé/), 'Nettoyage Atlas (test)');
    await user.selectOptions(within(f).getByLabelText('Site'), 'Centre commercial Atlas (démo)');
    await user.selectOptions(within(f).getByLabelText('Famille'), 'Nettoyage');
    const p3 = within(within(f).getByRole('group', { name: /Délais Normale \(P3\)/ }));
    await user.click(p3.getByRole('checkbox'));
    await user.type(p3.getByLabelText(/Prise en compte/), '90');
    await user.type(p3.getByLabelText(/Résolution/), '60');
    await user.click(within(f).getByRole('button', { name: 'Enregistrer' }));
    expect(within(f).getByText(/la résolution ne peut pas être plus courte/)).toBeInTheDocument();
    await user.clear(p3.getByLabelText(/Résolution/));
    await user.type(p3.getByLabelText(/Résolution/), '480');
    await user.click(within(f).getByRole('button', { name: 'Enregistrer' }));
    expect(await screen.findByText('Le contrat « Nettoyage Atlas (test) » a été créé.')).toBeInTheDocument();
    const cree = (await repo.listContrats()).find((c) => c.libelle.startsWith('Nettoyage Atlas'))!;
    expect(cree.regles).toEqual([{ priorite: 'p3', delai_prise_en_compte_min: 90, delai_resolution_min: 480, calendrier_id: null }]);
    expect(cree.perimetre).toHaveLength(1);
    expect(within(ligne(/Nettoyage Atlas/)).getByText(/P3 : prise en compte 1 h 30 min, résolution 8 h/)).toBeInTheDocument();
  });

  it('modifie un contrat existant et conserve ses règles', async () => {
    const { user, repo } = renderApp('/contrats');
    await screen.findAllByRole('row');
    await user.click(within(ligne(/Plomberie — Résidence des Lilas/)).getByRole('button', { name: /Modifier/ }));
    const f = await screen.findByRole('dialog');
    const champ = within(f).getByLabelText(/Libellé/);
    await user.clear(champ);
    await user.type(champ, 'Plomberie Lilas renouvelé');
    await user.click(within(f).getByRole('button', { name: 'Enregistrer' }));
    expect(await screen.findByText(/« Plomberie Lilas renouvelé » a été mis à jour/)).toBeInTheDocument();
    expect((await repo.listContrats()).find((c) => c.libelle === 'Plomberie Lilas renouvelé')!.regles).toHaveLength(1);
  });

  it('refus du serveur : message dans la fenêtre, qui reste ouverte', async () => {
    const base = demo();
    const { user } = renderApp('/contrats', avecPannes(base, { updateContrat: [new RepositoryError('validation', 'perimetre : site inconnu')] }));
    await screen.findAllByRole('row');
    await user.click(within(ligne(/Plomberie — Résidence des Lilas/)).getByRole('button', { name: /Modifier/ }));
    const f = await screen.findByRole('dialog');
    await user.click(within(f).getByRole('button', { name: 'Enregistrer' }));
    expect(await within(f).findByRole('alert')).toHaveTextContent('site inconnu');
  });

  it('chargement, erreur réseau avec nouvel essai, et état vide', async () => {
    const base = demo();
    const { user } = renderApp('/contrats', avecPannes(base, { listContrats: [new RepositoryError('network', 'Le serveur est injoignable')] }));
    expect(screen.getByText('Chargement des contrats…')).toBeInTheDocument();
    expect(await screen.findByRole('alert')).toHaveTextContent('Le serveur est injoignable');
    await user.click(screen.getByRole('button', { name: 'Réessayer' }));
    expect(await screen.findByRole('heading', { name: 'Contrats de service' })).toBeInTheDocument();
    await screen.findAllByRole('row');
  });

  it('aucun contrat : état vide avec action', async () => {
    renderApp('/contrats', demo((d) => { d.contrats = []; d.sla = []; }));
    expect(await screen.findByText('Aucun contrat')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Ajouter le premier contrat' })).toBeInTheDocument();
  });
});

describe('calendriers ouvrés', () => {
  it('liste les plages et les fermetures', async () => {
    renderApp('/calendriers');
    await screen.findAllByRole('row');
    const bureau = within(ligne(/Heures de bureau/));
    expect(bureau.getAllByText(/Lun–Ven/)).toHaveLength(2);
    expect(bureau.getByText(/08:00–12:00/)).toBeInTheDocument();
    expect(bureau.getByText(/Fermeture exceptionnelle/)).toBeInTheDocument();
    expect(within(ligne(/Astreinte 24/)).getByText('Aucune')).toBeInTheDocument();
  });

  it('crée un calendrier : nom obligatoire, plages et fermeture saisies', async () => {
    const { user, repo } = renderApp('/calendriers');
    await screen.findAllByRole('row');
    await user.click(screen.getByRole('button', { name: 'Ajouter un calendrier' }));
    const f = await screen.findByRole('dialog');
    await user.click(within(f).getByRole('button', { name: 'Enregistrer' }));
    expect(within(f).getByText('Le nom est obligatoire.')).toBeInTheDocument();
    await user.type(within(f).getByLabelText(/Nom/), 'Samedi matin (test)');
    const plage = within(within(f).getByRole('group', { name: 'Plage 1' }));
    await user.click(plage.getByRole('checkbox', { name: 'Sam' }));
    await user.click(within(f).getByRole('button', { name: 'Ajouter une fermeture' }));
    const fermeture = within(within(f).getByRole('group', { name: 'Fermeture 1' }));
    await user.type(fermeture.getByLabelText('Du'), '2026-12-25');
    await user.type(fermeture.getByLabelText('Libellé'), 'Noël');
    await user.click(within(f).getByRole('button', { name: 'Enregistrer' }));
    expect(await screen.findByText('Le calendrier « Samedi matin (test) » a été créé.')).toBeInTheDocument();
    const cree = (await repo.listCalendriers()).find((c) => c.nom.startsWith('Samedi'))!;
    expect(cree.plages[0]!.jours).toEqual([1, 2, 3, 4, 5, 6]);
    expect(cree.fermetures).toEqual([{ du: '2026-12-25', au: '2026-12-25', libelle: 'Noël' }]);
  });

  it('refus du serveur (jours exclus) : message dans la fenêtre', async () => {
    const { user } = renderApp('/calendriers');
    await screen.findAllByRole('row');
    await user.click(screen.getByRole('button', { name: 'Ajouter un calendrier' }));
    const f = await screen.findByRole('dialog');
    await user.type(within(f).getByLabelText(/Nom/), 'Sans jour');
    const plage = within(within(f).getByRole('group', { name: 'Plage 1' }));
    for (const j of ['Lun', 'Mar', 'Mer', 'Jeu', 'Ven']) await user.click(plage.getByRole('checkbox', { name: j }));
    await user.click(within(f).getByRole('button', { name: 'Enregistrer' }));
    expect(await within(f).findByRole('alert')).toBeInTheDocument();
  });
});

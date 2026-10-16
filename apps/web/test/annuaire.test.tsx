import { screen, within } from '@testing-library/react';
import { RepositoryError } from '@nova/shared';
import { avecPannes, demo, renderApp } from './helpers';

const lignes = () => screen.getAllByRole('row').slice(1);
const ligne = (nom: RegExp) => lignes().find((r) => nom.test(r.textContent ?? ''))!;

describe('annuaire des prestataires', () => {
  it('liste les prestataires avec leurs familles, priorités, assurance, compte et statut', async () => {
    renderApp('/annuaire');
    expect(await screen.findByRole('heading', { name: 'Annuaire des prestataires' })).toBeInTheDocument();
    expect(await screen.findAllByRole('row')).toHaveLength(11);
    const hydro = within(ligne(/Hydro-Services/));
    expect(hydro.getByText(/Plomberie/)).toBeInTheDocument();
    expect(hydro.getByLabelText('priorité 1')).toBeInTheDocument();
    expect(within(ligne(/Électro-Plus/)).getByText('Échue')).toBeInTheDocument();
    expect(within(ligne(/Aqua-Rapide/)).getByText('Échéance proche')).toBeInTheDocument();
    expect(within(ligne(/ClimaConfort/)).getByText('Suspendu')).toBeInTheDocument();
    expect(within(ligne(/Thermi-Air/)).getByText('Non rattaché')).toBeInTheDocument();
  });

  it('filtre par famille, par statut et par recherche ; réinitialise les filtres', async () => {
    const { user } = renderApp('/annuaire');
    await screen.findAllByRole('row');
    await user.selectOptions(screen.getByLabelText('Famille'), 'Serrurerie');
    expect(await screen.findByText(/Clés & Sécurité/)).toBeInTheDocument();
    expect(lignes()).toHaveLength(2);
    await user.selectOptions(screen.getByLabelText('Statut'), 'suspendu');
    expect(await screen.findByText('Aucun prestataire ne correspond à ces filtres')).toBeInTheDocument();
    await user.click(screen.getAllByRole('button', { name: 'Réinitialiser les filtres' })[0]!);
    expect(await screen.findAllByRole('row')).toHaveLength(11);
    await user.type(screen.getByLabelText('Rechercher'), 'hydro');
    expect(await screen.findByText(/Hydro-Services/)).toBeInTheDocument();
    expect(lignes()).toHaveLength(1);
  });

  it('ajoute un prestataire : validation, puis création avec famille et priorité', async () => {
    const { user, repo } = renderApp('/annuaire');
    await screen.findAllByRole('row');
    await user.click(screen.getByRole('button', { name: 'Ajouter un prestataire' }));
    const dialogue = await screen.findByRole('dialog', { name: 'Ajouter un prestataire' });
    expect(dialogue).toContainElement(document.activeElement as HTMLElement);
    await user.type(within(dialogue).getByLabelText('Adresse e-mail du contact'), 'pas-un-courriel');
    await user.click(within(dialogue).getByRole('button', { name: 'Ajouter' }));
    expect(await within(dialogue).findByText('Le nom est obligatoire.')).toBeInTheDocument();
    expect(within(dialogue).getByText('Adresse e-mail invalide.')).toBeInTheDocument();
    expect(within(dialogue).getByLabelText(/Nom du prestataire/)).toHaveAttribute('aria-invalid', 'true');

    await user.type(within(dialogue).getByLabelText(/Nom du prestataire/), 'Plombiers Associés (test)');
    await user.clear(within(dialogue).getByLabelText('Adresse e-mail du contact'));
    await user.click(within(dialogue).getByRole('checkbox', { name: 'Plomberie' }));
    const prio = within(dialogue).getByLabelText('Priorité pour Plomberie');
    await user.clear(prio);
    await user.type(prio, '3');
    await user.click(within(dialogue).getByRole('button', { name: 'Ajouter' }));

    expect(await screen.findByText('Plombiers Associés (test) a été ajouté à l\'annuaire.')).toBeInTheDocument();
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    const cree = (await repo.listPrestataires({ q: 'Plombiers' }))[0]!;
    expect(cree.familles).toEqual([{ famille_id: (await repo.listFamilles()).find((f) => f.code === 'plomberie')!.id, priorite: 3 }]);
    expect(within(await screen.findByRole('row', { name: /Plombiers Associés/ })).getByText('Non rattaché')).toBeInTheDocument();
  });

  it('modifie les familles d\'un prestataire existant', async () => {
    const { user, repo } = renderApp('/annuaire');
    await screen.findAllByRole('row');
    await user.click(screen.getByRole('button', { name: 'Modifier Net-Propre (démo)' }));
    const dialogue = await screen.findByRole('dialog', { name: /Modifier Net-Propre/ });
    expect(within(dialogue).getByRole('checkbox', { name: 'Nettoyage' })).toBeChecked();
    await user.click(within(dialogue).getByRole('checkbox', { name: 'Espaces verts' }));
    await user.click(within(dialogue).getByRole('checkbox', { name: 'Serrurerie' }));
    await user.click(within(dialogue).getByRole('button', { name: 'Enregistrer' }));
    expect(await screen.findByText('Net-Propre (démo) a été mis à jour.')).toBeInTheDocument();
    const p = (await repo.listPrestataires({ q: 'Net-Propre' }))[0]!;
    const codes = (await repo.listFamilles()).filter((f) => p.familles.some((r) => r.famille_id === f.id)).map((f) => f.code).sort();
    expect(codes).toEqual(['nettoyage', 'serrurerie']);
  });

  it('suspend puis réactive un prestataire, avec confirmation annoncée', async () => {
    const { user } = renderApp('/annuaire');
    await screen.findAllByRole('row');
    await user.click(screen.getByRole('button', { name: 'Suspendre Aqua-Rapide (démo)' }));
    expect(await screen.findByText('Aqua-Rapide (démo) est maintenant suspendu.')).toBeInTheDocument();
    expect(within(ligne(/Aqua-Rapide/)).getByText('Suspendu')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Réactiver Aqua-Rapide (démo)' }));
    expect(await screen.findByText('Aqua-Rapide (démo) est maintenant actif.')).toBeInTheDocument();
  });

  it('affiche l\'erreur du serveur dans la fenêtre sans la fermer', async () => {
    const repo = avecPannes(demo(), { createPrestataire: [new RepositoryError('conflict', 'Ce compte prestataire est déjà dans l\'annuaire')] });
    const { user } = renderApp('/annuaire', repo);
    await screen.findAllByRole('row');
    await user.click(screen.getByRole('button', { name: 'Ajouter un prestataire' }));
    const dialogue = await screen.findByRole('dialog');
    await user.type(within(dialogue).getByLabelText(/Nom du prestataire/), 'X');
    await user.click(within(dialogue).getByRole('button', { name: 'Ajouter' }));
    expect(await within(dialogue).findByRole('alert')).toHaveTextContent('Ce compte prestataire est déjà dans l\'annuaire');
    expect(screen.getByRole('dialog')).toBeInTheDocument();
  });

  it('état de chargement puis erreur réseau avec nouvel essai', async () => {
    const repo = avecPannes(demo(), { listPrestataires: [new RepositoryError('network', 'x'), new RepositoryError('network', 'x')] });
    const { user } = renderApp('/annuaire', repo);
    expect(await screen.findByRole('alert')).toHaveTextContent('Le serveur est injoignable');
    await user.click(screen.getByRole('button', { name: 'Réessayer' }));
    expect(await screen.findByText(/Hydro-Services/)).toBeInTheDocument();
  });

  it('annuaire vide : invite à créer les familles puis le premier prestataire', async () => {
    const repo = demo((d) => { d.prestataires = []; d.familles = []; d.tickets = []; d.affectations = []; });
    renderApp('/annuaire', repo);
    expect(await screen.findByText('Votre annuaire est vide')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: /créer ou importer vos familles/ })).toHaveAttribute('href', '/familles');
    expect(screen.getByRole('button', { name: 'Ajouter le premier prestataire' })).toBeInTheDocument();
  });

  it('Échap ferme la fenêtre et rend le focus au bouton d\'origine', async () => {
    const { user } = renderApp('/annuaire');
    await screen.findAllByRole('row');
    const bouton = screen.getByRole('button', { name: 'Ajouter un prestataire' });
    await user.click(bouton);
    await screen.findByRole('dialog');
    await user.keyboard('{Escape}');
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    expect(bouton).toHaveFocus();
  });
});

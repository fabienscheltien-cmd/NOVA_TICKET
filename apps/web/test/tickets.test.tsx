import { screen, within } from '@testing-library/react';
import { RepositoryError } from '@nova/shared';
import { avecPannes, demo, renderApp } from './helpers';

describe('liste et création de tickets', () => {
  it('liste les tickets avec famille, lieu, priorité, statut et prestataire', async () => {
    renderApp('/tickets');
    expect(await screen.findAllByRole('row')).toHaveLength(7);
    const affecte = screen.getByRole('row', { name: /Chauffe-eau du logement 12/ });
    expect(within(affecte).getByText('Hydro-Services (démo)')).toBeInTheDocument();
    expect(within(affecte).getByText('Affecté')).toBeInTheDocument();
    expect(within(screen.getByRole('row', { name: /Serrure de la porte du hall/ })).getByText('Urgente (P1)')).toBeInTheDocument();
    expect(within(screen.getByRole('row', { name: /Fuite sous le lavabo/ })).getByText('Non affecté')).toBeInTheDocument();
  });

  it('filtre par statut et par famille', async () => {
    const { user } = renderApp('/tickets');
    await screen.findAllByRole('row');
    await user.selectOptions(screen.getByLabelText('Statut'), 'Affecté');
    expect(await screen.findByText(/Chauffe-eau/)).toBeInTheDocument();
    expect(screen.getAllByRole('row')).toHaveLength(2);
    await user.selectOptions(screen.getByLabelText('Statut'), 'Tous');
    await user.selectOptions(screen.getByLabelText('Famille'), 'Électricité');
    expect(await screen.findByText(/Prises de courant/)).toBeInTheDocument();
    expect(screen.getAllByRole('row')).toHaveLength(2);
  });

  it('aucun ticket : état vide avec appel à l\'action', async () => {
    renderApp('/tickets', demo((d) => { d.tickets = []; d.affectations = []; }));
    expect(await screen.findByText('Aucun ticket pour le moment')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Créer le premier ticket' })).toBeInTheDocument();
  });

  it('création : champs obligatoires contrôlés, aperçu des éligibles, puis détail du ticket avec la sélection', async () => {
    const { user, repo } = renderApp('/tickets');
    await screen.findAllByRole('row');
    await user.click(screen.getByRole('button', { name: 'Nouveau ticket' }));
    const d = await screen.findByRole('dialog', { name: 'Nouveau ticket' });
    await user.click(within(d).getByRole('button', { name: 'Créer le ticket' }));
    expect(await within(d).findByText('Le titre est obligatoire.')).toBeInTheDocument();
    expect(within(d).getByText('Choisissez la famille du ticket.')).toBeInTheDocument();
    expect(within(d).getByText('Choisissez le site concerné.')).toBeInTheDocument();

    await user.type(within(d).getByLabelText(/Titre/), 'Robinet qui goutte');
    await user.selectOptions(within(d).getByLabelText(/Famille du ticket/), 'Plomberie');
    expect(await within(d).findByText(/2 prestataires éligibles : Aqua-Rapide \(démo\), Hydro-Services \(démo\)|2 prestataires éligibles : Hydro-Services \(démo\), Aqua-Rapide \(démo\)/)).toBeInTheDocument();
    expect(within(d).getByLabelText('Local')).toBeDisabled();
    await user.selectOptions(within(d).getByLabelText(/Site/), 'Résidence des Lilas (démo)');
    await user.selectOptions(within(d).getByLabelText('Local'), 'Logement 12');
    await user.selectOptions(within(d).getByLabelText('Priorité'), 'Haute (P2)');
    await user.click(within(d).getByRole('button', { name: 'Créer le ticket' }));

    expect(await screen.findByRole('heading', { name: 'Robinet qui goutte' })).toBeInTheDocument();
    expect(await screen.findByText(/Ticket créé\. Les prestataires éligibles pour la famille « Plomberie »/)).toBeInTheDocument();
    const choisi = screen.getByRole('radio', { checked: true });
    expect(choisi).toHaveAccessibleName(/Hydro-Services/);
    const ticket = (await repo.listTickets()).find((t) => t.titre === 'Robinet qui goutte')!;
    expect([ticket.priorite, ticket.local_nom, ticket.statut]).toEqual(['p2', 'Logement 12', 'nouveau']);
  });

  it('famille sans prestataire éligible : l\'aperçu prévient, le ticket est créé mais le détail oriente vers l\'annuaire', async () => {
    const { user } = renderApp('/tickets');
    await screen.findAllByRole('row');
    await user.click(screen.getByRole('button', { name: 'Nouveau ticket' }));
    const d = await screen.findByRole('dialog');
    await user.type(within(d).getByLabelText(/Titre/), 'Peinture écaillée');
    await user.selectOptions(within(d).getByLabelText(/Famille du ticket/), 'Peinture et revêtements');
    expect(await within(d).findByText(/Aucun prestataire éligible pour cette famille/)).toBeInTheDocument();
    await user.selectOptions(within(d).getByLabelText(/Site/), 'Tour Horizon (démo)');
    await user.click(within(d).getByRole('button', { name: 'Créer le ticket' }));
    expect(await screen.findByText(/Aucun prestataire n'est référencé sur la famille « Peinture et revêtements »/)).toBeInTheDocument();
    expect(screen.getByRole('link', { name: "Compléter l'annuaire" })).toHaveAttribute('href', expect.stringMatching(/^\/annuaire\?famille=/));
    expect(screen.queryByRole('button', { name: /Affecter/ })).not.toBeInTheDocument();
  });

  it('les familles désactivées ne sont pas proposées à la création', async () => {
    const { user, repo } = renderApp('/tickets');
    await screen.findAllByRole('row');
    const fam = (await repo.listFamilles()).find((f) => f.code === 'nettoyage')!;
    await repo.updateFamille(fam.id, { actif: false });
    await user.click(screen.getByRole('button', { name: 'Nouveau ticket' }));
    const d = await screen.findByRole('dialog');
    await within(d).findByRole('option', { name: 'Plomberie' });
    expect(within(d).queryByRole('option', { name: 'Nettoyage' })).not.toBeInTheDocument();
  });

  it('erreur serveur à la création : message dans la fenêtre', async () => {
    const repo = avecPannes(demo(), { createTicket: [new RepositoryError('validation', 'famille_id : cette famille est désactivée')] });
    const { user } = renderApp('/tickets', repo);
    await screen.findAllByRole('row');
    await user.click(screen.getByRole('button', { name: 'Nouveau ticket' }));
    const d = await screen.findByRole('dialog');
    await user.type(within(d).getByLabelText(/Titre/), 'X');
    await user.selectOptions(within(d).getByLabelText(/Famille du ticket/), 'Plomberie');
    await user.selectOptions(within(d).getByLabelText(/Site/), 'Tour Horizon (démo)');
    await user.click(within(d).getByRole('button', { name: 'Créer le ticket' }));
    expect(await within(d).findByRole('alert')).toHaveTextContent('cette famille est désactivée');
  });
});

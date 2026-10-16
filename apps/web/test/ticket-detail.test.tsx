import { screen, within } from '@testing-library/react';
import { RepositoryError } from '@nova/shared';
import { avecPannes, demo, renderApp } from './helpers';

async function ouvrir(titre: RegExp, repo = demo()) {
  const r = renderApp('/tickets', repo);
  await r.user.click(await screen.findByRole('link', { name: titre }));
  await screen.findByRole('group', { name: /Prestataires référencés/ });
  return r;
}

describe('détail du ticket et affectation', () => {
  it('le premier prestataire éligible (priorité 1) est présélectionné et marqué « Suggéré »', async () => {
    await ouvrir(/Fuite sous le lavabo/);
    expect(screen.getByRole('radio', { checked: true })).toHaveAccessibleName(/Hydro-Services/);
    const hydro = screen.getByRole('radio', { name: /Hydro-Services/ }).closest('li')!;
    expect(within(hydro).getByText('Suggéré')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Affecter à Hydro-Services (démo)' })).toBeEnabled();
  });

  it('les prestataires exclus restent visibles, désactivés, avec le motif', async () => {
    await ouvrir(/Climatisation en panne/);
    const suspendu = screen.getByRole('radio', { name: /ClimaConfort/ });
    expect(suspendu).toBeDisabled();
    expect(within(suspendu.closest('li')!).getByText('Prestataire suspendu')).toBeInTheDocument();
    expect(screen.getByRole('radio', { name: /Thermi-Air/ })).toBeDisabled();
    expect(screen.getByText('Pas encore rattaché à un compte NOVA')).toBeInTheDocument();
    expect(screen.getByRole('radio', { checked: true })).toHaveAccessibleName(/Hydro-Services/);
  });

  it('assurance échue : Électro-Plus exclu, Courant-Fort proposé à la place', async () => {
    await ouvrir(/Prises de courant/);
    expect(screen.getByRole('radio', { name: /Électro-Plus/ })).toBeDisabled();
    expect(screen.getByText("Attestation d'assurance échue")).toBeInTheDocument();
    expect(screen.getByRole('radio', { checked: true })).toHaveAccessibleName(/Courant-Fort/);
  });

  it('affecte depuis le détail : confirmation annoncée, statut, prestataire et historique mis à jour', async () => {
    const { user, repo } = await ouvrir(/Fuite sous le lavabo/);
    await user.type(screen.getByLabelText('Motif (facultatif)'), 'Intervention sous 4 h');
    await user.click(screen.getByRole('button', { name: 'Affecter à Hydro-Services (démo)' }));
    expect(await screen.findByText('Ticket affecté à Hydro-Services (démo).')).toBeInTheDocument();
    expect(screen.getAllByText('Affecté').length).toBeGreaterThan(0);
    expect(screen.getByRole('button', { name: 'Réaffecter à Aqua-Rapide (démo)' })).toBeInTheDocument();
    expect(screen.getByText(/Motif : Intervention sous 4 h/)).toBeInTheDocument();
    expect(screen.getByText('En cours')).toBeInTheDocument();
    const t = (await repo.listTickets()).find((x) => x.titre.startsWith('Fuite sous'))!;
    expect([t.statut, t.prestataire_actuel]).toEqual(['affecte', 'Hydro-Services (démo)']);
  });

  it('réaffecte : l\'ancien est marqué « Affecté actuellement » et non sélectionnable, l\'historique garde les deux', async () => {
    const { user } = await ouvrir(/Chauffe-eau du logement 12/);
    const courant = screen.getByRole('radio', { name: /Hydro-Services/ });
    expect(courant).toBeDisabled();
    expect(within(courant.closest('li')!).getByText('Affecté actuellement')).toBeInTheDocument();
    expect(within(courant.closest('li')!).queryByText('Suggéré')).not.toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Réaffecter à Aqua-Rapide (démo)' }));
    expect(await screen.findByText('Ticket affecté à Aqua-Rapide (démo).')).toBeInTheDocument();
    const items = within(screen.getByRole('heading', { name: 'Historique des affectations' }).closest('section')!).getAllByRole('listitem');
    expect(items).toHaveLength(2);
    expect(within(items[0]!).getByText('En cours')).toBeInTheDocument();
    expect(within(items[1]!).getByText('Terminée')).toBeInTheDocument();
  });

  it('refus du serveur : le message s\'affiche et rien ne change', async () => {
    const repo = avecPannes(demo(), { affecter: [new RepositoryError('non_eligible', 'Ce prestataire n\'est pas éligible', { raison: 'suspendu' })] });
    const { user } = await ouvrir(/Fuite sous le lavabo/, repo);
    await user.click(screen.getByRole('button', { name: 'Affecter à Hydro-Services (démo)' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('Ce prestataire n\'est pas éligible');
    expect(screen.getByText('Aucune affectation pour le moment.')).toBeInTheDocument();
  });

  it('aucun prestataire éligible : explication, aucun bouton d\'affectation actif', async () => {
    const repo = demo((d) => {
      for (const p of d.prestataires) if (p.familles.some((r) => d.familles.find((f) => f.id === r.famille_id)?.code === 'plomberie')) p.statut = 'suspendu';
    });
    await ouvrir(/Fuite sous le lavabo/, repo);
    expect(screen.getByText(/Aucun prestataire éligible : tous ceux référencés/)).toBeInTheDocument();
    expect(screen.getAllByRole('radio').every((r) => (r as HTMLInputElement).disabled)).toBe(true);
    expect(screen.getByRole('button', { name: 'Affecter' })).toBeDisabled();
  });

  it('un ticket clos ne peut plus être affecté', async () => {
    const repo = demo((d) => { d.tickets[0]!.statut = 'clos'; });
    await ouvrir(/Fuite sous le lavabo/, repo);
    expect(screen.getByText(/ne peut plus être affecté/)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Affecter/ })).toBeDisabled();
  });

  it('ticket introuvable : message d\'erreur avec nouvel essai', async () => {
    renderApp('/tickets/00000000-0000-4000-8000-0000000000ff');
    expect(await screen.findByRole('alert')).toHaveTextContent('Ticket introuvable');
  });
});

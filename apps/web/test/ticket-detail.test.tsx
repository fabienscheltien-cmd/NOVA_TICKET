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
    expect(within(screen.getByRole('heading', { name: 'Historique des affectations' }).closest('section')!).getByText('En cours')).toBeInTheDocument();
    // le contrat de Hydro-Services couvre ce site et cette famille (P2) : les échéances démarrent à l'affectation
    const sla = within(screen.getByRole('heading', { name: 'Échéances SLA' }).closest('section')!);
    expect(sla.getByText(/Prise en compte/)).toBeInTheDocument();
    expect(sla.getByText(/Résolution/)).toBeInTheDocument();
    expect(sla.getByText(/Contrat : Plomberie et CVC/)).toBeInTheDocument();
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

describe('échéances SLA dans le détail du ticket', () => {
  it('ticket non affecté : explique que les échéances démarrent à l\'affectation', async () => {
    await ouvrir(/Serrure de la porte du hall/);
    const sla = within(screen.getByRole('heading', { name: 'Échéances SLA' }).closest('section')!);
    expect(sla.getByText(/démarrent à l'affectation/)).toBeInTheDocument();
  });

  it('affecté sans règle pour cette priorité : le dit sans parler d\'erreur', async () => {
    const { user } = await ouvrir(/Serrure de la porte du hall/);
    await user.click(screen.getByRole('button', { name: /Affecter à Clés & Sécurité/ }));
    await screen.findByText(/Ticket affecté à Clés & Sécurité/);
    const sla = within(screen.getByRole('heading', { name: 'Échéances SLA' }).closest('section')!);
    expect(sla.getByText(/Aucune échéance suivie/)).toBeInTheDocument();
  });

  it('échéances de la démonstration : prise en compte dépassée, résolution en cours', async () => {
    await ouvrir(/Chauffe-eau du logement 12/);
    const sla = within(screen.getByRole('heading', { name: 'Échéances SLA' }).closest('section')!);
    const [pec, res] = sla.getAllByRole('listitem');
    expect(within(pec!).getByText('Dépassé')).toBeInTheDocument();
    expect(within(res!).getByText('En cours')).toBeInTheDocument();
  });

  it('la réaffectation remplace les échéances par celles du nouveau contrat', async () => {
    const { user } = await ouvrir(/Chauffe-eau du logement 12/);
    await user.click(screen.getByRole('button', { name: 'Réaffecter à Aqua-Rapide (démo)' }));
    await screen.findByText('Ticket affecté à Aqua-Rapide (démo).');
    const sla = within(screen.getByRole('heading', { name: 'Échéances SLA' }).closest('section')!);
    expect(sla.getByText(/Contrat : Plomberie — Résidence des Lilas/)).toBeInTheDocument();
    expect(within(sla.getAllByRole('listitem')[0]!).getByText('En cours')).toBeInTheDocument();
  });

  it('motif « aucun contrat » affiché quand le contrat est exigé', async () => {
    const r = demo((d) => { d.parametres.exiger_contrat = true; });
    await ouvrir(/Serrure de la porte du hall/, r);
    expect(screen.getAllByText('Aucun contrat actif pour ce site et cette famille')).toHaveLength(2);
  });
});

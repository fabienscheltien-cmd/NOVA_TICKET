import { screen, within } from '@testing-library/react';
import { demo, renderApp } from './helpers';

describe('familles de tickets', () => {
  it('liste les familles avec le nombre de prestataires référencés et un lien vers l\'annuaire filtré', async () => {
    renderApp('/familles');
    expect(await screen.findAllByRole('row')).toHaveLength(13);
    const plomberie = screen.getByRole('row', { name: /Plomberie/ });
    expect(within(plomberie).getByRole('link', { name: '2 prestataires' })).toHaveAttribute('href', expect.stringMatching(/^\/annuaire\?famille=/));
    expect(within(screen.getByRole('row', { name: /Peinture et revêtements/ })).getByText('Aucun')).toBeInTheDocument();
  });

  it('ajoute une famille, refuse un doublon', async () => {
    const { user } = renderApp('/familles');
    await screen.findAllByRole('row');
    await user.type(screen.getByLabelText('Nouvelle famille'), 'Désenfumage');
    await user.click(screen.getByRole('button', { name: 'Ajouter' }));
    expect(await screen.findByText('La famille « Désenfumage » a été ajoutée.')).toBeInTheDocument();
    expect(screen.getByRole('row', { name: /Désenfumage/ })).toBeInTheDocument();
    await user.type(screen.getByLabelText('Nouvelle famille'), 'désenfumage');
    await user.click(screen.getByRole('button', { name: 'Ajouter' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('Une famille de même nom existe déjà');
  });

  it('renomme et désactive une famille', async () => {
    const { user } = renderApp('/familles');
    await screen.findAllByRole('row');
    await user.click(screen.getByRole('button', { name: 'Renommer Serrurerie' }));
    const champ = screen.getByLabelText('Nouveau nom de Serrurerie');
    await user.clear(champ);
    await user.type(champ, 'Serrurerie et clés');
    await user.click(screen.getByRole('button', { name: 'Enregistrer' }));
    expect(await screen.findByText('Famille renommée.')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Désactiver Serrurerie et clés' }));
    expect(await screen.findByText(/famille désactivée/)).toBeInTheDocument();
    expect(within(screen.getByRole('row', { name: /Serrurerie et clés/ })).getByText('Désactivée')).toBeInTheDocument();
  });

  it('catalogue vide : propose l\'import des familles standard', async () => {
    const repo = demo((d) => { d.familles = []; d.prestataires = []; d.tickets = []; d.affectations = []; });
    const { user } = renderApp('/familles', repo);
    expect(await screen.findByText('Aucune famille de tickets')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: /Importer les 12 familles standard/ }));
    expect(await screen.findAllByRole('row')).toHaveLength(13);
  });
});

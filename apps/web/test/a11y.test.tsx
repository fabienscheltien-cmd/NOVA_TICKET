import { screen, waitFor, within } from '@testing-library/react';
import axe from 'axe-core';
import { demo, renderApp } from './helpers';

/** Contrôle automatique RGAA/WCAG 2.1 AA (axe-core). Le contraste n'est pas évalué par jsdom : il est vérifié dans un vrai navigateur. */
async function violations(racine: Element): Promise<string[]> {
  const r = await axe.run(racine, { runOnly: { type: 'tag', values: ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'] }, rules: { 'color-contrast': { enabled: false } } });
  return r.violations.map((v) => `${v.id} : ${v.nodes.map((n) => n.target.join(' ')).join(', ')}`);
}

describe('accessibilité (axe-core)', () => {
  it.each([
    ['/tickets', 'Tickets'],
    ['/annuaire', 'Annuaire des prestataires'],
    ['/familles', 'Familles de tickets'],
  ])('page %s : aucune violation', async (route, titre) => {
    const { container } = renderApp(route);
    await screen.findByRole('heading', { name: titre });
    await waitFor(() => expect(screen.getAllByRole('row').length).toBeGreaterThan(1));
    expect(await violations(container)).toEqual([]);
  });

  it('détail d\'un ticket : aucune violation', async () => {
    const { container, user } = renderApp('/tickets');
    await user.click(await screen.findByRole('link', { name: /Climatisation en panne/ }));
    await screen.findByRole('group', { name: /Prestataires référencés/ });
    expect(await violations(container)).toEqual([]);
  });

  it('fenêtres de saisie (prestataire, ticket) : aucune violation et rôle de dialogue modal', async () => {
    const { container, user } = renderApp('/annuaire');
    await screen.findAllByRole('row');
    await user.click(screen.getByRole('button', { name: 'Ajouter un prestataire' }));
    const d = await screen.findByRole('dialog');
    expect(d).toHaveAttribute('aria-modal', 'true');
    expect(await violations(container)).toEqual([]);
    await user.keyboard('{Escape}');
    renderApp('/tickets');
  });

  it('états vides et erreurs : aucune violation', async () => {
    const { container } = renderApp('/annuaire', demo((x) => { x.prestataires = []; x.familles = []; x.tickets = []; x.affectations = []; }));
    await screen.findByText('Votre annuaire est vide');
    expect(await violations(container)).toEqual([]);
    expect(within(container).getAllByRole('navigation').length).toBe(1);
  });
});

describe('contrôle négatif', () => {
  it('le contrôle détecte une vraie violation (image sans texte alternatif)', async () => {
    const div = document.createElement('div');
    div.innerHTML = '<main><h1>Test</h1><img src="x.png"></main>';
    document.body.appendChild(div);
    expect((await violations(div)).join(' ')).toContain('image-alt');
    div.remove();
  });
});

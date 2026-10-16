import { render } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { type DemoData, DemoRepository, type Repository, creerDonneesDemo } from '@nova/shared';
import { App } from '../src/App';
import { AppContext } from '../src/context';

export const AUJOURDHUI = '2026-10-16';

export function demo(mutate?: (d: DemoData) => void): DemoRepository {
  const seed = creerDonneesDemo(AUJOURDHUI);
  mutate?.(seed);
  return new DemoRepository({ seed, today: () => AUJOURDHUI, now: () => new Date(`${AUJOURDHUI}T10:00:00Z`) });
}

export function renderApp(route = '/tickets', repo: Repository = demo()) {
  const user = userEvent.setup();
  const utils = render(
    <AppContext.Provider value={{ repo, today: () => AUJOURDHUI }}>
      <MemoryRouter initialEntries={[route]}>
        <App />
      </MemoryRouter>
    </AppContext.Provider>,
  );
  return { user, repo, ...utils };
}

/** Enveloppe un dépôt pour faire échouer certains appels. */
export function avecPannes<T extends Repository>(repo: T, pannes: Partial<Record<keyof Repository, Error[]>>): T {
  return new Proxy(repo, {
    get(cible, prop, recepteur) {
      const v = Reflect.get(cible, prop, recepteur);
      if (typeof v !== 'function') return v;
      return (...args: unknown[]) => {
        const file = pannes[prop as keyof Repository];
        if (file && file.length > 0) return Promise.reject(file.shift());
        return (v as (...a: unknown[]) => unknown).apply(cible, args);
      };
    },
  });
}

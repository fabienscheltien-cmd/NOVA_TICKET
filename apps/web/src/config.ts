import { ApiRepository, DemoRepository, type Repository } from '@nova/shared';

export const TOKEN_KEY = 'nova.token';

export interface DataSource { mode: 'demo' | 'api'; repo: Repository }

/**
 * Source de données de la console : « demo » (défaut, données fictives en mémoire) ou « api » (VITE_DATA_SOURCE=api,
 * VITE_API_URL=https://… ; le jeton d'accès de l'espace de travail est lu dans le stockage local).
 */
export function creerSource(env: Record<string, string | undefined> = import.meta.env as Record<string, string | undefined>): DataSource {
  if (env.VITE_DATA_SOURCE === 'api') {
    const baseUrl = env.VITE_API_URL ?? 'http://localhost:3000';
    return { mode: 'api', repo: new ApiRepository({ baseUrl, getToken: () => localStorage.getItem(TOKEN_KEY) ?? '' }) };
  }
  return { mode: 'demo', repo: new DemoRepository({ latencyMs: 250 }) };
}

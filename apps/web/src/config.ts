import { ApiRepository, DemoRepository, type Repository } from '@nova/shared';
import { AuthClient } from './auth';

export interface DataSource { mode: 'demo' | 'api'; repo: Repository; auth?: AuthClient; demoLogin?: boolean }

/**
 * Source de données de la console : « demo » (défaut, données fictives en mémoire) ou « api » (VITE_DATA_SOURCE=api,
 * VITE_API_URL=https://… ; connexion par l'écran de la console, jetons dans le stockage local).
 */
export function creerSource(env: Record<string, string | undefined> = import.meta.env as Record<string, string | undefined>): DataSource {
  if (env.VITE_DATA_SOURCE === 'api') {
    const baseUrl = env.VITE_API_URL ?? 'http://localhost:3000';
    const auth = new AuthClient(baseUrl);
    return { mode: 'api', auth, repo: new ApiRepository({ baseUrl, getToken: () => auth.getToken() }) };
  }
  return { mode: 'demo', repo: new DemoRepository({ latencyMs: 250 }), demoLogin: true };
}

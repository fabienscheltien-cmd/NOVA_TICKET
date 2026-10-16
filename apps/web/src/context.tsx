import { createContext, useContext } from 'react';
import { type Repository, aujourdhuiParis } from '@nova/shared';
import type { AuthClient } from './auth';

export interface AppContextValue {
  repo: Repository;
  /** Date du jour (Paris), injectable pour les tests. */
  today: () => string;
  /** Présent en mode API : connexion, espace de travail, déconnexion. */
  auth?: AuthClient;
  /**
   * Démonstration seulement : affiche un écran de connexion qui accepte n'importe quels identifiants (aucune donnée réelle,
   * aucune API derrière). Jamais actif en mode API : l'authentification y est celle du serveur.
   */
  demoLogin?: boolean;
  /** Appelée après une réinitialisation des données de démonstration. */
  onReset?: () => void;
}

export const AppContext = createContext<AppContextValue | null>(null);

export function useApp(): AppContextValue {
  const v = useContext(AppContext);
  if (!v) throw new Error('AppContext manquant');
  return v;
}
export const defaultToday = () => aujourdhuiParis();

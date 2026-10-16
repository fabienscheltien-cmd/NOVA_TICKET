import { createContext, useContext } from 'react';
import { type Repository, aujourdhuiParis } from '@nova/shared';

export interface AppContextValue {
  repo: Repository;
  /** Date du jour (Paris), injectable pour les tests. */
  today: () => string;
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

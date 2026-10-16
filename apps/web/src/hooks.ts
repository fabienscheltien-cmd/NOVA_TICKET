import { useCallback, useEffect, useRef, useState } from 'react';
import { RepositoryError } from '@nova/shared';

export interface AsyncState<T> { status: 'loading' | 'error' | 'ready'; data: T | undefined; error: Error | undefined; reload: () => void }

/** Charge des données asynchrones ; ignore les réponses périmées ; `reload` relance sans effacer l'affichage. */
export function useAsync<T>(fn: () => Promise<T>, deps: unknown[]): AsyncState<T> {
  const [state, setState] = useState<{ status: 'loading' | 'error' | 'ready'; data?: T; error?: Error }>({ status: 'loading' });
  const [tick, setTick] = useState(0);
  const fnRef = useRef(fn);
  fnRef.current = fn;
  useEffect(() => {
    let courant = true;
    setState((s) => (s.status === 'ready' ? s : { status: 'loading' }));
    fnRef.current().then(
      (data) => { if (courant) setState({ status: 'ready', data }); },
      (error: Error) => { if (courant) setState({ status: 'error', error }); },
    );
    return () => { courant = false; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tick, ...deps]);
  const reload = useCallback(() => setTick((n) => n + 1), []);
  return { status: state.status, data: state.data, error: state.error, reload };
}

export function messageErreur(err: unknown): string {
  if (err instanceof RepositoryError) {
    switch (err.code) {
      case 'network': return 'Le serveur est injoignable. Vérifiez votre connexion puis réessayez.';
      case 'unauthorized': return 'Votre session a expiré. Reconnectez-vous.';
      case 'forbidden': return 'Vous n\'avez pas le droit d\'effectuer cette action.';
      case 'deja_affecte': return 'Ce prestataire est déjà affecté à ce ticket.';
      case 'statut_incompatible': return 'Ce ticket ne peut plus être affecté dans son état actuel.';
      default: return err.message;
    }
  }
  return err instanceof Error ? err.message : 'Une erreur est survenue.';
}

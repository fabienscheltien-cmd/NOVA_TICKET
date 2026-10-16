import { type ReactNode, useEffect, useId, useRef } from 'react';

export function Badge({ ton = 'neutre', children, title }: { ton?: 'neutre' | 'ok' | 'alerte' | 'danger' | 'info'; children: ReactNode; title?: string }) {
  return <span className={`badge badge-${ton}`} title={title}>{children}</span>;
}

export function Loading({ label = 'Chargement…' }: { label?: string }) {
  return (
    <div className="state" role="status" aria-live="polite">
      <span className="spinner" aria-hidden="true" />
      <span>{label}</span>
    </div>
  );
}

export function ErrorState({ message, onRetry }: { message: string; onRetry?: () => void }) {
  return (
    <div className="state state-error" role="alert">
      <p><strong>Impossible de charger les données.</strong></p>
      <p>{message}</p>
      {onRetry && <button type="button" className="btn" onClick={onRetry}>Réessayer</button>}
    </div>
  );
}

export function EmptyState({ titre, children, action }: { titre: string; children?: ReactNode; action?: ReactNode }) {
  return (
    <div className="state state-empty">
      <p><strong>{titre}</strong></p>
      {children && <p>{children}</p>}
      {action}
    </div>
  );
}

const FOCUSABLES = 'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

/** Fenêtre modale accessible : focus piégé, Échap pour fermer, focus rendu à l'élément déclencheur. */
export function Modal({ titre, onClose, children }: { titre: string; onClose: () => void; children: ReactNode }) {
  const ref = useRef<HTMLDivElement>(null);
  const titreId = useId();
  useEffect(() => {
    const avant = document.activeElement as HTMLElement | null;
    const premier = ref.current?.querySelector<HTMLElement>('input:not([type=hidden]), select, textarea');
    (premier ?? ref.current?.querySelector<HTMLElement>(FOCUSABLES))?.focus();
    return () => avant?.focus?.();
  }, []);
  return (
    <div className="overlay" onMouseDown={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <div
        ref={ref} className="modal" role="dialog" aria-modal="true" aria-labelledby={titreId}
        onKeyDown={(e) => {
          if (e.key === 'Escape') { e.stopPropagation(); onClose(); return; }
          if (e.key !== 'Tab' || !ref.current) return;
          const f = [...ref.current.querySelectorAll<HTMLElement>(FOCUSABLES)];
          if (f.length === 0) return;
          const first = f[0]!; const last = f[f.length - 1]!;
          if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); }
          else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
        }}
      >
        <header className="modal-head">
          <h2 id={titreId}>{titre}</h2>
          <button type="button" className="btn btn-ghost" aria-label="Fermer" onClick={onClose}>×</button>
        </header>
        {children}
      </div>
    </div>
  );
}

/** Champ de formulaire : étiquette, aide et message d'erreur reliés au contrôle. */
export function Field({ label, error, help, required, children }: {
  label: string; error?: string | undefined; help?: string; required?: boolean;
  children: (p: { id: string; 'aria-describedby': string | undefined; 'aria-invalid': boolean | undefined; required?: boolean }) => ReactNode;
}) {
  const id = useId();
  const desc = [help ? `${id}-help` : '', error ? `${id}-err` : ''].filter(Boolean).join(' ') || undefined;
  return (
    <div className={`field${error ? ' field-error' : ''}`}>
      <label htmlFor={id}>{label}{required && <span aria-hidden="true"> *</span>}</label>
      {children({ id, 'aria-describedby': desc, 'aria-invalid': error ? true : undefined, ...(required ? { required: true } : {}) })}
      {help && <p className="help" id={`${id}-help`}>{help}</p>}
      {error && <p className="error" id={`${id}-err`}>{error}</p>}
    </div>
  );
}

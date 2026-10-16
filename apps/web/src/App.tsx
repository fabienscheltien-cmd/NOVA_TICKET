import { useState } from 'react';
import { NavLink, Navigate, Route, Routes } from 'react-router-dom';
import { DEMO_LABEL, DemoRepository } from '@nova/shared';
import { useApp } from './context';
import { AnnuairePage } from './pages/Annuaire';
import { FamillesPage } from './pages/Familles';
import { TicketDetailPage } from './pages/TicketDetail';
import { TicketsPage } from './pages/Tickets';
import { TOKEN_KEY } from './config';

export function App() {
  const { repo, onReset } = useApp();
  const [version, setVersion] = useState(0);
  const [token, setToken] = useState(() => (repo.mode === 'api' ? localStorage.getItem(TOKEN_KEY) ?? '' : 'demo'));

  if (!token) {
    return (
      <main className="gate">
        <h1>Console NOVA — mode API</h1>
        <p>Collez le jeton d'accès de votre espace de travail (obtenu par <code>POST /me/workspace/switch</code>). Il est conservé dans ce navigateur uniquement.</p>
        <form onSubmit={(e) => { e.preventDefault(); const v = new FormData(e.currentTarget).get('jeton'); if (typeof v === 'string' && v.trim()) { localStorage.setItem(TOKEN_KEY, v.trim()); setToken(v.trim()); } }}>
          <div className="field"><label htmlFor="jeton">Jeton d'accès</label><input id="jeton" name="jeton" type="password" autoComplete="off" required /></div>
          <button type="submit" className="btn btn-primary">Continuer</button>
        </form>
      </main>
    );
  }

  return (
    <div className="shell">
      <a className="skip" href="#contenu">Aller au contenu</a>
      {repo.mode === 'demo' && (
        <div className="demo-banner" role="status">
          <span><strong>Mode démonstration.</strong> {DEMO_LABEL}.</span>
          <button type="button" className="btn" onClick={() => { if (repo instanceof DemoRepository) repo.reset(); setVersion((v) => v + 1); onReset?.(); }}>
            Réinitialiser les données
          </button>
        </div>
      )}
      <header className="topbar">
        <span className="logo" aria-hidden="true">N</span>
        <span className="titre">NOVA <span className="soustitre">Console d'administration</span></span>
        <nav aria-label="Navigation principale">
          <NavLink to="/tickets">Tickets</NavLink>
          <NavLink to="/annuaire">Annuaire</NavLink>
          <NavLink to="/familles">Familles</NavLink>
        </nav>
      </header>
      <main id="contenu" tabIndex={-1} key={version}>
        <Routes>
          <Route path="/" element={<Navigate to="/tickets" replace />} />
          <Route path="/tickets" element={<TicketsPage />} />
          <Route path="/tickets/:id" element={<TicketDetailPage />} />
          <Route path="/annuaire" element={<AnnuairePage />} />
          <Route path="/familles" element={<FamillesPage />} />
          <Route path="*" element={<section><h1>Page introuvable</h1><p><NavLink to="/tickets">Retour aux tickets</NavLink></p></section>} />
        </Routes>
      </main>
    </div>
  );
}

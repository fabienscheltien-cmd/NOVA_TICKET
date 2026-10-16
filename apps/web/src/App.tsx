import { useEffect, useState } from 'react';
import { NavLink, Navigate, Route, Routes } from 'react-router-dom';
import { DEMO_LABEL, DemoRepository } from '@nova/shared';
import { useApp } from './context';
import { AnnuairePage } from './pages/Annuaire';
import { CalendriersPage } from './pages/Calendriers';
import { ContratsPage } from './pages/Contrats';
import { FamillesPage } from './pages/Familles';
import { TicketDetailPage } from './pages/TicketDetail';
import { TicketsPage } from './pages/Tickets';
import { ConnexionDemoPage, ConnexionPage, DEMO_SESSION_KEY, InvitationPage, MotDePasseOubliePage, ReinitialisationPage } from './pages/Connexion';

export function App() {
  const { repo, onReset, auth, demoLogin } = useApp();
  const [demoNom, setDemoNom] = useState<string | null>(() => {
    try { return sessionStorage.getItem(DEMO_SESSION_KEY); } catch { return null; }
  });
  const entrerDemo = (nom: string) => { try { sessionStorage.setItem(DEMO_SESSION_KEY, nom); } catch { /* stockage indisponible */ } setDemoNom(nom); };
  const sortirDemo = () => { try { sessionStorage.removeItem(DEMO_SESSION_KEY); } catch { /* idem */ } setDemoNom(null); };
  const [version, setVersion] = useState(0);
  const [session, setSession] = useState(() => auth?.session() ?? null);
  useEffect(() => (auth ? auth.subscribe(() => setSession(auth.session())) : undefined), [auth]);

  if (demoLogin && !auth && !demoNom) return <ConnexionDemoPage onConnecte={entrerDemo} />;

  if (auth && !session) {
    return (
      <Routes>
        <Route path="/mot-de-passe-oublie" element={<MotDePasseOubliePage />} />
        <Route path="/mot-de-passe/:token" element={<ReinitialisationPage />} />
        <Route path="/invitations/:token" element={<InvitationPage />} />
        <Route path="*" element={<ConnexionPage />} />
      </Routes>
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
          <NavLink to="/contrats">Contrats</NavLink>
          <NavLink to="/calendriers">Calendriers</NavLink>
          <NavLink to="/familles">Familles</NavLink>
        </nav>
        {demoLogin && demoNom && (
          <div className="compte">
            <span className="sous">{demoNom}</span>
            <button type="button" className="btn" onClick={sortirDemo}>Se déconnecter</button>
          </div>
        )}
        {auth && session && (
          <div className="compte">
            <span className="sous">{session.orgNom}</span>
            <button type="button" className="btn" onClick={() => void auth.deconnexion()}>Se déconnecter</button>
          </div>
        )}
      </header>
      <main id="contenu" tabIndex={-1} key={version}>
        <Routes>
          <Route path="/" element={<Navigate to="/tickets" replace />} />
          <Route path="/tickets" element={<TicketsPage />} />
          <Route path="/tickets/:id" element={<TicketDetailPage />} />
          <Route path="/annuaire" element={<AnnuairePage />} />
          <Route path="/contrats" element={<ContratsPage />} />
          <Route path="/calendriers" element={<CalendriersPage />} />
          <Route path="/familles" element={<FamillesPage />} />
          <Route path="/invitations/:token" element={auth ? <InvitationPage /> : <Navigate to="/tickets" replace />} />
          <Route path="*" element={<section><h1>Page introuvable</h1><p><NavLink to="/tickets">Retour aux tickets</NavLink></p></section>} />
        </Routes>
      </main>
    </div>
  );
}

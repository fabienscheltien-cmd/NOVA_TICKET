import { type FormEvent, type ReactNode, useEffect, useRef, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { type AuthClient, ErreurAuth, type Espace } from '../auth';
import { useApp } from '../context';
import { Field, Loading } from '../ui';

const TYPES_ORG: Record<string, string> = { bailleur: 'Bailleur', property_manager: 'Property manager', prestataire: 'Prestataire', editeur: 'Éditeur' };
const ROLES: Record<string, string> = {
  admin_org: 'Administrateur', gestionnaire_fm: 'Gestionnaire FM', accueil: 'Accueil', responsable_site: 'Responsable de site',
  asset_manager: 'Asset manager', technicien: 'Technicien', prestataire_externe: 'Prestataire externe', support: 'Support', super_admin: 'Super-administrateur',
};
const message = (e: unknown) => (e instanceof ErreurAuth ? e.message : 'Une erreur est survenue. Réessayez.');

function Carte({ titre, children }: { titre: string; children: ReactNode }) {
  return (
    <main className="gate" id="contenu">
      <h1>{titre}</h1>
      {children}
    </main>
  );
}

function useAuth(): AuthClient {
  const { auth } = useApp();
  if (!auth) throw new Error('AuthClient manquant');
  return auth;
}

/** Connexion en quatre temps : identifiants, code MFA, activation MFA si exigée, choix de l'espace. */
export function ConnexionPage() {
  const auth = useAuth();
  type Etape = { nom: 'identifiants' } | { nom: 'mfa'; token: string } | { nom: 'espaces'; liste: Espace[] } | { nom: 'enrolement'; espace: Espace };
  const [etape, setEtape] = useState<Etape>({ nom: 'identifiants' });
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [code, setCode] = useState('');
  const [erreur, setErreur] = useState('');
  const [envoi, setEnvoi] = useState(false);

  async function apresAuthentification() {
    const liste = await auth.espaces();
    if (liste.length === 0) { setErreur('Aucun espace de travail n\'est associé à ce compte.'); setEtape({ nom: 'identifiants' }); return; }
    if (liste.length === 1) { await choisir(liste[0]!); return; }
    setEtape({ nom: 'espaces', liste });
  }

  async function choisir(espace: Espace) {
    try { await auth.entrer(espace); }
    catch (e) {
      if (e instanceof ErreurAuth && e.code === 'mfa_enrollment_required') { setEtape({ nom: 'enrolement', espace }); return; }
      throw e;
    }
  }

  async function executer(fn: () => Promise<void>) {
    setErreur(''); setEnvoi(true);
    try { await fn(); } catch (e) { setErreur(message(e)); } finally { setEnvoi(false); }
  }

  if (etape.nom === 'enrolement') {
    return <Enrolement auth={auth} onTermine={() => void executer(() => choisir(etape.espace))} />;
  }

  if (etape.nom === 'espaces') {
    return (
      <Carte titre="Choisissez votre espace de travail">
        <p className="lede">Votre compte donne accès à plusieurs organisations.</p>
        {erreur && <p className="alert" role="alert">{erreur}</p>}
        <ul className="espaces">
          {etape.liste.map((e) => (
            <li key={e.org_id}>
              <button type="button" className="btn" disabled={envoi} onClick={() => void executer(() => choisir(e))}>
                <strong>{e.nom}</strong> <span className="sous">{TYPES_ORG[e.type] ?? e.type} · {ROLES[e.role] ?? e.role}</span>
              </button>
            </li>
          ))}
        </ul>
      </Carte>
    );
  }

  if (etape.nom === 'mfa') {
    return (
      <Carte titre="Double authentification">
        <form onSubmit={(e: FormEvent) => { e.preventDefault(); void executer(async () => {
          try { await auth.verifierMfa(etape.token, code.trim()); } catch (err) {
            // Le serveur répond de façon uniforme ; à cette étape, l'utilisateur a déjà saisi son mot de passe.
            if (err instanceof ErreurAuth && err.code === 'invalid_credentials') throw new ErreurAuth('invalid_code', 'Code incorrect, ou la connexion a expiré (5 minutes) : vérifiez le code ou recommencez.', 401);
            throw err;
          }
          setCode(''); await apresAuthentification();
        }); }} noValidate>
          <Field label="Code à 6 chiffres" help="Ou un code de secours (format xxxxx-xxxxx).">
            {(p) => <input {...p} value={code} onChange={(e) => setCode(e.target.value)} inputMode="numeric" autoComplete="one-time-code" autoFocus />}
          </Field>
          {erreur && <p className="alert" role="alert">{erreur}</p>}
          <button type="submit" className="btn btn-primary" disabled={envoi || code.trim().length < 6}>Valider</button>
        </form>
      </Carte>
    );
  }

  return (
    <Carte titre="Connexion à NOVA">
      <form
        onSubmit={(e: FormEvent) => {
          e.preventDefault();
          void executer(async () => {
            const r = await auth.connexion(email.trim(), password);
            setPassword('');
            if (r.status === 'mfa_required') setEtape({ nom: 'mfa', token: r.mfaToken }); else await apresAuthentification();
          });
        }}
        noValidate
      >
        <Field label="Adresse e-mail" required>
          {(p) => <input {...p} type="email" value={email} onChange={(e) => setEmail(e.target.value)} autoComplete="username" autoFocus />}
        </Field>
        <Field label="Mot de passe" required>
          {(p) => <input {...p} type="password" value={password} onChange={(e) => setPassword(e.target.value)} autoComplete="current-password" />}
        </Field>
        {erreur && <p className="alert" role="alert">{erreur}</p>}
        <button type="submit" className="btn btn-primary" disabled={envoi || !email.trim() || !password}>Se connecter</button>
      </form>
      <p><Link to="/mot-de-passe-oublie">Mot de passe oublié ?</Link></p>
    </Carte>
  );
}

function Enrolement({ auth, onTermine }: { auth: AuthClient; onTermine: () => void }) {
  const [secret, setSecret] = useState<{ secret: string; otpauth_uri: string } | null>(null);
  const [codes, setCodes] = useState<string[] | null>(null);
  const [code, setCode] = useState('');
  const [erreur, setErreur] = useState('');
  // Un seul appel : chaque appel génère un nouveau secret côté serveur, un second écraserait celui affiché.
  const demande = useRef(false);
  useEffect(() => {
    if (demande.current) return;
    demande.current = true;
    auth.mfaPreparer().then(setSecret, (e) => setErreur(message(e)));
  }, [auth]);

  if (codes) {
    return (
      <Carte titre="Conservez vos codes de secours">
        <p>Chaque code ne sert qu'une fois et permet de vous connecter si vous perdez votre application d'authentification. Ils ne seront plus affichés.</p>
        <ul className="codes" aria-label="Codes de secours">{codes.map((c) => <li key={c}><code>{c}</code></li>)}</ul>
        <button type="button" className="btn btn-primary" onClick={onTermine}>J'ai conservé mes codes</button>
      </Carte>
    );
  }
  return (
    <Carte titre="Activez la double authentification">
      <p>Elle est obligatoire pour votre rôle. Ajoutez ce compte dans une application d'authentification (TOTP), puis saisissez le code affiché.</p>
      {!secret && !erreur && <Loading label="Préparation…" />}
      {secret && (
        <>
          <p>Clé à saisir dans l'application : <code className="secret">{secret.secret}</code></p>
          <p className="help"><a href={secret.otpauth_uri}>Ouvrir dans l'application d'authentification</a></p>
          <form onSubmit={(e: FormEvent) => { e.preventDefault(); setErreur(''); auth.mfaConfirmer(code.trim()).then((r) => setCodes(r.backup_codes), (er) => setErreur(message(er))); }} noValidate>
            <Field label="Code à 6 chiffres" required>
              {(p) => <input {...p} value={code} onChange={(e) => setCode(e.target.value)} inputMode="numeric" autoComplete="one-time-code" />}
            </Field>
            {erreur && <p className="alert" role="alert">{erreur}</p>}
            <button type="submit" className="btn btn-primary" disabled={code.trim().length !== 6}>Activer</button>
          </form>
        </>
      )}
      {erreur && !secret && <p className="alert" role="alert">{erreur}</p>}
    </Carte>
  );
}

export function MotDePasseOubliePage() {
  const auth = useAuth();
  const [email, setEmail] = useState('');
  const [envoye, setEnvoye] = useState(false);
  const [erreur, setErreur] = useState('');
  return (
    <Carte titre="Mot de passe oublié">
      {envoye ? (
        <>
          <p role="status">Si cette adresse correspond à un compte, un e-mail de réinitialisation vient d'être envoyé. Le lien est valable 30 minutes.</p>
          <p><Link to="/">Retour à la connexion</Link></p>
        </>
      ) : (
        <form onSubmit={(e: FormEvent) => { e.preventDefault(); setErreur(''); auth.motDePasseOublie(email.trim()).then(() => setEnvoye(true), (er) => setErreur(message(er))); }} noValidate>
          <Field label="Adresse e-mail" required>
            {(p) => <input {...p} type="email" value={email} onChange={(e) => setEmail(e.target.value)} autoComplete="username" autoFocus />}
          </Field>
          {erreur && <p className="alert" role="alert">{erreur}</p>}
          <button type="submit" className="btn btn-primary" disabled={!email.trim()}>Envoyer le lien</button>
          <p><Link to="/">Retour à la connexion</Link></p>
        </form>
      )}
    </Carte>
  );
}

const LONGUEUR_MIN = 12;

function ChampMotDePasse({ valeur, onChange, erreur }: { valeur: string; onChange: (v: string) => void; erreur?: string }) {
  return (
    <Field label="Nouveau mot de passe" required help={`Au moins ${LONGUEUR_MIN} caractères.`} error={erreur}>
      {(p) => <input {...p} type="password" value={valeur} onChange={(e) => onChange(e.target.value)} autoComplete="new-password" />}
    </Field>
  );
}

export function ReinitialisationPage() {
  const auth = useAuth();
  const { token = '' } = useParams();
  const navigate = useNavigate();
  const [password, setPassword] = useState('');
  const [erreur, setErreur] = useState('');
  const [court, setCourt] = useState('');
  const [fait, setFait] = useState(false);
  if (fait) {
    return (
      <Carte titre="Mot de passe modifié">
        <p role="status">Votre mot de passe a été modifié et vos autres sessions ont été fermées. La double authentification reste demandée à la connexion.</p>
        <button type="button" className="btn btn-primary" onClick={() => navigate('/')}>Se connecter</button>
      </Carte>
    );
  }
  return (
    <Carte titre="Nouveau mot de passe">
      <form
        onSubmit={(e: FormEvent) => {
          e.preventDefault(); setErreur('');
          if (password.length < LONGUEUR_MIN) { setCourt(`Au moins ${LONGUEUR_MIN} caractères.`); return; }
          setCourt('');
          auth.reinitialiser(token, password).then(() => setFait(true), (er) => setErreur(message(er)));
        }}
        noValidate
      >
        <ChampMotDePasse valeur={password} onChange={setPassword} erreur={court} />
        {erreur && <p className="alert" role="alert">{erreur} <Link to="/mot-de-passe-oublie">Refaire une demande</Link></p>}
        <button type="submit" className="btn btn-primary">Enregistrer</button>
      </form>
    </Carte>
  );
}

/** Lien reçu par e-mail : crée le compte (nouvel utilisateur) ou rattache un compte existant (déjà connecté). */
export function InvitationPage() {
  const auth = useAuth();
  const { token = '' } = useParams();
  const navigate = useNavigate();
  const [nom, setNom] = useState('');
  const [password, setPassword] = useState('');
  const [erreurs, setErreurs] = useState<{ nom?: string; mdp?: string }>({});
  const [erreur, setErreur] = useState('');
  const [existant, setExistant] = useState(false);
  const connecte = auth.session() !== null;

  if (connecte) {
    return (
      <Carte titre="Accepter l'invitation">
        <p>Vous êtes connecté. Rattacher cette invitation à votre compte actuel ?</p>
        {erreur && <p className="alert" role="alert">{erreur}</p>}
        <button type="button" className="btn btn-primary" onClick={() => { setErreur(''); auth.accepterInvitationCompteExistant(token).then(() => { void auth.deconnexion().then(() => navigate('/')); }, (e) => setErreur(message(e))); }}>
          Accepter
        </button>
        <p className="help">Après acceptation, reconnectez-vous pour choisir le nouvel espace.</p>
      </Carte>
    );
  }
  return (
    <Carte titre="Créer votre compte NOVA">
      <form
        onSubmit={(e: FormEvent) => {
          e.preventDefault(); setErreur(''); setExistant(false);
          const er: typeof erreurs = {};
          if (!nom.trim()) er.nom = 'Le nom est obligatoire.';
          if (password.length < LONGUEUR_MIN) er.mdp = `Au moins ${LONGUEUR_MIN} caractères.`;
          setErreurs(er);
          if (Object.keys(er).length) return;
          auth.accepterInvitation(token, nom.trim(), password).then(() => navigate('/'), (ex) => {
            setErreur(message(ex));
            setExistant(ex instanceof ErreurAuth && ex.code === 'account_exists');
          });
        }}
        noValidate
      >
        <Field label="Nom complet" required error={erreurs.nom}>
          {(p) => <input {...p} value={nom} onChange={(e) => setNom(e.target.value)} autoComplete="name" autoFocus />}
        </Field>
        <ChampMotDePasse valeur={password} onChange={setPassword} {...(erreurs.mdp ? { erreur: erreurs.mdp } : {})} />
        {erreur && <p className="alert" role="alert">{erreur}</p>}
        {existant && <p><Link to="/">Se connecter</Link></p>}
        <button type="submit" className="btn btn-primary">Créer mon compte</button>
      </form>
    </Carte>
  );
}

/**
 * Connexion de DÉMONSTRATION : accepte n'importe quel e-mail et mot de passe (même vides). Le mode démonstration n'a ni API ni
 * donnée réelle, donc rien n'est protégé ni exposé. Le nom affiché est tiré de l'adresse saisie.
 */
export const DEMO_SESSION_KEY = 'nova.demo.session';
export function nomDemo(email: string): string {
  const local = email.trim().split('@')[0]?.trim() ?? '';
  return local ? `${local} (démo)` : 'Administrateur (démo)';
}

export function ConnexionDemoPage({ onConnecte }: { onConnecte: (nom: string) => void }) {
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  return (
    <Carte titre="Connexion à NOVA">
      <p className="alert warn" role="note">
        <strong>Mode démonstration.</strong> N'importe quel e-mail et mot de passe sont acceptés ; vous entrez comme administrateur
        sur des données fictives, non enregistrées.
      </p>
      <form onSubmit={(e: FormEvent) => { e.preventDefault(); onConnecte(nomDemo(email)); }} noValidate>
        <Field label="Adresse e-mail">
          {(p) => <input {...p} type="email" value={email} onChange={(e) => setEmail(e.target.value)} autoComplete="username" autoFocus />}
        </Field>
        <Field label="Mot de passe">
          {(p) => <input {...p} type="password" value={password} onChange={(e) => setPassword(e.target.value)} autoComplete="current-password" />}
        </Field>
        <button type="submit" className="btn btn-primary">Se connecter</button>
      </form>
    </Carte>
  );
}

import { type FormEvent, useMemo, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import type { Famille, Prestataire, StatutPrestataire } from '@nova/shared';
import { useApp } from '../context';
import { messageErreur, useAsync } from '../hooks';
import { STATUTS_PRESTATAIRE, dateCivile, etatAssurance } from '../labels';
import { Badge, EmptyState, ErrorState, Field, Loading, Modal } from '../ui';

function BadgeAssurance({ expire }: { expire: string | null }) {
  const { today } = useApp();
  const etat = etatAssurance(expire, today());
  const libelle = { valide: 'Valide', bientot: 'Échéance proche', echue: 'Échue', inconnue: 'Non renseignée' }[etat];
  const ton = { valide: 'ok', bientot: 'alerte', echue: 'danger', inconnue: 'neutre' }[etat] as 'ok' | 'alerte' | 'danger' | 'neutre';
  return (
    <span className="assurance">
      <span>{dateCivile(expire)}</span> <Badge ton={ton}>{libelle}</Badge>
    </span>
  );
}

export function AnnuairePage() {
  const { repo } = useApp();
  const [params, setParams] = useSearchParams();
  const q = params.get('q') ?? '';
  const familleId = params.get('famille') ?? '';
  const statut = (params.get('statut') ?? '') as StatutPrestataire | '';
  const [edition, setEdition] = useState<Prestataire | 'nouveau' | null>(null);
  const [invitation, setInvitation] = useState<Prestataire | null>(null);
  const [message, setMessage] = useState('');
  const [erreurAction, setErreurAction] = useState('');

  const familles = useAsync(() => repo.listFamilles(), [repo]);
  const liste = useAsync(
    () => repo.listPrestataires({ ...(q ? { q } : {}), ...(familleId ? { famille_id: familleId } : {}), ...(statut ? { statut } : {}) }),
    [repo, q, familleId, statut],
  );
  const total = useAsync(() => repo.listPrestataires(), [repo]);
  const libelles = useMemo(() => new Map((familles.data ?? []).map((f) => [f.id, f.libelle])), [familles.data]);

  const maj = (cle: string, valeur: string) => {
    const p = new URLSearchParams(params);
    if (valeur) p.set(cle, valeur); else p.delete(cle);
    setParams(p, { replace: true });
  };
  const recharger = () => { liste.reload(); total.reload(); familles.reload(); };

  async function basculer(p: Prestataire) {
    setErreurAction(''); setMessage('');
    const suivant: StatutPrestataire = p.statut === 'actif' ? 'suspendu' : 'actif';
    try {
      await repo.setStatutPrestataire(p.id, suivant);
      setMessage(`${p.nom} est maintenant ${suivant === 'actif' ? 'actif' : 'suspendu'}.`);
      recharger();
    } catch (e) { setErreurAction(messageErreur(e)); }
  }

  const filtresActifs = Boolean(q || familleId || statut);
  const annuaireVide = total.status === 'ready' && total.data!.length === 0;

  return (
    <section aria-labelledby="titre-annuaire">
      <div className="page-head">
        <div>
          <h1 id="titre-annuaire">Annuaire des prestataires</h1>
          <p className="lede">Chaque prestataire est référencé sur une ou plusieurs familles de tickets. La famille d'un ticket détermine les prestataires éligibles.</p>
        </div>
        <button type="button" className="btn btn-primary" onClick={() => setEdition('nouveau')}>Ajouter un prestataire</button>
      </div>

      <form className="toolbar" role="search" aria-label="Filtrer l'annuaire" onSubmit={(e) => e.preventDefault()}>
        <div className="field">
          <label htmlFor="f-q">Rechercher</label>
          <input id="f-q" type="search" value={q} placeholder="Nom, contact, zone" onChange={(e) => maj('q', e.target.value)} />
        </div>
        <div className="field">
          <label htmlFor="f-famille">Famille</label>
          <select id="f-famille" value={familleId} onChange={(e) => maj('famille', e.target.value)}>
            <option value="">Toutes les familles</option>
            {(familles.data ?? []).map((f) => <option key={f.id} value={f.id}>{f.libelle}</option>)}
          </select>
        </div>
        <div className="field">
          <label htmlFor="f-statut">Statut</label>
          <select id="f-statut" value={statut} onChange={(e) => maj('statut', e.target.value)}>
            <option value="">Tous</option>
            <option value="actif">Actifs</option>
            <option value="suspendu">Suspendus</option>
          </select>
        </div>
        {filtresActifs && <button type="button" className="btn" onClick={() => setParams({}, { replace: true })}>Réinitialiser les filtres</button>}
      </form>

      <div aria-live="polite" className="flash">{message}</div>
      {erreurAction && <p className="alert" role="alert">{erreurAction}</p>}

      {liste.status === 'loading' && <Loading label="Chargement de l'annuaire…" />}
      {liste.status === 'error' && <ErrorState message={messageErreur(liste.error)} onRetry={liste.reload} />}
      {liste.status === 'ready' && annuaireVide && (
        <EmptyState
          titre="Votre annuaire est vide"
          action={<button type="button" className="btn btn-primary" onClick={() => setEdition('nouveau')}>Ajouter le premier prestataire</button>}
        >
          {familles.status === 'ready' && familles.data!.length === 0
            ? <>Commencez par <Link to="/familles">créer ou importer vos familles de tickets</Link>.</>
            : 'Ajoutez vos prestataires et indiquez les familles de tickets qu\'ils couvrent.'}
        </EmptyState>
      )}
      {liste.status === 'ready' && !annuaireVide && liste.data!.length === 0 && (
        <EmptyState titre="Aucun prestataire ne correspond à ces filtres" action={<button type="button" className="btn" onClick={() => setParams({}, { replace: true })}>Réinitialiser les filtres</button>} />
      )}
      {liste.status === 'ready' && liste.data!.length > 0 && (
        <div className="table-wrap">
          <table>
            <caption className="sr-only">Prestataires de l'annuaire</caption>
            <thead>
              <tr>
                <th scope="col">Prestataire</th><th scope="col">Familles référencées</th><th scope="col">Assurance</th>
                <th scope="col">Compte NOVA</th><th scope="col">Statut</th><th scope="col"><span className="sr-only">Actions</span></th>
              </tr>
            </thead>
            <tbody>
              {liste.data!.map((p) => (
                <tr key={p.id}>
                  <th scope="row">
                    <span className="nom">{p.nom}</span>
                    <span className="sous">{[p.contact_nom, p.zone].filter(Boolean).join(' · ') || '—'}</span>
                  </th>
                  <td>
                    {p.familles.length === 0 ? <span className="sous">Aucune famille</span> : (
                      <ul className="chips">
                        {p.familles.map((r) => (
                          <li key={r.famille_id} className="chip" title={`Priorité ${r.priorite}`}>
                            {libelles.get(r.famille_id) ?? 'Famille inconnue'} <span className="prio" aria-label={`priorité ${r.priorite}`}>P{r.priorite}</span>
                          </li>
                        ))}
                      </ul>
                    )}
                  </td>
                  <td><BadgeAssurance expire={p.assurance_expire_le} /></td>
                  <td><CompteNova p={p} /></td>
                  <td><Badge ton={p.statut === 'actif' ? 'ok' : 'danger'}>{STATUTS_PRESTATAIRE[p.statut]}</Badge></td>
                  <td><div className="actions">
                    <button type="button" className="btn" onClick={() => setEdition(p)} aria-label={`Modifier ${p.nom}`}>Modifier</button>
                    {!p.prestataire_org_id && (
                      <button type="button" className="btn" onClick={() => setInvitation(p)} aria-label={`${p.invitation_envoyee_le ? 'Relancer' : 'Inviter'} ${p.nom}`}>
                        {p.invitation_envoyee_le ? 'Relancer' : 'Inviter'}
                      </button>
                    )}
                    <button type="button" className="btn" onClick={() => void basculer(p)} aria-label={`${p.statut === 'actif' ? 'Suspendre' : 'Réactiver'} ${p.nom}`}>
                      {p.statut === 'actif' ? 'Suspendre' : 'Réactiver'}
                    </button>
                  </div></td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {edition && familles.status === 'ready' && (
        <PrestataireModal
          prestataire={edition === 'nouveau' ? null : edition}
          familles={familles.data!}
          onClose={() => setEdition(null)}
          onSaved={(p, creation) => { setEdition(null); setMessage(creation ? `${p.nom} a été ajouté à l'annuaire.` : `${p.nom} a été mis à jour.`); recharger(); }}
        />
      )}
      {invitation && (
        <InvitationModal
          prestataire={invitation}
          onClose={() => setInvitation(null)}
          onSent={(email) => { setInvitation(null); setMessage(`Invitation envoyée à ${email}.`); recharger(); }}
        />
      )}
    </section>
  );
}

function CompteNova({ p }: { p: Prestataire }) {
  if (p.prestataire_org_id) return <Badge ton="ok">Compte rattaché</Badge>;
  if (p.invitation_envoyee_le) {
    return (
      <span className="assurance">
        <Badge ton="info" title="Le rattachement n'a lieu que lorsque le prestataire accepte l'invitation">Invitation en attente</Badge>
        <span className="sous">{p.invitation_email} · {dateCivile(p.invitation_envoyee_le.slice(0, 10))}</span>
      </span>
    );
  }
  return <Badge ton="alerte" title="Aucune affectation possible tant que le prestataire n'a pas de compte">Pas de compte</Badge>;
}

function InvitationModal({ prestataire, onClose, onSent }: { prestataire: Prestataire; onClose: () => void; onSent: (email: string) => void }) {
  const { repo } = useApp();
  const [email, setEmail] = useState(prestataire.invitation_email ?? prestataire.contact_email ?? '');
  const [erreur, setErreur] = useState('');
  const [erreurServeur, setErreurServeur] = useState('');
  const [envoi, setEnvoi] = useState(false);

  async function envoyer(e: FormEvent) {
    e.preventDefault();
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email.trim())) { setErreur('Adresse e-mail invalide.'); return; }
    setErreur(''); setErreurServeur(''); setEnvoi(true);
    try {
      const p = await repo.inviterPrestataire(prestataire.id, email.trim());
      onSent(p.invitation_email ?? email.trim());
    } catch (ex) { setErreurServeur(messageErreur(ex)); setEnvoi(false); }
  }

  return (
    <Modal titre={`Inviter ${prestataire.nom}`} onClose={onClose}>
      <form onSubmit={(e) => void envoyer(e)} noValidate>
        <p className="help">
          Le prestataire reçoit un lien pour créer son compte NOVA. Il n'est rattaché à votre annuaire, et donc affectable,
          qu'une fois l'invitation acceptée. Une nouvelle invitation annule la précédente.
        </p>
        <Field label="Adresse e-mail de l'administrateur du prestataire" required error={erreur}>
          {(p) => <input {...p} type="email" value={email} onChange={(e) => setEmail(e.target.value)} autoComplete="off" />}
        </Field>
        {erreurServeur && <p className="alert" role="alert">{erreurServeur}</p>}
        <footer className="modal-foot">
          <button type="button" className="btn" onClick={onClose}>Annuler</button>
          <button type="submit" className="btn btn-primary" disabled={envoi}>{envoi ? 'Envoi…' : 'Envoyer l\'invitation'}</button>
        </footer>
      </form>
    </Modal>
  );
}

interface FormState {
  nom: string; contact_nom: string; contact_email: string; contact_telephone: string; zone: string; assurance_expire_le: string;
  statut: StatutPrestataire; notes: string; familles: Record<string, string>;
}

function PrestataireModal({ prestataire, familles, onClose, onSaved }: {
  prestataire: Prestataire | null; familles: Famille[]; onClose: () => void; onSaved: (p: Prestataire, creation: boolean) => void;
}) {
  const { repo } = useApp();
  const [f, setF] = useState<FormState>(() => ({
    nom: prestataire?.nom ?? '', contact_nom: prestataire?.contact_nom ?? '', contact_email: prestataire?.contact_email ?? '',
    contact_telephone: prestataire?.contact_telephone ?? '', zone: prestataire?.zone ?? '', assurance_expire_le: prestataire?.assurance_expire_le ?? '',
    statut: prestataire?.statut ?? 'actif', notes: prestataire?.notes ?? '',
    familles: Object.fromEntries((prestataire?.familles ?? []).map((r) => [r.famille_id, String(r.priorite)])),
  }));
  const [erreurs, setErreurs] = useState<Partial<Record<'nom' | 'email', string>>>({});
  const [erreurServeur, setErreurServeur] = useState('');
  const [envoi, setEnvoi] = useState(false);
  const set = <K extends keyof FormState>(k: K, v: FormState[K]) => setF((s) => ({ ...s, [k]: v }));
  const actives = familles.filter((x) => x.actif || prestataire?.familles.some((r) => r.famille_id === x.id));

  async function envoyer(e: FormEvent) {
    e.preventDefault();
    const err: typeof erreurs = {};
    if (!f.nom.trim()) err.nom = 'Le nom est obligatoire.';
    if (f.contact_email.trim() && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(f.contact_email.trim())) err.email = 'Adresse e-mail invalide.';
    setErreurs(err);
    if (Object.keys(err).length) return;
    const refs = Object.entries(f.familles).map(([famille_id, p]) => ({ famille_id, priorite: Math.max(1, Math.min(99, Number.parseInt(p, 10) || 1)) }));
    const donnees = {
      nom: f.nom.trim(), contact_nom: f.contact_nom.trim() || null, contact_email: f.contact_email.trim() || null,
      contact_telephone: f.contact_telephone.trim() || null, zone: f.zone.trim() || null, assurance_expire_le: f.assurance_expire_le || null,
      statut: f.statut, notes: f.notes.trim() || null, familles: refs,
    };
    setEnvoi(true); setErreurServeur('');
    try {
      const p = prestataire ? await repo.updatePrestataire(prestataire.id, donnees) : await repo.createPrestataire(donnees);
      onSaved(p, !prestataire);
    } catch (ex) { setErreurServeur(messageErreur(ex)); setEnvoi(false); }
  }

  return (
    <Modal titre={prestataire ? `Modifier ${prestataire.nom}` : 'Ajouter un prestataire'} onClose={onClose}>
      <form onSubmit={(e) => void envoyer(e)} noValidate>
        <div className="grid2">
          <Field label="Nom du prestataire" required error={erreurs.nom}>
            {(p) => <input {...p} value={f.nom} onChange={(e) => set('nom', e.target.value)} autoComplete="off" />}
          </Field>
          <Field label="Contact">
            {(p) => <input {...p} value={f.contact_nom} onChange={(e) => set('contact_nom', e.target.value)} autoComplete="off" />}
          </Field>
          <Field label="Adresse e-mail du contact" error={erreurs.email}>
            {(p) => <input {...p} type="email" value={f.contact_email} onChange={(e) => set('contact_email', e.target.value)} autoComplete="off" />}
          </Field>
          <Field label="Téléphone">
            {(p) => <input {...p} type="tel" value={f.contact_telephone} onChange={(e) => set('contact_telephone', e.target.value)} autoComplete="off" />}
          </Field>
          <Field label="Zone d'intervention">
            {(p) => <input {...p} value={f.zone} onChange={(e) => set('zone', e.target.value)} />}
          </Field>
          <Field label="Échéance de l'attestation d'assurance" help="Un prestataire dont l'assurance est échue n'est plus proposé pour les nouvelles affectations.">
            {(p) => <input {...p} type="date" value={f.assurance_expire_le} onChange={(e) => set('assurance_expire_le', e.target.value)} />}
          </Field>
          <Field label="Statut">
            {(p) => (
              <select {...p} value={f.statut} onChange={(e) => set('statut', e.target.value as StatutPrestataire)}>
                <option value="actif">Actif</option><option value="suspendu">Suspendu</option>
              </select>
            )}
          </Field>
        </div>
        <Field label="Notes internes">
          {(p) => <textarea {...p} rows={2} value={f.notes} onChange={(e) => set('notes', e.target.value)} />}
        </Field>

        <fieldset className="familles-choix">
          <legend>Familles de tickets référencées</legend>
          <p className="help">La priorité 1 désigne le prestataire préféré : il est proposé en premier.</p>
          {actives.length === 0 && <p className="sous">Aucune famille disponible : créez-en d'abord dans « Familles ».</p>}
          {actives.map((fam) => {
            const coche = fam.id in f.familles;
            return (
              <div key={fam.id} className="famille-ligne">
                <label className="check">
                  <input
                    type="checkbox" checked={coche}
                    onChange={(e) => setF((s) => {
                      const next = { ...s.familles };
                      if (e.target.checked) next[fam.id] = '1'; else delete next[fam.id];
                      return { ...s, familles: next };
                    })}
                  />
                  <span>{fam.libelle}{!fam.actif && ' (désactivée)'}</span>
                </label>
                {coche && (
                  <label className="prio-champ">
                    <span>Priorité pour {fam.libelle}</span>
                    <input type="number" min={1} max={99} value={f.familles[fam.id]} onChange={(e) => setF((s) => ({ ...s, familles: { ...s.familles, [fam.id]: e.target.value } }))} />
                  </label>
                )}
              </div>
            );
          })}
          {Object.keys(f.familles).length === 0 && actives.length > 0 && <p className="help warn">Sans famille, ce prestataire ne sera jamais proposé.</p>}
        </fieldset>

        {erreurServeur && <p className="alert" role="alert">{erreurServeur}</p>}
        <footer className="modal-foot">
          <button type="button" className="btn" onClick={onClose}>Annuler</button>
          <button type="submit" className="btn btn-primary" disabled={envoi}>{envoi ? 'Enregistrement…' : prestataire ? 'Enregistrer' : 'Ajouter'}</button>
        </footer>
      </form>
    </Modal>
  );
}

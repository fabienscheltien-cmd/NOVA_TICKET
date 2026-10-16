import { type FormEvent, useMemo, useState } from 'react';
import { Link, useNavigate, useSearchParams } from 'react-router-dom';
import { type Priorite, type StatutTicket, type Ticket, evaluerEligibilite } from '@nova/shared';
import { useApp } from '../context';
import { messageErreur, useAsync } from '../hooks';
import { PRIORITES, STATUTS_TICKET, dateHeure } from '../labels';
import { Badge, EmptyState, ErrorState, Field, Loading, Modal } from '../ui';

export const tonPriorite = (p: Priorite) => (p === 'p1' ? 'danger' : p === 'p2' ? 'alerte' : 'neutre') as 'danger' | 'alerte' | 'neutre';
export const tonStatut = (s: StatutTicket) => (s === 'nouveau' ? 'info' : s === 'clos' || s === 'resolu' ? 'ok' : 'neutre') as 'info' | 'ok' | 'neutre';

export function TicketsPage() {
  const { repo } = useApp();
  const [params, setParams] = useSearchParams();
  const statut = (params.get('statut') ?? '') as StatutTicket | '';
  const familleId = params.get('famille') ?? '';
  const [creation, setCreation] = useState(false);
  const familles = useAsync(() => repo.listFamilles(), [repo]);
  const tickets = useAsync(() => repo.listTickets({ ...(statut ? { statut } : {}), ...(familleId ? { famille_id: familleId } : {}) }), [repo, statut, familleId]);
  const maj = (cle: string, valeur: string) => {
    const p = new URLSearchParams(params);
    if (valeur) p.set(cle, valeur); else p.delete(cle);
    setParams(p, { replace: true });
  };
  const filtres = Boolean(statut || familleId);

  return (
    <section aria-labelledby="titre-tickets">
      <div className="page-head">
        <div>
          <h1 id="titre-tickets">Tickets</h1>
          <p className="lede">Créez un ticket, choisissez sa famille : les prestataires éligibles sont déterminés automatiquement. L'affectation se fait depuis le détail du ticket.</p>
        </div>
        <button type="button" className="btn btn-primary" onClick={() => setCreation(true)}>Nouveau ticket</button>
      </div>

      <form className="toolbar" role="search" aria-label="Filtrer les tickets" onSubmit={(e) => e.preventDefault()}>
        <div className="field">
          <label htmlFor="t-statut">Statut</label>
          <select id="t-statut" value={statut} onChange={(e) => maj('statut', e.target.value)}>
            <option value="">Tous</option>
            {(['nouveau', 'qualifie', 'affecte'] as StatutTicket[]).map((s) => <option key={s} value={s}>{STATUTS_TICKET[s]}</option>)}
          </select>
        </div>
        <div className="field">
          <label htmlFor="t-famille">Famille</label>
          <select id="t-famille" value={familleId} onChange={(e) => maj('famille', e.target.value)}>
            <option value="">Toutes les familles</option>
            {(familles.data ?? []).map((f) => <option key={f.id} value={f.id}>{f.libelle}</option>)}
          </select>
        </div>
        {filtres && <button type="button" className="btn" onClick={() => setParams({}, { replace: true })}>Réinitialiser les filtres</button>}
      </form>

      {tickets.status === 'loading' && <Loading label="Chargement des tickets…" />}
      {tickets.status === 'error' && <ErrorState message={messageErreur(tickets.error)} onRetry={tickets.reload} />}
      {tickets.status === 'ready' && tickets.data!.length === 0 && (
        <EmptyState
          titre={filtres ? 'Aucun ticket ne correspond à ces filtres' : 'Aucun ticket pour le moment'}
          action={filtres
            ? <button type="button" className="btn" onClick={() => setParams({}, { replace: true })}>Réinitialiser les filtres</button>
            : <button type="button" className="btn btn-primary" onClick={() => setCreation(true)}>Créer le premier ticket</button>}
        />
      )}
      {tickets.status === 'ready' && tickets.data!.length > 0 && (
        <div className="table-wrap">
          <table>
            <caption className="sr-only">Tickets</caption>
            <thead>
              <tr><th scope="col">Ticket</th><th scope="col">Famille</th><th scope="col">Lieu</th><th scope="col">Priorité</th><th scope="col">Statut</th><th scope="col">Prestataire</th></tr>
            </thead>
            <tbody>
              {tickets.data!.map((t: Ticket) => (
                <tr key={t.id}>
                  <th scope="row">
                    <Link to={`/tickets/${t.id}`} className="nom">{t.titre}</Link>
                    <span className="sous">Créé le {dateHeure(t.created_at)}</span>
                  </th>
                  <td>{t.famille_libelle ?? '—'}</td>
                  <td>{[t.site_nom, t.local_nom].filter(Boolean).join(' · ') || '—'}</td>
                  <td><Badge ton={tonPriorite(t.priorite)}>{PRIORITES[t.priorite]}</Badge></td>
                  <td><Badge ton={tonStatut(t.statut)}>{STATUTS_TICKET[t.statut]}</Badge></td>
                  <td>{t.prestataire_actuel ?? <span className="sous">Non affecté</span>}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {creation && <TicketModal onClose={() => setCreation(false)} />}
    </section>
  );
}

function Apercu({ familleId }: { familleId: string }) {
  const { repo, today } = useApp();
  const prestataires = useAsync(() => repo.listPrestataires({ famille_id: familleId }), [repo, familleId]);
  const sel = useMemo(() => (prestataires.data ? evaluerEligibilite(familleId, prestataires.data, today()) : null), [prestataires.data, familleId, today]);
  if (prestataires.status === 'loading') return <p className="help" role="status">Recherche des prestataires éligibles…</p>;
  if (prestataires.status === 'error' || !sel) return <p className="help">Aperçu des prestataires indisponible.</p>;
  const ok = sel.eligibles.filter((l) => l.eligible);
  const exclus = sel.eligibles.length - ok.length;
  if (ok.length === 0) {
    return (
      <p className="help warn" role="status">
        Aucun prestataire éligible pour cette famille{exclus ? ` (${exclus} exclu${exclus > 1 ? 's' : ''})` : ''} : le ticket pourra être créé, mais pas affecté tant que l'annuaire n'est pas complété.
      </p>
    );
  }
  return (
    <p className="help" role="status">
      {ok.length} prestataire{ok.length > 1 ? 's' : ''} éligible{ok.length > 1 ? 's' : ''} : {ok.map((l) => l.nom).join(', ')}.{exclus ? ` ${exclus} exclu${exclus > 1 ? 's' : ''}.` : ''}
    </p>
  );
}

function TicketModal({ onClose }: { onClose: () => void }) {
  const { repo } = useApp();
  const navigate = useNavigate();
  const familles = useAsync(() => repo.listFamilles(), [repo]);
  const sites = useAsync(() => repo.listSites(), [repo]);
  const [f, setF] = useState({ titre: '', description: '', famille_id: '', site_id: '', local_id: '', priorite: 'p3' as Priorite });
  const locaux = useAsync(() => (f.site_id ? repo.listLocaux(f.site_id) : Promise.resolve([])), [repo, f.site_id]);
  const [erreurs, setErreurs] = useState<Partial<Record<'titre' | 'famille' | 'site', string>>>({});
  const [erreurServeur, setErreurServeur] = useState('');
  const [envoi, setEnvoi] = useState(false);
  const set = <K extends keyof typeof f>(k: K, v: (typeof f)[K]) => setF((s) => ({ ...s, [k]: v }));

  async function envoyer(e: FormEvent) {
    e.preventDefault();
    const err: typeof erreurs = {};
    if (!f.titre.trim()) err.titre = 'Le titre est obligatoire.';
    if (!f.famille_id) err.famille = 'Choisissez la famille du ticket.';
    if (!f.site_id) err.site = 'Choisissez le site concerné.';
    setErreurs(err);
    if (Object.keys(err).length) return;
    setEnvoi(true); setErreurServeur('');
    try {
      const t = await repo.createTicket({ titre: f.titre.trim(), description: f.description.trim() || null, famille_id: f.famille_id, site_id: f.site_id, local_id: f.local_id || null, priorite: f.priorite });
      navigate(`/tickets/${t.id}`, { state: { cree: true } });
    } catch (ex) { setErreurServeur(messageErreur(ex)); setEnvoi(false); }
  }

  return (
    <Modal titre="Nouveau ticket" onClose={onClose}>
      <form onSubmit={(e) => void envoyer(e)} noValidate>
        <Field label="Titre" required error={erreurs.titre}>
          {(p) => <input {...p} value={f.titre} onChange={(e) => set('titre', e.target.value)} autoComplete="off" />}
        </Field>
        <Field label="Description">
          {(p) => <textarea {...p} rows={3} value={f.description} onChange={(e) => set('description', e.target.value)} />}
        </Field>
        <div className="grid2">
          <Field label="Famille du ticket" required error={erreurs.famille} help="Détermine les prestataires éligibles.">
            {(p) => (
              <select {...p} value={f.famille_id} onChange={(e) => set('famille_id', e.target.value)}>
                <option value="">Choisir…</option>
                {(familles.data ?? []).filter((x) => x.actif).map((x) => <option key={x.id} value={x.id}>{x.libelle}</option>)}
              </select>
            )}
          </Field>
          <Field label="Priorité">
            {(p) => (
              <select {...p} value={f.priorite} onChange={(e) => set('priorite', e.target.value as Priorite)}>
                {(Object.keys(PRIORITES) as Priorite[]).map((k) => <option key={k} value={k}>{PRIORITES[k]}</option>)}
              </select>
            )}
          </Field>
          <Field label="Site" required error={erreurs.site}>
            {(p) => (
              <select {...p} value={f.site_id} onChange={(e) => setF((s) => ({ ...s, site_id: e.target.value, local_id: '' }))}>
                <option value="">Choisir…</option>
                {(sites.data ?? []).map((x) => <option key={x.id} value={x.id}>{x.nom}</option>)}
              </select>
            )}
          </Field>
          <Field label="Local">
            {(p) => (
              <select {...p} value={f.local_id} disabled={!f.site_id} onChange={(e) => set('local_id', e.target.value)}>
                <option value="">{f.site_id ? 'Non précisé' : 'Choisissez d\'abord un site'}</option>
                {(locaux.data ?? []).map((x) => <option key={x.id} value={x.id}>{x.nom}</option>)}
              </select>
            )}
          </Field>
        </div>
        {f.famille_id && <Apercu familleId={f.famille_id} />}
        {erreurServeur && <p className="alert" role="alert">{erreurServeur}</p>}
        <footer className="modal-foot">
          <button type="button" className="btn" onClick={onClose}>Annuler</button>
          <button type="submit" className="btn btn-primary" disabled={envoi}>{envoi ? 'Création…' : 'Créer le ticket'}</button>
        </footer>
      </form>
    </Modal>
  );
}

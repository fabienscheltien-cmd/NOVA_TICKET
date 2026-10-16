import { type FormEvent, useEffect, useState } from 'react';
import { Link, useLocation, useParams } from 'react-router-dom';
import { RAISONS_LIBELLES, type TicketDetail } from '@nova/shared';
import { useApp } from '../context';
import { messageErreur, useAsync } from '../hooks';
import { PRIORITES, STATUTS_AFFECTABLES, STATUTS_TICKET, dateHeure } from '../labels';
import { Badge, ErrorState, Loading } from '../ui';
import { tonPriorite, tonStatut } from './Tickets';

export function TicketDetailPage() {
  const { id = '' } = useParams();
  const { repo } = useApp();
  const location = useLocation();
  const charge = useAsync(() => repo.getTicket(id), [repo, id]);
  const [local, setLocal] = useState<TicketDetail | null>(null);
  const ticket = local ?? charge.data;
  useEffect(() => { setLocal(null); }, [id]);

  if (!ticket) {
    if (charge.status === 'error') return <ErrorState message={messageErreur(charge.error)} onRetry={charge.reload} />;
    return <Loading label="Chargement du ticket…" />;
  }
  return <Contenu key={ticket.id} ticket={ticket} cree={Boolean((location.state as { cree?: boolean } | null)?.cree)} onChange={setLocal} />;
}

function Contenu({ ticket, cree, onChange }: { ticket: TicketDetail; cree: boolean; onChange: (t: TicketDetail) => void }) {
  const { repo } = useApp();
  const { selection } = ticket;
  const actuel = ticket.historique.find((h) => h.fin_at === null) ?? null;
  const affectable = STATUTS_AFFECTABLES.includes(ticket.statut);
  const premierChoix = selection.eligibles.find((l) => l.eligible && l.annuaire_id !== actuel?.annuaire_id)?.annuaire_id ?? '';
  const [choix, setChoix] = useState(premierChoix);
  const [motif, setMotif] = useState('');
  const [envoi, setEnvoi] = useState(false);
  const [erreur, setErreur] = useState('');
  const [succes, setSucces] = useState('');
  const choisi = selection.eligibles.find((l) => l.annuaire_id === choix);
  const libelleAction = actuel ? 'Réaffecter' : 'Affecter';

  async function affecter(e: FormEvent) {
    e.preventDefault();
    if (!choisi) { setErreur('Choisissez un prestataire éligible.'); return; }
    setEnvoi(true); setErreur(''); setSucces('');
    try {
      const maj = await repo.affecter(ticket.id, { annuaire_id: choisi.annuaire_id, motif: motif.trim() || null });
      setSucces(`Ticket affecté à ${choisi.nom}.`);
      setMotif('');
      onChange(maj);
      setChoix(maj.selection.eligibles.find((l) => l.eligible && l.annuaire_id !== choisi.annuaire_id)?.annuaire_id ?? '');
    } catch (ex) { setErreur(messageErreur(ex)); } finally { setEnvoi(false); }
  }

  const aucunCandidat = selection.eligibles.length === 0;
  const aucunEligible = !aucunCandidat && !selection.eligibles.some((l) => l.eligible);

  return (
    <article aria-labelledby="titre-ticket">
      <p className="fil"><Link to="/tickets">← Tickets</Link></p>
      {cree && <p className="flash ok" role="status">Ticket créé. Les prestataires éligibles pour la famille « {ticket.famille_libelle ?? '—'} » sont listés ci-dessous.</p>}
      <div className="page-head">
        <div>
          <h1 id="titre-ticket">{ticket.titre}</h1>
          <p className="badges">
            <Badge ton={tonStatut(ticket.statut)}>{STATUTS_TICKET[ticket.statut]}</Badge>
            <Badge ton={tonPriorite(ticket.priorite)}>{PRIORITES[ticket.priorite]}</Badge>
          </p>
        </div>
      </div>

      <dl className="meta">
        <div><dt>Famille</dt><dd>{ticket.famille_libelle ?? '—'}</dd></div>
        <div><dt>Site</dt><dd>{ticket.site_nom ?? '—'}</dd></div>
        <div><dt>Local</dt><dd>{ticket.local_nom ?? 'Non précisé'}</dd></div>
        <div><dt>Créé le</dt><dd>{dateHeure(ticket.created_at)}</dd></div>
        <div><dt>Prestataire</dt><dd>{ticket.prestataire_actuel ?? 'Non affecté'}</dd></div>
      </dl>
      {ticket.description && <p className="description">{ticket.description}</p>}

      <section aria-labelledby="titre-affectation" className="carte">
        <h2 id="titre-affectation">{libelleAction === 'Affecter' ? 'Affectation' : 'Affectation et réaffectation'}</h2>
        <div aria-live="polite" className="flash ok">{succes}</div>

        {!affectable && <p className="alert">Ce ticket est « {STATUTS_TICKET[ticket.statut].toLowerCase()} » : il ne peut plus être affecté.</p>}

        {aucunCandidat && (
          <div className="state state-empty">
            <p><strong>Aucun prestataire n'est référencé sur la famille « {ticket.famille_libelle ?? '—'} ».</strong></p>
            <p><Link to={`/annuaire?famille=${ticket.famille_id}`}>Compléter l'annuaire</Link> pour pouvoir affecter ce ticket.</p>
          </div>
        )}
        {aucunEligible && <p className="alert warn" role="status">Aucun prestataire éligible : tous ceux référencés sur cette famille sont exclus (voir les motifs ci-dessous).</p>}

        {!aucunCandidat && (
          <form onSubmit={(e) => void affecter(e)}>
            <fieldset disabled={!affectable || envoi}>
              <legend>Prestataires référencés sur « {ticket.famille_libelle ?? '—'} »</legend>
              <ul className="candidats">
                {selection.eligibles.map((l) => {
                  const courant = l.annuaire_id === actuel?.annuaire_id;
                  const id = `cand-${l.annuaire_id}`;
                  return (
                    <li key={l.annuaire_id} className={l.eligible ? '' : 'exclu'}>
                      <input
                        type="radio" id={id} name="prestataire" value={l.annuaire_id} checked={choix === l.annuaire_id}
                        disabled={!l.eligible || courant} onChange={() => setChoix(l.annuaire_id)} aria-describedby={`${id}-info`}
                      />
                      <label htmlFor={id}>
                        <span className="nom">{l.nom}</span>
                        <span className="prio">Priorité {l.priorite}</span>
                      </label>
                      <span id={`${id}-info`} className="infos">
                        {premierChoix === l.annuaire_id && <Badge ton="info">Suggéré</Badge>}
                        {courant && <Badge ton="ok">Affecté actuellement</Badge>}
                        {!l.eligible && <Badge ton="danger">{RAISONS_LIBELLES[l.raison]}</Badge>}
                      </span>
                    </li>
                  );
                })}
              </ul>
              <div className="field">
                <label htmlFor="motif">Motif (facultatif)</label>
                <textarea id="motif" rows={2} value={motif} onChange={(e) => setMotif(e.target.value)} aria-describedby="motif-aide" />
                <p className="help" id="motif-aide">Conservé dans l'historique, visible de votre équipe uniquement.</p>
              </div>
              {erreur && <p className="alert" role="alert">{erreur}</p>}
              <button type="submit" className="btn btn-primary" disabled={!choisi || !affectable || envoi}>
                {envoi ? 'Affectation…' : choisi ? `${libelleAction} à ${choisi.nom}` : libelleAction}
              </button>
            </fieldset>
          </form>
        )}
      </section>

      <section aria-labelledby="titre-historique" className="carte">
        <h2 id="titre-historique">Historique des affectations</h2>
        {ticket.historique.length === 0 ? <p className="sous">Aucune affectation pour le moment.</p> : (
          <ol className="historique">
            {ticket.historique.map((h) => (
              <li key={h.id}>
                <strong>{h.prestataire_nom}</strong>{' '}
                {h.fin_at === null ? <Badge ton="ok">En cours</Badge> : <Badge>Terminée</Badge>}
                <span className="sous">
                  Affecté le {dateHeure(h.affecte_at)}{h.fin_at ? ` · remplacé le ${dateHeure(h.fin_at)}` : ''}{h.motif ? ` · Motif : ${h.motif}` : ''}
                </span>
              </li>
            ))}
          </ol>
        )}
      </section>
    </article>
  );
}

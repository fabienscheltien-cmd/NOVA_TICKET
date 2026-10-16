import { type FormEvent, useState } from 'react';
import type { Calendrier, Fermeture, PlageHoraire } from '@nova/shared';
import { useApp } from '../context';
import { messageErreur, useAsync } from '../hooks';
import { JOURS_SEMAINE, dateCivile, libelleJours } from '../labels';
import { EmptyState, ErrorState, Field, Loading, Modal } from '../ui';

const FUSEAUX = ['Europe/Paris', 'Europe/Brussels', 'Europe/Zurich', 'Europe/London', 'Indian/Reunion', 'America/Martinique', 'America/Guadeloupe', 'America/Cayenne', 'Pacific/Noumea', 'Pacific/Tahiti'];

export function CalendriersPage() {
  const { repo } = useApp();
  const liste = useAsync(() => repo.listCalendriers(), [repo]);
  const [edition, setEdition] = useState<Calendrier | 'nouveau' | null>(null);
  const [message, setMessage] = useState('');

  return (
    <section aria-labelledby="titre-calendriers">
      <div className="page-head">
        <div>
          <h1 id="titre-calendriers">Calendriers ouvrés</h1>
          <p className="lede">Les délais des contrats se comptent en minutes ouvrées de ces calendriers. Les jours fériés et fermetures sont saisis par vos soins : la liste applicable à chaque site reste à valider.</p>
        </div>
        <button type="button" className="btn btn-primary" onClick={() => setEdition('nouveau')}>Ajouter un calendrier</button>
      </div>
      <div aria-live="polite" className="flash">{message}</div>
      {liste.status === 'loading' && <Loading label="Chargement des calendriers…" />}
      {liste.status === 'error' && <ErrorState message={messageErreur(liste.error)} onRetry={liste.reload} />}
      {liste.status === 'ready' && liste.data!.length === 0 && (
        <EmptyState titre="Aucun calendrier" action={<button type="button" className="btn btn-primary" onClick={() => setEdition('nouveau')}>Créer le premier calendrier</button>}>
          Sans calendrier, un contrat compte ses délais en heures continues (24 h/24, 7 j/7).
        </EmptyState>
      )}
      {liste.status === 'ready' && liste.data!.length > 0 && (
        <div className="table-wrap">
          <table>
            <caption className="sr-only">Calendriers ouvrés</caption>
            <thead><tr><th scope="col">Nom</th><th scope="col">Fuseau</th><th scope="col">Plages</th><th scope="col">Fermetures</th><th scope="col"><span className="sr-only">Actions</span></th></tr></thead>
            <tbody>
              {liste.data!.map((c) => (
                <tr key={c.id}>
                  <th scope="row">{c.nom}</th>
                  <td>{c.fuseau}</td>
                  <td><ul className="plain">{c.plages.map((p, i) => <li key={i}>{libelleJours(p.jours)} {p.debut}–{p.fin}</li>)}</ul></td>
                  <td>{c.fermetures.length === 0 ? <span className="sous">Aucune</span> : <ul className="plain">{c.fermetures.map((f, i) => <li key={i}>{f.du === f.au ? dateCivile(f.du) : `${dateCivile(f.du)} → ${dateCivile(f.au)}`}{f.libelle ? ` · ${f.libelle}` : ''}</li>)}</ul>}</td>
                  <td><div className="actions"><button type="button" className="btn" aria-label={`Modifier ${c.nom}`} onClick={() => setEdition(c)}>Modifier</button></div></td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {edition && (
        <CalendrierModal
          calendrier={edition === 'nouveau' ? null : edition} onClose={() => setEdition(null)}
          onSaved={(c, creation) => { setEdition(null); setMessage(creation ? `Le calendrier « ${c.nom} » a été créé.` : `Le calendrier « ${c.nom} » a été mis à jour.`); liste.reload(); }}
        />
      )}
    </section>
  );
}

const PLAGE_DEFAUT: PlageHoraire = { jours: [1, 2, 3, 4, 5], debut: '08:00', fin: '18:00' };

function CalendrierModal({ calendrier, onClose, onSaved }: { calendrier: Calendrier | null; onClose: () => void; onSaved: (c: Calendrier, creation: boolean) => void }) {
  const { repo } = useApp();
  const [nom, setNom] = useState(calendrier?.nom ?? '');
  const [fuseau, setFuseau] = useState(calendrier?.fuseau ?? 'Europe/Paris');
  const [plages, setPlages] = useState<PlageHoraire[]>(calendrier?.plages ?? [{ ...PLAGE_DEFAUT }]);
  const [fermetures, setFermetures] = useState<Fermeture[]>(calendrier?.fermetures ?? []);
  const [erreurNom, setErreurNom] = useState('');
  const [erreur, setErreur] = useState('');
  const [envoi, setEnvoi] = useState(false);
  const majPlage = (i: number, p: Partial<PlageHoraire>) => setPlages((l) => l.map((x, n) => (n === i ? { ...x, ...p } : x)));
  const majFerm = (i: number, p: Partial<Fermeture>) => setFermetures((l) => l.map((x, n) => (n === i ? { ...x, ...p } : x)));

  async function envoyer(e: FormEvent) {
    e.preventDefault();
    if (!nom.trim()) { setErreurNom('Le nom est obligatoire.'); return; }
    setErreurNom(''); setErreur(''); setEnvoi(true);
    const input = { nom: nom.trim(), fuseau: fuseau.trim(), plages, fermetures: fermetures.map((f) => ({ ...f, libelle: f.libelle?.trim() || null })) };
    try { onSaved(calendrier ? await repo.updateCalendrier(calendrier.id, input) : await repo.createCalendrier(input), !calendrier); }
    catch (ex) { setErreur(messageErreur(ex)); setEnvoi(false); }
  }

  return (
    <Modal titre={calendrier ? `Modifier ${calendrier.nom}` : 'Ajouter un calendrier'} onClose={onClose}>
      <form onSubmit={(e) => void envoyer(e)} noValidate>
        <div className="grid2">
          <Field label="Nom" required error={erreurNom}>{(p) => <input {...p} value={nom} onChange={(e) => setNom(e.target.value)} autoComplete="off" />}</Field>
          <Field label="Fuseau horaire" help="Les heures des plages sont des heures locales de ce fuseau ; les changements d'heure sont gérés.">
            {(p) => (
              <>
                <input {...p} list="fuseaux" value={fuseau} onChange={(e) => setFuseau(e.target.value)} autoComplete="off" spellCheck={false} />
                <datalist id="fuseaux">{FUSEAUX.map((f) => <option key={f} value={f} />)}</datalist>
              </>
            )}
          </Field>
        </div>
        <fieldset className="familles-choix">
          <legend>Plages horaires</legend>
          <p className="help">Hors plage, le chrono d'un délai est arrêté. Utilisez 00:00–24:00 tous les jours pour une astreinte 24 h/24.</p>
          {plages.map((p, i) => (
            <div key={i} className="famille-ligne" role="group" aria-label={`Plage ${i + 1}`}>
              <div className="jours" role="group" aria-label={`Jours de la plage ${i + 1}`}>
                {JOURS_SEMAINE.map((j, n) => (
                  <label key={j} className="check">
                    <input type="checkbox" checked={p.jours.includes(n + 1)} onChange={(e) => majPlage(i, { jours: e.target.checked ? [...p.jours, n + 1].sort() : p.jours.filter((x) => x !== n + 1) })} /> {j}
                  </label>
                ))}
              </div>
              <label className="check">Début <input type="time" value={p.debut} onChange={(e) => majPlage(i, { debut: e.target.value })} /></label>
              <label className="check">Fin <input type="time" value={p.fin === '24:00' ? '23:59' : p.fin} onChange={(e) => majPlage(i, { fin: e.target.value })} /></label>
              <button type="button" className="btn" onClick={() => majPlage(i, { debut: '00:00', fin: '24:00', jours: [1, 2, 3, 4, 5, 6, 7] })}>24 h/24</button>
              {plages.length > 1 && <button type="button" className="btn" aria-label={`Retirer la plage ${i + 1}`} onClick={() => setPlages((l) => l.filter((_, n) => n !== i))}>Retirer</button>}
            </div>
          ))}
          <button type="button" className="btn" onClick={() => setPlages((l) => [...l, { ...PLAGE_DEFAUT }])}>Ajouter une plage</button>
        </fieldset>
        <fieldset className="familles-choix">
          <legend>Fermetures (jours fériés, ponts)</legend>
          {fermetures.length === 0 && <p className="sous">Aucune fermeture.</p>}
          {fermetures.map((f, i) => (
            <div key={i} className="famille-ligne" role="group" aria-label={`Fermeture ${i + 1}`}>
              <label className="check">Du <input type="date" value={f.du} onChange={(e) => majFerm(i, { du: e.target.value, ...(f.au < e.target.value ? { au: e.target.value } : {}) })} /></label>
              <label className="check">Au <input type="date" value={f.au} min={f.du} onChange={(e) => majFerm(i, { au: e.target.value })} /></label>
              <label className="check">Libellé <input value={f.libelle ?? ''} onChange={(e) => majFerm(i, { libelle: e.target.value })} /></label>
              <button type="button" className="btn" aria-label={`Retirer la fermeture ${i + 1}`} onClick={() => setFermetures((l) => l.filter((_, n) => n !== i))}>Retirer</button>
            </div>
          ))}
          <button type="button" className="btn" onClick={() => setFermetures((l) => [...l, { du: '', au: '', libelle: null }])}>Ajouter une fermeture</button>
        </fieldset>
        {erreur && <p className="alert" role="alert">{erreur}</p>}
        <footer className="modal-foot">
          <button type="button" className="btn" onClick={onClose}>Annuler</button>
          <button type="submit" className="btn btn-primary" disabled={envoi}>{envoi ? 'Enregistrement…' : 'Enregistrer'}</button>
        </footer>
      </form>
    </Modal>
  );
}

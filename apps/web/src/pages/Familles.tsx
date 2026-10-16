import { type FormEvent, useState } from 'react';
import { Link } from 'react-router-dom';
import { FAMILLES_STANDARD, type Famille } from '@nova/shared';
import { useApp } from '../context';
import { messageErreur, useAsync } from '../hooks';
import { Badge, EmptyState, ErrorState, Loading } from '../ui';

export function FamillesPage() {
  const { repo } = useApp();
  const familles = useAsync(() => repo.listFamilles(), [repo]);
  const [nouveau, setNouveau] = useState('');
  const [enEdition, setEnEdition] = useState<{ id: string; libelle: string } | null>(null);
  const [message, setMessage] = useState('');
  const [erreur, setErreur] = useState('');

  async function agir(action: () => Promise<unknown>, succes: string) {
    setErreur(''); setMessage('');
    try { await action(); setMessage(succes); familles.reload(); return true; }
    catch (e) { setErreur(messageErreur(e)); return false; }
  }

  async function ajouter(e: FormEvent) {
    e.preventDefault();
    if (!nouveau.trim()) { setErreur('Saisissez le nom de la famille.'); return; }
    if (await agir(() => repo.createFamille({ libelle: nouveau.trim() }), `La famille « ${nouveau.trim()} » a été ajoutée.`)) setNouveau('');
  }

  const manquantes = FAMILLES_STANDARD.filter((s) => !(familles.data ?? []).some((f) => f.code === s.code)).length;

  return (
    <section aria-labelledby="titre-familles">
      <div className="page-head">
        <div>
          <h1 id="titre-familles">Familles de tickets</h1>
          <p className="lede">Plomberie, électricité, CVC, serrurerie… La famille choisie à la création d'un ticket détermine les prestataires éligibles.</p>
        </div>
        {familles.status === 'ready' && manquantes > 0 && familles.data!.length > 0 && (
          <button type="button" className="btn" onClick={() => void agir(() => repo.importFamillesStandard(), 'Les familles standard ont été ajoutées.')}>
            Ajouter les familles standard manquantes ({manquantes})
          </button>
        )}
      </div>

      <form className="toolbar" onSubmit={(e) => void ajouter(e)} aria-label="Ajouter une famille">
        <div className="field grow">
          <label htmlFor="nouvelle-famille">Nouvelle famille</label>
          <input id="nouvelle-famille" value={nouveau} onChange={(e) => setNouveau(e.target.value)} placeholder="Ex. : Désenfumage" autoComplete="off" />
        </div>
        <button type="submit" className="btn btn-primary">Ajouter</button>
      </form>

      <div aria-live="polite" className="flash">{message}</div>
      {erreur && <p className="alert" role="alert">{erreur}</p>}

      {familles.status === 'loading' && <Loading label="Chargement des familles…" />}
      {familles.status === 'error' && <ErrorState message={messageErreur(familles.error)} onRetry={familles.reload} />}
      {familles.status === 'ready' && familles.data!.length === 0 && (
        <EmptyState
          titre="Aucune famille de tickets"
          action={<button type="button" className="btn btn-primary" onClick={() => void agir(() => repo.importFamillesStandard(), 'Les familles standard ont été ajoutées.')}>Importer les {FAMILLES_STANDARD.length} familles standard</button>}
        >
          Importez les familles usuelles du bâtiment, puis adaptez-les à votre organisation.
        </EmptyState>
      )}
      {familles.status === 'ready' && familles.data!.length > 0 && (
        <div className="table-wrap">
          <table>
            <caption className="sr-only">Familles de tickets</caption>
            <thead>
              <tr><th scope="col">Famille</th><th scope="col">Prestataires référencés</th><th scope="col">État</th><th scope="col"><span className="sr-only">Actions</span></th></tr>
            </thead>
            <tbody>
              {familles.data!.map((f: Famille) => (
                <tr key={f.id} className={f.actif ? '' : 'inactive'}>
                  <th scope="row">
                    {enEdition?.id === f.id ? (
                      <form
                        className="inline-edit"
                        onSubmit={(e) => { e.preventDefault(); void agir(() => repo.updateFamille(f.id, { libelle: enEdition.libelle }), 'Famille renommée.').then((ok) => { if (ok) setEnEdition(null); }); }}
                      >
                        <label className="sr-only" htmlFor={`ren-${f.id}`}>Nouveau nom de {f.libelle}</label>
                        <input id={`ren-${f.id}`} value={enEdition.libelle} onChange={(e) => setEnEdition({ id: f.id, libelle: e.target.value })} />
                        <button type="submit" className="btn btn-primary">Enregistrer</button>
                        <button type="button" className="btn" onClick={() => setEnEdition(null)}>Annuler</button>
                      </form>
                    ) : (<><span className="nom">{f.libelle}</span><span className="sous code">{f.code}</span></>)}
                  </th>
                  <td>
                    {f.nb_prestataires === 0
                      ? <Badge ton="alerte" title="Aucun prestataire ne pourra être proposé pour cette famille">Aucun</Badge>
                      : <Link to={`/annuaire?famille=${f.id}`}>{f.nb_prestataires} prestataire{f.nb_prestataires > 1 ? 's' : ''}</Link>}
                  </td>
                  <td><Badge ton={f.actif ? 'ok' : 'neutre'}>{f.actif ? 'Active' : 'Désactivée'}</Badge></td>
                  <td><div className="actions">
                    <button type="button" className="btn" onClick={() => setEnEdition({ id: f.id, libelle: f.libelle })} aria-label={`Renommer ${f.libelle}`}>Renommer</button>
                    <button
                      type="button" className="btn" aria-label={`${f.actif ? 'Désactiver' : 'Réactiver'} ${f.libelle}`}
                      onClick={() => void agir(() => repo.updateFamille(f.id, { actif: !f.actif }), `${f.libelle} : ${f.actif ? 'famille désactivée (elle n\'est plus proposée à la création des tickets).' : 'famille réactivée.'}`)}
                    >
                      {f.actif ? 'Désactiver' : 'Réactiver'}
                    </button>
                  </div></td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}

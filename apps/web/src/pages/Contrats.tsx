import { type FormEvent, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import type { Calendrier, Contrat, Famille, Priorite, Prestataire, RegleSla, Site } from '@nova/shared';
import { useApp } from '../context';
import { messageErreur, useAsync } from '../hooks';
import { PRIORITES, dateCivile, duree } from '../labels';
import { Badge, EmptyState, ErrorState, Field, Loading, Modal } from '../ui';

const PRIOS: Priorite[] = ['p1', 'p2', 'p3', 'p4'];

function etatContrat(c: Contrat, aujourdhui: string): { libelle: string; ton: 'ok' | 'alerte' | 'danger' | 'neutre' } {
  if (c.statut === 'suspendu') return { libelle: 'Suspendu', ton: 'alerte' };
  if (c.date_fin !== null && c.date_fin < aujourdhui) return { libelle: 'Échu', ton: 'danger' };
  if (c.date_debut > aujourdhui) return { libelle: 'À venir', ton: 'neutre' };
  return { libelle: 'En cours', ton: 'ok' };
}

export function ContratsPage() {
  const { repo, today } = useApp();
  const contrats = useAsync(() => repo.listContrats(), [repo]);
  const annuaire = useAsync(() => repo.listPrestataires(), [repo]);
  const familles = useAsync(() => repo.listFamilles(), [repo]);
  const sites = useAsync(() => repo.listSites(), [repo]);
  const calendriers = useAsync(() => repo.listCalendriers(), [repo]);
  const parametres = useAsync(() => repo.getParametres(), [repo]);
  const [edition, setEdition] = useState<Contrat | 'nouveau' | null>(null);
  const [message, setMessage] = useState('');
  const [erreur, setErreur] = useState('');
  const refs = useMemo(() => ({
    sites: new Map((sites.data ?? []).map((s) => [s.id, s.nom])), familles: new Map((familles.data ?? []).map((f) => [f.id, f.libelle])),
    calendriers: new Map((calendriers.data ?? []).map((c) => [c.id, c.nom])),
  }), [sites.data, familles.data, calendriers.data]);
  const prets = [contrats, annuaire, familles, sites, calendriers, parametres];
  const enErreur = prets.find((a) => a.status === 'error');
  const chargement = !enErreur && prets.some((a) => a.status === 'loading');

  async function basculer(c: Contrat) {
    setErreur(''); setMessage('');
    try {
      await repo.updateContrat(c.id, { statut: c.statut === 'actif' ? 'suspendu' : 'actif' });
      setMessage(`Le contrat « ${c.libelle} » est maintenant ${c.statut === 'actif' ? 'suspendu' : 'actif'}.`);
      contrats.reload();
    } catch (e) { setErreur(messageErreur(e)); }
  }
  async function exiger(valeur: boolean) {
    setErreur(''); setMessage('');
    try {
      await repo.setParametres({ exiger_contrat: valeur });
      setMessage(valeur ? 'Un contrat actif est désormais exigé pour affecter un prestataire.' : 'Un contrat n\'est plus exigé pour affecter un prestataire.');
      parametres.reload();
    } catch (e) { setErreur(messageErreur(e)); }
  }

  return (
    <section aria-labelledby="titre-contrats">
      <div className="page-head">
        <div>
          <h1 id="titre-contrats">Contrats de service</h1>
          <p className="lede">Un contrat lie un prestataire à des sites et des familles, avec des délais de prise en compte et de résolution par priorité, comptés en minutes ouvrées.</p>
        </div>
        <button type="button" className="btn btn-primary" disabled={chargement || Boolean(enErreur)} onClick={() => setEdition('nouveau')}>Ajouter un contrat</button>
      </div>

      {parametres.status === 'ready' && (
        <div className="carte">
          <label className="check">
            <input type="checkbox" checked={parametres.data!.exiger_contrat} onChange={(e) => void exiger(e.target.checked)} aria-describedby="aide-exiger" />
            Exiger un contrat actif pour affecter un prestataire
          </label>
          <p className="help" id="aide-exiger">
            Si coché, seuls les prestataires ayant un contrat actif, en cours et couvrant le site et la famille du ticket restent éligibles ; les autres apparaissent avec le motif « aucun contrat ».
            Les calendriers se gèrent dans <Link to="/calendriers">Calendriers</Link>.
          </p>
        </div>
      )}

      <div aria-live="polite" className="flash">{message}</div>
      {erreur && <p className="alert" role="alert">{erreur}</p>}
      {chargement && <Loading label="Chargement des contrats…" />}
      {enErreur && <ErrorState message={messageErreur(enErreur.error)} onRetry={() => prets.forEach((a) => a.reload())} />}
      {contrats.status === 'ready' && !enErreur && contrats.data!.length === 0 && (
        <EmptyState titre="Aucun contrat" action={<button type="button" className="btn btn-primary" onClick={() => setEdition('nouveau')}>Ajouter le premier contrat</button>}>
          {annuaire.data && annuaire.data.length === 0 ? <>Commencez par <Link to="/annuaire">ajouter vos prestataires</Link>.</> : 'Sans contrat, aucune échéance SLA n\'est suivie.'}
        </EmptyState>
      )}
      {contrats.status === 'ready' && !enErreur && contrats.data!.length > 0 && (
        <div className="table-wrap">
          <table>
            <caption className="sr-only">Contrats de service</caption>
            <thead><tr>
              <th scope="col">Contrat</th><th scope="col">Période</th><th scope="col">Périmètre</th><th scope="col">Délais par priorité</th><th scope="col">État</th><th scope="col"><span className="sr-only">Actions</span></th>
            </tr></thead>
            <tbody>
              {contrats.data!.map((c) => {
                const etat = etatContrat(c, today());
                return (
                  <tr key={c.id}>
                    <th scope="row"><span className="nom">{c.libelle}</span><span className="sous">{c.prestataire_nom} · {c.calendrier_id ? refs.calendriers.get(c.calendrier_id) ?? 'Calendrier' : '24 h/24'}</span></th>
                    <td>{dateCivile(c.date_debut)} → {c.date_fin ? dateCivile(c.date_fin) : 'sans fin'}</td>
                    <td><ul className="plain">{c.perimetre.map((p, i) => <li key={i}>{refs.sites.get(p.site_id) ?? 'Site'} · {p.famille_id ? refs.familles.get(p.famille_id) ?? 'Famille' : 'toutes familles'}</li>)}</ul></td>
                    <td>{c.regles.length === 0 ? <span className="sous">Aucun délai défini</span> : <ul className="plain">{c.regles.map((r) => <li key={r.priorite}>{r.priorite.toUpperCase()} : prise en compte {duree(r.delai_prise_en_compte_min)}, résolution {duree(r.delai_resolution_min)}</li>)}</ul>}</td>
                    <td><Badge ton={etat.ton}>{etat.libelle}</Badge></td>
                    <td><div className="actions">
                      <button type="button" className="btn" aria-label={`Modifier ${c.libelle}`} onClick={() => setEdition(c)}>Modifier</button>
                      <button type="button" className="btn" aria-label={`${c.statut === 'actif' ? 'Suspendre' : 'Réactiver'} ${c.libelle}`} onClick={() => void basculer(c)}>{c.statut === 'actif' ? 'Suspendre' : 'Réactiver'}</button>
                    </div></td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
      {edition && annuaire.data && familles.data && sites.data && calendriers.data && (
        <ContratModal
          contrat={edition === 'nouveau' ? null : edition} annuaire={annuaire.data} familles={familles.data} sites={sites.data} calendriers={calendriers.data}
          onClose={() => setEdition(null)}
          onSaved={(c, creation) => { setEdition(null); setMessage(creation ? `Le contrat « ${c.libelle} » a été créé.` : `Le contrat « ${c.libelle} » a été mis à jour.`); contrats.reload(); }}
        />
      )}
    </section>
  );
}

interface LignePerimetre { site_id: string; famille_id: string }
type ReglesForm = Record<Priorite, { actif: boolean; pec: string; res: string; cal: string }>;

function ContratModal({ contrat, annuaire, familles, sites, calendriers, onClose, onSaved }: {
  contrat: Contrat | null; annuaire: Prestataire[]; familles: Famille[]; sites: Site[]; calendriers: Calendrier[];
  onClose: () => void; onSaved: (c: Contrat, creation: boolean) => void;
}) {
  const { repo, today } = useApp();
  const [annuaireId, setAnnuaireId] = useState(contrat?.annuaire_id ?? '');
  const [libelle, setLibelle] = useState(contrat?.libelle ?? '');
  const [debut, setDebut] = useState(contrat?.date_debut ?? today());
  const [fin, setFin] = useState(contrat?.date_fin ?? '');
  const [calendrierId, setCalendrierId] = useState(contrat?.calendrier_id ?? '');
  const [notes, setNotes] = useState(contrat?.notes ?? '');
  const [perimetre, setPerimetre] = useState<LignePerimetre[]>(contrat?.perimetre.map((p) => ({ site_id: p.site_id, famille_id: p.famille_id ?? '' })) ?? [{ site_id: sites[0]?.id ?? '', famille_id: '' }]);
  const [regles, setRegles] = useState<ReglesForm>(() => Object.fromEntries(PRIOS.map((p) => {
    const r = contrat?.regles.find((x: RegleSla) => x.priorite === p);
    return [p, { actif: Boolean(r), pec: r ? String(r.delai_prise_en_compte_min) : '', res: r ? String(r.delai_resolution_min) : '', cal: r?.calendrier_id ?? '' }];
  })) as ReglesForm);
  const [erreurs, setErreurs] = useState<Partial<Record<'annuaire' | 'libelle' | 'fin' | 'perimetre' | 'regles', string>>>({});
  const [erreur, setErreur] = useState('');
  const [envoi, setEnvoi] = useState(false);

  async function envoyer(e: FormEvent) {
    e.preventDefault();
    const er: typeof erreurs = {};
    if (!annuaireId) er.annuaire = 'Choisissez un prestataire.';
    if (!libelle.trim()) er.libelle = 'Le libellé est obligatoire.';
    if (fin && fin < debut) er.fin = 'La fin précède le début.';
    if (perimetre.length === 0 || perimetre.some((p) => !p.site_id)) er.perimetre = 'Ajoutez au moins un site.';
    const reglesEnvoyees: RegleSla[] = [];
    for (const p of PRIOS) {
      const r = regles[p];
      if (!r.actif) continue;
      const pec = Number.parseInt(r.pec, 10); const res = Number.parseInt(r.res, 10);
      if (!(pec > 0) || !(res > 0)) { er.regles = `${p.toUpperCase()} : indiquez deux délais en minutes (supérieurs à 0).`; break; }
      if (res < pec) { er.regles = `${p.toUpperCase()} : la résolution ne peut pas être plus courte que la prise en compte.`; break; }
      reglesEnvoyees.push({ priorite: p, delai_prise_en_compte_min: pec, delai_resolution_min: res, calendrier_id: r.cal || null });
    }
    setErreurs(er);
    if (Object.keys(er).length) return;
    const donnees = {
      libelle: libelle.trim(), date_debut: debut, date_fin: fin || null, calendrier_id: calendrierId || null, notes: notes.trim() || null,
      perimetre: perimetre.map((p) => ({ site_id: p.site_id, famille_id: p.famille_id || null })), regles: reglesEnvoyees,
    };
    setErreur(''); setEnvoi(true);
    try { onSaved(contrat ? await repo.updateContrat(contrat.id, donnees) : await repo.createContrat({ ...donnees, annuaire_id: annuaireId }), !contrat); }
    catch (ex) { setErreur(messageErreur(ex)); setEnvoi(false); }
  }
  const majPerim = (i: number, p: Partial<LignePerimetre>) => setPerimetre((l) => l.map((x, n) => (n === i ? { ...x, ...p } : x)));
  const majRegle = (p: Priorite, v: Partial<ReglesForm[Priorite]>) => setRegles((r) => ({ ...r, [p]: { ...r[p], ...v } }));

  return (
    <Modal titre={contrat ? `Modifier ${contrat.libelle}` : 'Ajouter un contrat'} onClose={onClose}>
      <form onSubmit={(e) => void envoyer(e)} noValidate>
        <div className="grid2">
          <Field label="Prestataire" required error={erreurs.annuaire}>
            {(p) => (
              <select {...p} value={annuaireId} disabled={Boolean(contrat)} onChange={(e) => setAnnuaireId(e.target.value)}>
                <option value="">Choisir…</option>
                {annuaire.map((a) => <option key={a.id} value={a.id}>{a.nom}</option>)}
              </select>
            )}
          </Field>
          <Field label="Libellé" required error={erreurs.libelle}>{(p) => <input {...p} value={libelle} onChange={(e) => setLibelle(e.target.value)} autoComplete="off" />}</Field>
          <Field label="Début" required>{(p) => <input {...p} type="date" value={debut} onChange={(e) => setDebut(e.target.value)} />}</Field>
          <Field label="Fin" help="Vide : sans date de fin." error={erreurs.fin}>{(p) => <input {...p} type="date" value={fin} min={debut} onChange={(e) => setFin(e.target.value)} />}</Field>
          <Field label="Calendrier du contrat" help="Vide : 24 h/24, 7 j/7.">
            {(p) => (
              <select {...p} value={calendrierId} onChange={(e) => setCalendrierId(e.target.value)}>
                <option value="">24 h/24 (aucun calendrier)</option>
                {calendriers.map((c) => <option key={c.id} value={c.id}>{c.nom}</option>)}
              </select>
            )}
          </Field>
        </div>

        <fieldset className="familles-choix">
          <legend>Périmètre</legend>
          <p className="help">Le contrat couvre ces sites, pour la famille indiquée ou pour toutes.</p>
          {perimetre.map((p, i) => (
            <div key={i} className="famille-ligne" role="group" aria-label={`Ligne de périmètre ${i + 1}`}>
              <label className="check">Site
                <select value={p.site_id} onChange={(e) => majPerim(i, { site_id: e.target.value })}>
                  <option value="">Choisir…</option>
                  {sites.map((s) => <option key={s.id} value={s.id}>{s.nom}</option>)}
                </select>
              </label>
              <label className="check">Famille
                <select value={p.famille_id} onChange={(e) => majPerim(i, { famille_id: e.target.value })}>
                  <option value="">Toutes les familles</option>
                  {familles.map((f) => <option key={f.id} value={f.id}>{f.libelle}</option>)}
                </select>
              </label>
              {perimetre.length > 1 && <button type="button" className="btn" aria-label={`Retirer la ligne de périmètre ${i + 1}`} onClick={() => setPerimetre((l) => l.filter((_, n) => n !== i))}>Retirer</button>}
            </div>
          ))}
          <button type="button" className="btn" onClick={() => setPerimetre((l) => [...l, { site_id: '', famille_id: '' }])}>Ajouter une ligne</button>
          {erreurs.perimetre && <p className="error" role="alert">{erreurs.perimetre}</p>}
        </fieldset>

        <fieldset className="familles-choix">
          <legend>Délais par priorité (minutes ouvrées)</legend>
          <p className="help">La prise en compte part de l'affectation, la résolution de la création du ticket. Sans règle pour une priorité, aucune échéance n'est suivie.</p>
          {PRIOS.map((p) => {
            const r = regles[p];
            return (
              <div key={p} className="famille-ligne" role="group" aria-label={`Délais ${PRIORITES[p]}`}>
                <label className="check"><input type="checkbox" checked={r.actif} onChange={(e) => majRegle(p, { actif: e.target.checked })} /> {PRIORITES[p]}</label>
                <label className="check">Prise en compte (min) <input type="number" min={1} value={r.pec} disabled={!r.actif} onChange={(e) => majRegle(p, { pec: e.target.value })} /></label>
                <label className="check">Résolution (min) <input type="number" min={1} value={r.res} disabled={!r.actif} onChange={(e) => majRegle(p, { res: e.target.value })} /></label>
                <label className="check">Calendrier
                  <select value={r.cal} disabled={!r.actif} onChange={(e) => majRegle(p, { cal: e.target.value })}>
                    <option value="">Celui du contrat</option>
                    {calendriers.map((c) => <option key={c.id} value={c.id}>{c.nom}</option>)}
                  </select>
                </label>
                {r.actif && Number.parseInt(r.pec, 10) > 0 && Number.parseInt(r.res, 10) > 0 && <span className="sous">{duree(Number.parseInt(r.pec, 10))} / {duree(Number.parseInt(r.res, 10))}</span>}
              </div>
            );
          })}
          {erreurs.regles && <p className="error" role="alert">{erreurs.regles}</p>}
        </fieldset>

        <Field label="Notes internes">{(p) => <textarea {...p} rows={2} value={notes} onChange={(e) => setNotes(e.target.value)} />}</Field>
        {erreur && <p className="alert" role="alert">{erreur}</p>}
        <footer className="modal-foot">
          <button type="button" className="btn" onClick={onClose}>Annuler</button>
          <button type="submit" className="btn btn-primary" disabled={envoi}>{envoi ? 'Enregistrement…' : 'Enregistrer'}</button>
        </footer>
      </form>
    </Modal>
  );
}

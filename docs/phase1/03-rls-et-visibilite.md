# 03 — Stratégie RLS et matrice de visibilité

## Principe
Trois couches, de la plus dure à la plus souple :
1. **RLS PostgreSQL** (garantie dure) : isolation par organisation et partages explicites.
2. **Périmètre** (bailleur > portefeuille > site > bâtiment > niveau > local) : appliqué en SQL par une fonction `app.in_scope(site_id)`, donc aussi sous RLS.
3. **RBAC / ABAC applicatif** : actions permises, selon rôle, contrat actif et habilitation valide.

## Variables de session (posées par transaction)
`app.user_id`, `app.org_id` (espace actif, vérifié contre `appartenance`), `app.scope_site_ids` (liste ou « tous »). Si `app.org_id` est absent, **toutes les politiques refusent** (`current_setting('app.org_id', true)` nul → aucune ligne).

## Trois familles de tables

**A. Propres à une organisation** (patrimoine, actifs, catégories, règles, contrats côté propriétaire) :
```sql
ALTER TABLE site ENABLE ROW LEVEL SECURITY;
ALTER TABLE site FORCE ROW LEVEL SECURITY;
CREATE POLICY site_org ON site
  USING (org_id = app.current_org() AND app.in_scope(id));
```

**B. Objets partagés** (ticket, OT, documents, devis) : visibles par le propriétaire, le gestionnaire sous mandat actif et les organisations listées dans `acces_objet` :
```sql
CREATE POLICY ticket_visible ON ticket USING (
  owner_org_id = app.current_org()
  OR managing_org_id = app.current_org()
  OR EXISTS (SELECT 1 FROM acces_objet a
             WHERE a.objet_type = 'ticket' AND a.objet_id = ticket.id
               AND a.org_id = app.current_org() AND a.revoque_at IS NULL)
);
```
`acces_objet` est écrit uniquement par des fonctions `SECURITY DEFINER` (affectation, sous-traitance, fin de contrat), jamais par l'API directement.

**C. Messages** : la visibilité est portée par le **fil**, pas par le message. Un fil a une liste de `fil_participant(org_id)`. Un message est visible si l'organisation courante est participante du fil. Une note interne est un fil à un seul participant. Les fils prévus :
- `partage_ticket` : bailleur / PM / prestataire affecté.
- `interne_<org>` : une seule organisation.
- `principal_soustraitant` : prestataire principal et sous-traitant, **invisible au client**.

## Cloisonnement des prix (V2)
Table `ot_financier` séparée, avec sa propre politique : visible par le prestataire principal et le client, **jamais** par le sous-traitant. La refacturation sous-traitant → principal est une autre ligne (`refacturation`), invisible au client, ce qui masque les marges.

## Compte éditeur
Rôle SQL distinct, **aucun droit** sur les tables métier. Il lit uniquement des vues d'agrégats (comptages d'usage, santé). Pour un support : `support_grant` (organisation, motif, durée courte, approuvé par l'admin de l'organisation) ; chaque lecture est journalisée.

## Pièges connus et parades
| Piège | Parade |
|---|---|
| Table créée sans RLS | Test de catalogue en CI : toute table avec `org_id` doit avoir RLS activée, forcée et au moins une politique |
| Fonction ou vue contournant la RLS | Vues en `security_invoker`, fonctions `SECURITY DEFINER` listées et revues |
| Cache Redis partagé | Clés préfixées par `org_id` ; test dédié |
| Recherche plein texte | Même requête, donc même RLS ; pas d'index externe |
| Pièces jointes S3 | Accès uniquement par URL pré-signée de courte durée, générée après contrôle d'accès en base |
| Exports et rapports | Exécutés avec le même rôle SQL, donc même RLS |
| Fin de contrat | Révocation de `acces_objet` par date ; job quotidien de rattrapage + test |

## Matrice de visibilité (qui voit quoi)
Légende : ● tout dans son périmètre · ◐ partiel (précisé) · ○ rien

| Objet | Bailleur | Property manager | Prestataire principal | Sous-traitant | Éditeur |
|---|---|---|---|---|---|
| Patrimoine (site → local) | ● son patrimoine | ● sites sous mandat actif | ◐ sites de ses contrats actifs, lecture | ◐ site/local de l'OT confié | ○ (comptage agrégé) |
| Occupants, contacts, occupations | ● | ● | ◐ nom, téléphone, local, sur ticket affecté (réglable) | ◐ idem si le principal l'a autorisé sur l'OT | ○ |
| Actifs | ● | ● | ◐ actifs de son périmètre contractuel | ◐ actif de l'OT | ○ |
| Ticket | ● | ● | ◐ tickets qui lui sont affectés | ○ | ○ |
| Fil partagé du ticket | ● | ● | ● (si affecté) | ○ | ○ |
| Note interne (bailleur / PM) | ◐ la sienne | ◐ la sienne | ○ | ○ | ○ |
| Note interne prestataire | ○ | ○ | ◐ la sienne | ○ | ○ |
| OT | ● | ● | ● ses OT | ◐ les OT qui lui sont confiés | ○ |
| Fil principal ↔ sous-traitant | ○ | ○ | ● | ● | ○ |
| Contrat de service | ● | ● | ◐ ses contrats (côté prestataire) | ○ (jamais le contrat parent) | ○ |
| SLA et pénalités | ● | ● | ● ses SLA | ◐ son SLA dérivé | ○ |
| Prix, devis, factures (V2) | ● | ● | ● | ○ ses propres lignes de refacturation seulement | ○ |
| Marges du prestataire (V2) | ○ | ○ | ● | ○ | ○ |
| Documents de conformité prestataire | ● | ● | ◐ les siens | ◐ les siens | ○ |
| Journal d'audit | ◐ son organisation | ◐ son organisation | ◐ son organisation | ◐ son organisation | ◐ actions de support seulement |
| Rapports / KPI | ● son portefeuille | ● ses sites | ◐ multi-clients cloisonné | ◐ ses OT | ◐ usage et santé, sans donnée métier |

## À valider
- Visibilité des coordonnées des occupants pour le prestataire (minimisation RGPD) : **juriste**.
- Accès d'un ancien prestataire après fin de contrat : hypothèse par défaut, **aucun accès** aux objets ouverts à la date de fin ; lecture seule de ses propres rapports uniquement si le contrat le prévoit.

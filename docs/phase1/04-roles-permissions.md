# 04 — Matrice rôles / permissions

## Modèle
- Un rôle est défini **par organisation** (modèles fournis par la plateforme, personnalisables) et se combine avec un **périmètre** (`appartenance_perimetre` : portefeuille, site, bâtiment, niveau ou local) et des attributs : contrat actif, habilitation valide, document de conformité non expiré (blocage d'affectation).
- Un utilisateur peut avoir un rôle différent dans chaque organisation. Le rôle effectif est celui de l'espace de travail actif.
- Délégation : un titulaire peut déléguer tout ou partie de ses permissions, pour une durée limitée, tracée.
- MFA obligatoire pour administrateur, gestionnaire FM, asset manager ; recommandé pour les autres.
- Le rôle « occupant » **n'existe pas** (voir [00](00-revision-perimetre.md)).

## Rôles par type d'organisation
| Rôle | Bailleur | PM | Prestataire | Sous-traitant | Éditeur |
|---|---|---|---|---|---|
| Administrateur d'organisation | ✔ | ✔ | ✔ | ✔ | |
| Gestionnaire FM / dispatcheur | | ✔ | ✔ (dispatch interne) | | |
| Accueil / hotline | | ✔ | | | |
| Responsable de site | ✔ | ✔ | | | |
| Asset manager / direction (lecture) | ✔ | ✔ | | | |
| Technicien | | | ✔ | ✔ | |
| Prestataire externe (accès restreint) | | ✔ (invité) | | | |
| Support plateforme | | | | | ✔ |
| Super-admin plateforme | | | | | ✔ |

## Permissions par rôle
Légende : ✔ accordé · ◐ conditionné · — non

| Permission | Admin org | Gest. FM | Accueil | Resp. site | Asset mgr | Technicien | Presta ext. | Support |
|---|---|---|---|---|---|---|---|---|
| `ticket.create` | ✔ | ✔ | ✔ | ✔ | — | ◐ via scan QR | — | — |
| `ticket.read` | ✔ | ✔ | ✔ | ✔ (son site) | ✔ | ◐ affectés | ◐ affectés | — |
| `ticket.qualify` (catégorie, priorité) | ✔ | ✔ | — | ✔ | — | — | — | — |
| `ticket.assign` | ✔ | ✔ | — | ◐ | — | — | — | — |
| `ticket.transition` | ✔ | ✔ | — | ✔ | — | ◐ ses statuts | ◐ ses statuts | — |
| `ticket.close` / `reject` | ✔ | ✔ | — | ✔ | — | — | — | — |
| `ticket.merge_link` | ✔ | ✔ | ✔ | — | — | — | — | — |
| `ticket.comment_shared` | ✔ | ✔ | ✔ | ✔ | — | ✔ | ✔ | — |
| `ticket.comment_internal` | ✔ | ✔ | ✔ | ✔ | — | ✔ | — | — |
| `ticket.satisfaction_record` | ✔ | ✔ | ✔ | ✔ | — | — | — | — |
| `ot.create` / `send` | ✔ | ✔ | — | — | — | — | — | — |
| `ot.accept` / `refuse` | ✔ | ✔ | — | — | — | — | — | — |
| `ot.execute` (checklist, photos, temps, signature) | — | — | — | — | — | ✔ | ✔ | — |
| `ot.validate` (côté client) | ✔ | ✔ | — | ✔ | — | — | — | — |
| `ot.subcontract` (1 niveau) | ✔ (prestataire) | ✔ (prestataire) | — | — | — | — | — | — |
| `patrimoine.read` | ✔ | ✔ | ✔ | ✔ | ✔ | ◐ | ◐ | — |
| `patrimoine.write` / `import` | ✔ | ✔ | — | ◐ | — | — | — | — |
| `actif.write` | ✔ | ✔ | — | ◐ | — | — | — | — |
| `contrat.read` | ✔ | ✔ | — | — | ✔ | — | — | — |
| `contrat.write` / `sla.configure` | ✔ | ✔ | — | — | — | — | — | — |
| `user.invite` / `manage` | ✔ | — | — | — | — | — | — | — |
| `config.manage` (catégories, statuts, règles) | ✔ | ✔ | — | — | — | — | — | — |
| `report.read` | ✔ | ✔ | ◐ | ✔ | ✔ | — | — | — |
| `export.run` | ✔ | ✔ | — | — | ✔ | — | — | — |
| `audit.read` | ✔ | — | — | — | — | — | — | ◐ |
| `support.access` (via `support_grant`) | — | — | — | — | — | — | — | ◐ |

## Règles ABAC (contrôles non exprimables en rôle seul)
1. Affectation d'un ticket à un prestataire : refusée sans **contrat actif** couvrant site + lot technique, ou avec **document de conformité expiré** (assurance, habilitation).
2. Un technicien ne voit que les OT affectés à son équipe, dans les organisations où il a une appartenance active.
3. Une action sur un objet partagé exige que l'organisation courante figure dans `acces_objet` non révoqué.
4. Désactivation d'un utilisateur ou d'une organisation : **en cascade** (appartenances, sessions, jetons push, bases locales mobiles à l'ouverture suivante).
5. Les actions sensibles (export, changement de rôle, accès support) sont toujours journalisées.

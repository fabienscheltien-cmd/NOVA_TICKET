# 09 — Plan de tests d'isolation

Objectif : aucune fuite de données entre organisations, prouvée automatiquement en CI à chaque modification. **Un test d'isolation en échec bloque la fusion.**

## Jeu de départ (fixture commune)
2 bailleurs (B1, B2), 2 property managers (PM1 sous mandat de B1 et B2, PM2 sans mandat), 3 prestataires (P1, P2 concurrents sur un même site de B1, P3), 1 sous-traitant (S1, sous-traitant de P1 uniquement), utilisateurs mono et multi-organisations, sites avec plusieurs immeubles et plusieurs occupants. Données **générées et signalées comme factices**.

## Niveau 1 — Catalogue (automatique, sans scénario)
- Toute table portant `org_id` : RLS activée **et forcée**, au moins une politique.
- Aucun rôle applicatif avec `BYPASSRLS` ni propriétaire de table.
- Liste des fonctions `SECURITY DEFINER` figée : tout ajout non listé fait échouer le test.
- Absence de `app.org_id` : toute lecture renvoie 0 ligne.

## Niveau 2 — Base de données (principal × table)
Pour chaque principal (utilisateur dans un espace) et chaque table métier : le nombre de lignes lisibles est égal à l'attendu calculé indépendamment ; toute écriture hors périmètre est refusée. Test généré à partir de la liste des tables pour couvrir les ajouts futurs.

## Niveau 3 — Scénarios métier obligatoires
| # | Scénario | Résultat attendu |
|---|---|---|
| 1 | B1 lit les données de B2 | 0 ligne, 404 |
| 2 | B2 lit un ticket de B1 | 404 |
| 3 | P1 et P2, concurrents sur le même site | P2 ne voit ni tickets, ni OT, ni fils, ni SLA de P1 |
| 4 | S1 lit le contrat parent de P1 ou un prix | 0 ligne |
| 5 | S1 lit le ticket d'origine d'un OT enfant | 404 |
| 6 | Le client lit le fil principal ↔ sous-traitant, l'OT enfant ou la marge | 0 ligne |
| 7 | Ancien prestataire après fin de contrat | accès révoqué à la date de fin ; job de rattrapage vérifié |
| 8 | Utilisateur multi-organisations | rien du client A visible dans l'espace B ; changement d'espace sans résidu |
| 9 | Note interne du PM lue par un prestataire | 404 |
| 10 | Note interne du prestataire lue par le client | 404 |
| 11 | PM2 sans mandat | aucun accès au patrimoine de B1 |
| 12 | Fin de mandat PM1 → PM3 | PM1 perd l'accès, PM3 hérite de l'historique, B1 garde la propriété |
| 13 | Utilisateur désactivé | requêtes refusées, appareils déconnectés |
| 14 | Compte éditeur | 0 ligne métier ; accès support seulement avec `support_grant` valide, journalisé |
| 15 | Occupants d'un site | PM1 voit les occupants de ses sites, jamais ceux d'un autre mandat |

## Niveau 4 — Canaux annexes
- **API** : mêmes scénarios, identifiants d'objets devinés (IDOR) et énumération.
- **Recherche plein texte, filtres sauvegardés, actions en masse, exports** : aucune ligne hors périmètre.
- **Pièces jointes** : URL pré-signée refusée pour un tiers ; expiration respectée ; fichier non sain non téléchargeable.
- **Cache Redis** : clés préfixées par organisation ; deux organisations, même requête, aucun croisement.
- **Notifications** : push sans donnée sensible ; e-mails sans pièce jointe ni détail confidentiel.
- **Mobile** : bascule d'espace et déconnexion suppriment la base locale ; la synchronisation ne renvoie rien d'une autre organisation ; actions d'un appareil d'un utilisateur désactivé rejetées.
- **Journal d'audit** : chaque accès inter-organisations produit une ligne.

## Exécution
- Niveaux 1 à 3 : à chaque pull request (base PostgreSQL réelle en conteneur, jamais de mock).
- Niveau 4 : à chaque pull request pour l'API ; mobile et end-to-end nocturnes.
- Test négatif de contrôle : une politique volontairement cassée doit faire échouer la suite (le banc de test doit prouver qu'il détecte).

## À prévoir hors automatisme
Revue de sécurité externe avant la première mise en production avec des données réelles, et test d'intrusion : **à faire faire par un expert**.

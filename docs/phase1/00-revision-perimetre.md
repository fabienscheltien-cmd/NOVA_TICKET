# 00 — Périmètre révisé : occupants sans compte

## Fait (décision du porteur du projet, 15/10/2026)
Les occupants n'ont aucune action dans la plateforme. Seuls les gestionnaires (property manager) et les bailleurs agissent, avec les prestataires.

## Conséquences sur le cahier des charges

| Élément initial | Révision |
|---|---|
| Type d'organisation « Occupant » | **Supprimé.** L'occupant devient un `contact` (fiche sans connexion) rattaché à un local. |
| Utilisateur « occupant » | **Supprimé.** |
| Portail web occupant, app mobile occupant | **Hors périmètre** (pas de MVP, pas de V2 tant que non redemandé). |
| « Un occupant signale un incident en 30 secondes » | Devient : **le gestionnaire / l'accueil crée le ticket en 30 s** (web et mobile, scan QR du local). |
| Clôture validée par l'occupant | Devient : validation par le gestionnaire (ou clôture automatique après délai configurable). |
| Enquête de satisfaction occupant | Devient : **saisie de la satisfaction par le gestionnaire** (note + commentaire + canal : téléphone, e-mail). |
| QR code par local / équipement | **Conservé**, scanné par le personnel (gestionnaire, technicien). |
| Canal e-mail entrant | **Conservé** : un e-mail crée un ticket au statut Nouveau. L'occupant n'agit pas dans l'outil, il écrit simplement à une adresse. |
| Notifications à l'occupant | Aucune par défaut. |

## Hypothèses à confirmer (une ligne chacune)
- **HP1** : le canal e-mail entrant reste utile, l'expéditeur étant rapproché d'un `contact` s'il existe. Si vous ne voulez aucun flux d'e-mail venant des occupants, on le supprime.
- **HP2** : la saisie de satisfaction par le gestionnaire est suffisante.

## Précision du porteur : multi-immeubles, multi-occupants, multi-sites
Le produit doit gérer plusieurs immeubles, plusieurs occupants sur un même site, et plusieurs sites. C'est modélisé par `site > bâtiment > niveau > local` et par `occupant` / `contact` / `occupation` datée (voir [02](02-erd.md)). Un local peut avoir plusieurs occupants simultanés et successifs ; les parties communes n'ont pas d'occupant.

## Effets positifs
- Disparition de l'authentification occupant, de l'anti-abus du portail public et de l'interface la plus exposée.
- Les données occupants se limitent à des fiches contact : surface RGPD réduite, mais **non nulle** (nom, téléphone, e-mail de personnes qui ne sont pas utilisateurs). Les bases légales, durées de conservation et obligations d'information sont **à faire valider par un juriste**.

## Incréments MVP modifiés
L'incrément « mobile occupant » est remplacé par « création rapide de ticket (web et mobile gestionnaire) avec scan QR ».

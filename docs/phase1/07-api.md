# 07 — Liste des API (REST, `/v1`, OpenAPI)

## Conventions
- JSON, auth par jeton d'accès court (JWT) + jeton de rafraîchissement ; l'espace de travail actif est une **revendication** vérifiée côté serveur contre `appartenance` à chaque requête.
- Pagination par curseur, filtres standards, `Idempotency-Key` accepté sur toute création, erreurs au format `application/problem+json`.
- Limitation de débit par utilisateur, organisation et IP. Spécification OpenAPI générée depuis le code (`@nestjs/swagger`), publiée et testée en CI.

## Identité et espaces
| Méthode | Route | Rôle |
|---|---|---|
| POST | `/auth/login` · `/auth/mfa/verify` · `/auth/refresh` · `/auth/logout` | Authentification |
| POST | `/auth/password/forgot` · `/auth/password/reset` | Mot de passe |
| GET | `/me` · `/me/workspaces` | Profil, organisations accessibles |
| POST | `/me/workspace/switch` | Changer d'espace de travail |
| POST | `/invitations` · `/invitations/{token}/accept` | Invitations |
| GET/POST/PATCH | `/organisations/{id}/members` · `/roles` | Membres et rôles |
| POST | `/organisations/{id}/members/{id}/deactivate` | Désactivation en cascade |

## Patrimoine et occupants
| Méthode | Route |
|---|---|
| CRUD | `/portefeuilles` · `/sites` · `/batiments` · `/niveaux` · `/locaux` |
| CRUD | `/occupants` · `/contacts` · `/occupations` (un local, plusieurs occupants, historique daté) |
| GET | `/sites/{id}/occupants` (occupants actuels de tous les immeubles du site) |
| POST | `/imports/{sites\|locaux\|actifs\|utilisateurs\|occupants}` (CSV, aperçu puis validation) |
| GET | `/qr/{code}` (résout un QR vers local ou actif, sous contrôle de droits) |
| POST | `/plans` · GET `/plans/{id}` · PUT `/plans/{id}/positions` |

## Actifs
`CRUD /actifs`, `GET /actifs/{id}/historique`, `GET /actifs/{id}/qr.png`, `GET /actifs/{id}/children`.

## Contrats et configuration
`CRUD /contrats-service`, `/contrats-service/{id}/perimetre`, `/sla-regles`, `/calendriers`, `/sous-traitances`, `/mandats`, `/regles-routage`, `/categories`, `/statuts`, `/matrices-priorite`, `/feature-flags`.

## Ticketing
| Méthode | Route |
|---|---|
| POST | `/tickets` (web, mobile, hotline) · `/tickets/inbound-email` (webhook du fournisseur de messagerie) |
| GET | `/tickets` (filtres, recherche, filtres sauvegardés) · `/tickets/{id}` |
| POST | `/tickets/{id}/transitions` (`{vers, motif}`) |
| POST | `/tickets/{id}/qualify` · `/assign` · `/reassign` · `/link` · `/merge` |
| POST | `/tickets/{id}/satisfaction` (saisie par le gestionnaire) |
| POST | `/tickets/bulk` (actions en masse) |
| GET | `/tickets/{id}/duplicates` · `/tickets/{id}/timeline` |

## Fils, pièces jointes
`GET/POST /fils/{id}/messages`, `POST /files/upload-url` (URL pré-signée), `POST /files/{id}/confirm`, `GET /files/{id}/download-url` (courte durée, après contrôle d'accès, statut antivirus requis « sain »).

## Ordres de travail
`POST /tickets/{id}/work-orders`, `GET /work-orders`, `POST /work-orders/{id}/transitions`, `POST /work-orders/{id}/subcontract`, `PUT /work-orders/{id}/checklist/{taskId}`, `POST /work-orders/{id}/time-entries`, `POST /work-orders/{id}/signature`, `GET /work-orders/{id}/report.pdf`.

## Synchronisation mobile
`POST /sync/push` (actions idempotentes) · `GET /sync/pull?cursor=` · `POST /devices` (jeton push) · `DELETE /devices/{id}`.

## Notifications, reporting, audit
`GET /notifications`, `PUT /notification-preferences`, `GET /reports/{backlog|sla|workload|satisfaction|costs}`, `GET /audit` (filtrable), `GET /exports` + `POST /exports` (export complet, réversibilité), `GET /search?q=`.

## Hors MVP
Webhooks sortants et API publique documentée avec clés d'API (V2), SSO / SCIM (V2).

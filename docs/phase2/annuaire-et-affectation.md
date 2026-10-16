# Annuaire des prestataires, familles de tickets et affectation

Livré après l'incrément 2. Remplace provisoirement l'incrément 3 (contrats, SLA) : la demande du porteur était de pouvoir désigner un prestataire à partir de la famille d'un ticket.

## Principe
1. L'organisation qui dispatche (property manager ou bailleur) tient un **catalogue de familles** (plomberie, électricité, CVC, serrurerie…) et un **annuaire** de prestataires, chacun référencé sur une ou plusieurs familles avec une **priorité** (1 = préféré).
2. À la création d'un ticket, on choisit sa **famille**. Le détail renvoyé contient aussitôt les prestataires **éligibles**, triés, et une **suggestion** (le premier éligible).
3. L'**affectation** est un geste explicite depuis le détail du ticket (pas d'affectation automatique sans confirmation).

## Règle d'éligibilité
Un prestataire est **candidat** s'il est référencé sur la famille du ticket. Il est **éligible** s'il est :
- **actif** (non suspendu) ;
- **rattaché** à un compte prestataire de la plateforme (sans compte, aucun accès ne peut lui être donné) ;
- **assuré** : échéance de l'attestation non échue (échéance incluse, date du jour à Paris) ; sans échéance renseignée, l'assurance ne bloque pas.

Les candidats exclus restent visibles avec leur motif (`suspendu`, `non_rattache`, `assurance_expiree`). Tri : éligibles, puis priorité croissante, puis nom (ordre des codes).

La règle existe à deux endroits, **gardés alignés par une suite de contrat commune** (`packages/shared/src/testing/contract.ts`), exécutée contre la démonstration et contre l'API réelle sur PostgreSQL :
- SQL : `app.prestataires_eligibles(ticket)` et `app.affecter_ticket(...)` — **source de vérité**, ré-appliquée à l'affectation : aucun chemin d'API ne peut affecter un prestataire non éligible ;
- TypeScript : `evaluerEligibilite` (`packages/shared`), utilisée par la démonstration et l'aperçu à la création.

## Affectation et réaffectation (`app.affecter_ticket`)
Atomique : vérifie le droit de gérer le ticket, l'éligibilité, le statut (nouveau, qualifié ou affecté), refuse un prestataire déjà affecté ; clôt l'affectation précédente et **révoque l'accès** de l'ancien prestataire ; partage le ticket avec le nouveau (`acces_objet`) ; passe le ticket à « affecté » ; conserve l'historique avec un motif facultatif.

Visibilité : le prestataire voit le ticket (et sa famille) une fois affecté, jamais l'annuaire, les affectations ni les motifs (notes internes du dispatcheur). Deux prestataires concurrents ne se voient pas.

## Console d'administration (`apps/web`)
Tickets, annuaire, familles, détail avec affectation. Deux sources de données derrière une même interface `Repository` :
- **démonstration** (défaut) : données fictives en mémoire, bannière permanente « Données de démonstration », bouton de réinitialisation ;
- **API** : `VITE_DATA_SOURCE=api` et `VITE_API_URL`, jeton d'accès de l'espace de travail saisi une fois (conservé dans le navigateur). Le client `ApiRepository` est testé de bout en bout contre l'API réelle.

## Limites connues
- Un ticket est dispatché par l'organisation qui l'a créé : sa famille est issue de son catalogue ; un autre acteur (par ex. le bailleur) n'a pas de candidats à moins d'avoir son propre annuaire référençant la même famille.
- Le rattachement d'un prestataire à son compte se fait par l'identifiant d'organisation, communiqué hors plateforme (pas d'annuaire inter-organisations ni d'invitation de prestataire).
- Pas encore pris en compte : contrat de service actif et périmètre par site, calendriers et astreintes, SLA en risque, documents de conformité autres que l'assurance. Ce sont les prochains critères d'éligibilité (la règle est centralisée pour les accueillir).
- Un prestataire ne voit pas le site ni le local du ticket confié tant que les contrats de service n'existent pas.
- La console n'a pas d'écran de connexion : en mode API, le jeton est collé à la main.
- Pas de suppression d'un prestataire (suspension seulement) ni de gestion des documents.

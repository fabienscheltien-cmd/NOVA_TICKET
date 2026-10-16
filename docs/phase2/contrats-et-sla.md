# Phase 2 — Contrats de service, calendriers ouvrés et SLA

Reporté par D36 derrière l'annuaire et l'affectation, livré ensuite. Migration `0007`, API `/contrats`, `/calendriers`, `/parametres`, console « Contrats » et « Calendriers ».

## Faits (vérifiés par les tests)
- Un **contrat** lie un prestataire de l'annuaire à un **périmètre** (lignes site + famille, famille vide = toutes) sur une période (début, fin facultative), avec un statut (actif, suspendu) et des **règles SLA** par priorité (P1 à P4) : délai de prise en compte et de résolution, en minutes ouvrées, calendrier propre à la règle sinon celui du contrat sinon 24 h/24.
- Un **calendrier ouvré** = fuseau IANA, plages hebdomadaires (jours ISO, heures locales, `24:00` accepté), fermetures saisies par le client. Calcul avec **luxon** (fuseaux, changements d'heure) : tests de la spécification `06-sla.md` (critère 1 : vendredi 17 h 30, critère 2 : pause et reprise), heure d'été et d'hiver 2026, autre fuseau, plages qui se chevauchent, calendrier inutilisable.
- **Éligibilité** : nouveau motif `sans_contrat`. Il n'apparaît que si l'organisation active le paramètre **« exiger un contrat »** (désactivé par défaut) : le prestataire doit alors avoir un contrat actif, en cours à la date du jour (Paris), dont un périmètre couvre le site et la famille du ticket. Règle en SQL (`app.prestataires_eligibles`) et miroir TypeScript, alignés par la suite de contrat commune (démonstration et API réelle).
- **SLA à l'affectation** : la prise en compte part de l'affectation, la résolution de la création du ticket (06-sla, point 1). Le contrat porteur est, parmi les contrats couvrants qui définissent une règle pour la priorité, le plus spécifique (une ligne qui nomme la famille), puis le plus récent. Une réaffectation clôt les échéances précédentes et ouvre celles du nouveau contrat. Pas de règle pour la priorité : aucune échéance, ce n'est pas une erreur.
- **Isolation** : tables propres à l'organisation qui dispatche (RLS `org_id = organisation courante`, `FORCE`). Ni le bailleur du ticket ni le prestataire affecté ne lisent contrat, règle ou instance (test). Un périmètre ne peut viser qu'un site visible (trigger sous RLS), un contrat qu'une fiche d'annuaire de la même organisation (clé composite).
- **Permissions** : lecture `contrat.read`, écriture `sla.configure` (administrateur, gestionnaire FM). Le bailleur n'écrit rien (D37).

## Choix de conception
- Calcul des échéances côté application (TypeScript partagé), enregistré à l'affectation dans `sla_instance` : une seule implémentation pour la démonstration et l'API, donc pas de risque de dérive entre les deux.
- L'état « dépassé » est **dérivé à la lecture** (`now > échéance`).
- Jours fériés : **non fournis**. Le client saisit ses fermetures par calendrier. Alternative écartée : coder la liste des jours fériés français. Elle varie selon les territoires (Alsace-Moselle, outre-mer) et doit être validée avant usage (06-sla, « À valider »).

## Hypothèses et limites (à valider)
- **Pas encore faits** : pause et reprise réelles, arrêt de la prise en compte et de la résolution, alertes à 50/80/100 %, escalade, réaffectation automatique de repli, SLA dérivé du sous-traitant, KPI. Ils dépendent des transitions de statut du ticket et de la file de tâches, qui n'existent pas encore. Les fonctions `echeanceApresPause` et `minutesOuvreesEntre` sont prêtes et testées.
- Pas de suppression de calendrier ni de contrat (suspension seulement) : un calendrier référencé ne se supprime pas.
- Le choix « la résolution part de la création du ticket » est une hypothèse du document 06, configurable par contrat à terme.
- Le prestataire ne voit pas son propre contrat ni ses échéances : à définir avec les ordres de travail.
- Les délais sont saisis en minutes dans la console (affichage converti en heures et jours).

# 06 — Spécification des SLA

## Définitions
- **SLA** : engagement d'un prestataire envers un client, porté par un `contrat_service`, par priorité : délai de **prise en compte** et délai de **résolution**.
- **Calendrier ouvré** : fuseau horaire, plages hebdomadaires, jours fériés et fermetures. Défini par site, hérité du contrat si absent. Astreinte = second calendrier, utilisé selon la priorité.
- **Instance SLA** (`sla_instance`) : suivi d'un délai pour un ticket ou un OT.

## Priorité
Matrice **impact × urgence** configurable (défaut 3 × 3 → P1 à P4).

| | Urgence haute | Urgence moyenne | Urgence basse |
|---|---|---|---|
| Impact fort | P1 | P2 | P3 |
| Impact moyen | P2 | P3 | P4 |
| Impact faible | P3 | P4 | P4 |

## Règle de contrat (exemple, valeurs **purement illustratives**, à fixer par contrat)
| Priorité | Prise en compte | Résolution | Calendrier |
|---|---|---|---|
| P1 | X minutes | Y heures | astreinte 24/7 |
| P2 | … | … | ouvré |

## Calcul
1. **Départ du chrono** : création de l'affectation au prestataire pour la prise en compte ; création du ticket pour la durée totale côté client (hypothèse, configurable par contrat).
2. **Échéance** = départ + durée **en minutes ouvrées** du calendrier, calculée avec une bibliothèque de dates gérant fuseaux et changements d'heure (pas de calcul à la main).
3. **Pause** : statut « En attente » dont le motif est marqué `pause_sla`. Par défaut : accès, validation client = pause ; pièce, tiers = configurable par contrat. À la reprise, l'échéance est **recalculée** à partir du temps ouvré restant.
4. **Arrêt** : « Pris en compte » (premier passage à Planifié ou En cours) arrête le chrono de prise en compte ; « Résolu » arrête celui de résolution. Une réouverture ouvre une nouvelle instance et marque la précédente.
5. Stockage : `echeance_at`, `ecoule_ouvre_minutes`, `pause_debut_at`, `etat` (en_cours, en_pause, atteint, depasse), `seuils_declenches`.

## Alertes et escalade
- Seuils par défaut : 50 %, 80 %, 100 % du délai (configurables).
- Chaque seuil est une tâche BullMQ planifiée **plus** un balayeur périodique qui rattrape les tâches perdues (base de vérité : table, pas la file).
- Escalade par niveau : N1 gestionnaire FM → N2 responsable de site → N3 administrateur ; destinataires par règle de contrat.
- **Règle de repli** : si le prestataire n'accepte pas dans le délai, ou si le SLA est en risque, réaffectation automatique vers le prestataire de repli défini dans la règle de routage, tracée.

## SLA dérivé du sous-traitant
- Défini par le prestataire principal pour son sous-traitant : `SLA_sous_traitant = SLA_client − marge`, la marge étant une durée fixe ou un pourcentage.
- Calculé sur l'OT enfant avec le calendrier du site. Jamais visible du client ; le sous-traitant ne voit que son propre délai.

## Mesure
- Dépassement = `ecoule_ouvre_minutes > cible` à l'arrêt, ou `now > echeance_at` en cours.
- KPI : respect des SLA (% par priorité, prestataire, site), délai moyen de résolution, taux de première résolution (tickets résolus sans réouverture ni second OT).
- Les **pénalités** sont V2 : au MVP, on **mesure** les dépassements seulement.

## Critères d'acceptation vérifiables (MVP)
1. Un ticket P1 créé un vendredi à 17 h 30 reçoit une échéance correcte selon le calendrier ouvré du site, y compris lors d'un changement d'heure (jeux de tests par fuseau).
2. Une pause puis une reprise décalent l'échéance exactement du temps ouvré de pause.
3. Une alerte à 80 % part une seule fois, même si le worker redémarre.
4. L'OT enfant porte une échéance antérieure à celle du parent.
5. Le client ne peut lire ni l'instance dérivée ni la marge.

## À valider
- Jours fériés : liste applicable par site (France métropolitaine et territoires) à **confirmer** avant usage ; je ne la fige pas de mémoire.

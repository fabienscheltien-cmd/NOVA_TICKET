# Journal des décisions

Format : décision · alternative écartée · raison · statut.

| # | Décision | Alternative écartée | Raison | Statut |
|---|---|---|---|---|
| D1 | Monolithe modulaire NestJS | Microservices | Un seul développeur : coût d'exploitation et de coordination | Validé (stack par défaut) |
| D2 | Isolation par RLS PostgreSQL sur une base partagée | Un schéma ou une base par organisation | Migrations ingérables à 50+ organisations ; RLS testable en CI | Proposé |
| D3 | Visibilité des discussions portée par le **fil** et ses organisations participantes | Drapeau de visibilité sur chaque message | Un seul mécanisme pour notes internes, fil partagé et fil principal ↔ sous-traitant | Proposé |
| D4 | Partage inter-organisations via `acces_objet`, écrit par fonctions `SECURITY DEFINER` | Droits calculés à la volée par jointures sur contrats | Performance de la RLS et révocation simple (fin de contrat) | Proposé |
| D5 | Bailleur et PM sont des `organisation` ; lien PM ↔ bailleur par `mandat_gestion` daté | Table « PM » séparée | Réversibilité : changer de PM sans toucher aux données | Proposé |
| D6 | Occupants = `occupant` + `contact` + `occupation` datée, sans compte | Compte utilisateur occupant | Décision du porteur (15/10/2026) ; supporte plusieurs immeubles, occupants et sites | **Validé** |
| D7 | Prix et marges dans une table séparée (`ot_financier`, `refacturation`) | Masquage de colonnes | La RLS agit par ligne et par table, pas par colonne | Proposé |
| D8 | Hors ligne : SQLite par (utilisateur, organisation), file d'actions idempotentes, transitions rejouées côté serveur | CRDT complet ; solution de synchronisation tierce hébergée | Simplicité, maîtrise de l'hébergement en France | Proposé, prototype à l'incrément 5 |
| D9 | Redis et ClamAV en conteneurs sur les instances applicatives | Services managés | Coût et simplicité ; la file est reconstructible depuis la base | Proposé |
| D10 | SLA : calcul en minutes ouvrées avec bibliothèque de dates ; base = vérité, file = déclencheur | Calcul par cron seul | Reprise après incident sans alerte perdue ni doublon | Proposé |
| D11 | Facturation par site avec paliers | Par actif | Voir [08](phase1/08-cout-hebergement.md) | À trancher par vous |
| D12 | Pas d'EAS Update ni de service de build hors UE pour les données métier | Expo EAS complet | Exigence « aucun service hors UE pour les données métier » ; à confirmer techniquement | À confirmer |
| D13 | Pas d'application mobile occupant | App occupant (cahier initial) | Décision du porteur | **Validé** |
| D14 | Mot de passe : argon2id (paramètres par défaut de la bibliothèque `argon2`), minimum 12 caractères | scrypt natif Node | Algorithme recommandé en premier par l'OWASP ; la longueur minimale est une hypothèse à valider avec les recommandations de la CNIL / ANSSI en vigueur | Proposé |
| D15 | Rôles dans une table `role` ; permissions dans le code (`permissions.ts`), testées | Permissions en base, rôles personnalisables par organisation | Simplicité ; la personnalisation par organisation viendra avec le besoin réel | Proposé |
| D16 | TOTP implémenté en interne (RFC 6238, vecteurs de test officiels), secrets chiffrés AES-256-GCM au repos | Bibliothèque `otplib` | Une trentaine de lignes vérifiables, sans dépendance supplémentaire ; limite connue : un code reste rejouable dans sa fenêtre de 30 s | Proposé |
| D17 | Jetons : accès JWT court (15 min) + jeton de rafraîchissement opaque haché, rotation avec détection de réutilisation (famille révoquée) | JWT longue durée | Le vol d'un jeton de rafraîchissement est détectable et borné | Proposé |
| D18 | Appartenance revérifiée en base à chaque requête d'espace | Confiance dans la revendication du jeton | Une désactivation prend effet immédiatement ; coût : une lecture indexée par requête | Proposé |
| D19 | Réponse d'authentification unique (inconnu, désactivé, verrouillé, mauvais mot de passe) ; verrouillage 15 min après 5 échecs | Messages distincts | Pas d'énumération de comptes | Proposé |
| D20 | Envoi d'e-mail derrière une interface `Mailer`, implémentation simulée tant que le prestataire européen n'est pas choisi | Choisir un prestataire maintenant | Décision du porteur (option par défaut) | **Validé** |

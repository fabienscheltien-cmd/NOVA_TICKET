# Développement local

```bash
cp .env.example .env && set -a && . ./.env && set +a
docker compose up -d
pnpm install
pnpm --filter @nova/api db:bootstrap   # crée les rôles nova_owner et nova_app (une fois)
pnpm db:migrate                        # applique db/migrations/*.sql
pnpm test                              # tests d'isolation, base PostgreSQL réelle
```

## Créer une organisation et son premier administrateur
```bash
pnpm --filter @nova/api exec tsx src/db/cli.ts create-org bailleur "Nom du bailleur" admin@exemple.fr
```
Le jeton d'invitation s'affiche une seule fois (seule son empreinte est stockée). Il s'utilise via `POST /invitations/{jeton}/accept`.
Désactivations d'administration (réservées à la plateforme, sans droit pour l'API) : `SELECT app.user_deactivate('<uuid>')`, `SELECT app.org_deactivate('<uuid>')`.

## Console d'administration (web)

**Accès de démonstration (`pnpm web`, sans variable) :** l'écran de connexion accepte n'importe quel e-mail et mot de passe, même vides, et entre en administrateur sur des données fictives non enregistrées. Il n'y a ni API ni donnée réelle derrière : rien n'est protégé ni exposé. Cette connexion permissive n'existe **jamais** en mode API (`VITE_DATA_SOURCE=api`, ce que fixe `Dockerfile.web` en production) : test de garde-fou dans `apps/web/test/connexion.test.tsx` et `config.test.ts`. L'API, elle, n'a pas de mode permissif.
```bash
pnpm web                       # http://127.0.0.1:5173, données de démonstration (défaut) : connexion permissive, voir ci-dessous
VITE_DATA_SOURCE=api VITE_API_URL=http://localhost:3000 pnpm web   # contre l'API réelle
```
En mode API, la console a son écran de connexion : identifiants, code MFA, activation de la MFA si le rôle l'exige (codes de secours affichés une fois), choix de l'espace de travail, « mot de passe oublié », réinitialisation (`/mot-de-passe/:jeton`) et acceptation d'invitation (`/invitations/:jeton`, les liens des e-mails simulés). Les jetons sont conservés dans le stockage local du navigateur ; le jeton d'accès est rafraîchi automatiquement (une seule rotation à la fois). Voir [annuaire et affectation](../phase2/annuaire-et-affectation.md).

L'API doit autoriser l'origine de la console : `CORS_ORIGINS` (défaut `APP_BASE_URL`). Derrière un répartiteur de charge, régler `TRUST_PROXY` (nombre de proxys de confiance), sinon la limitation de débit par IP voit une seule adresse. `RATE_LIMIT_AUTH_PER_MIN` (défaut 20) règle les tentatives par minute et par IP ; le compteur est en mémoire, propre à chaque instance (Redis le partagera).

Tests : `pnpm test` exécute le paquet partagé (règle d'éligibilité, démonstration), la console (composants, accessibilité) et l'API (base PostgreSQL réelle, variables d'environnement ci-dessus).

## Patrimoine : import CSV, QR, mandats
- Import : `POST /imports/{sites|locaux|occupations}` avec `Content-Type: text/csv`, `?dry_run=true` pour valider sans écrire, `?owner_org_id=` pour qu'un property manager importe pour un bailleur (mandat requis). Séparateur `;` ou `,` détecté d'après l'en-tête, virgule décimale acceptée. Maximum 5 000 lignes. Tout ou rien : en cas d'erreur, rien n'est écrit et le rapport liste chaque ligne en défaut.
- Colonnes `sites` : `reference, nom, adresse, code_postal, ville, pays, latitude, longitude, surface_m2, usage, portefeuille`.
- Colonnes `locaux` : `site_reference, batiment, niveau, reference, nom, type, surface_m2` (bâtiments et niveaux créés au besoin).
- Colonnes `occupations` : `site_reference, local_reference, occupant, type_occupant, debut, fin, contact_nom, contact_email, contact_telephone`.
- QR : `GET /locaux/{id}/qr.png` (image à imprimer) ; `GET /qr/{code}` résout un code scanné, limité au périmètre visible.
- Mandats : le bailleur crée (`POST /mandats`) et clôt (`POST /mandats/{id}/end`). Le property manager reçoit l'identifiant de son organisation hors de la plateforme (hypothèse : pas d'annuaire des organisations).

## Rôles de base de données
- `nova_owner` (NOLOGIN) : propriétaire des objets ; les migrations s'exécutent sous ce rôle. Il est soumis à la RLS (FORCE), sauf pour les politiques `TO nova_owner` réservées aux fonctions `SECURITY DEFINER`.
- `nova_app` : rôle de l'API, sans `BYPASSRLS`, sans propriété de table, droits explicites uniquement.
- L'administrateur de base ne sert qu'au bootstrap, aux migrations et au jeu de données de test.

## Règles à respecter pour toute nouvelle table
1. `ENABLE` et `FORCE ROW LEVEL SECURITY`, au moins une politique, `GRANT` explicite à `nova_app`.
2. Le test de catalogue (`test/catalog.test.ts`) échoue sinon.
3. Toute nouvelle fonction `SECURITY DEFINER` doit être ajoutée à la liste figée du test et relue.

## Limites connues (après l'incrément 1)
- Pas encore de « mot de passe oublié » ni de changement de mot de passe.
- Pas de limitation de débit par adresse IP (seul le verrouillage de compte existe) : à ajouter avant toute exposition publique.
- Un code TOTP reste rejouable pendant sa fenêtre de validité (30 s ± 1 pas).
- L'envoi d'e-mail est simulé (console) ; aucun prestataire choisi.
- Plans de site (PDF / image) : reportés avec les pièces jointes (incrément 4).
- Un prestataire ne voit aucun élément du patrimoine tant que les contrats de service n'existent pas (incrément 3).
- Les dates de mandat s'évaluent à la date du serveur de base de données (UTC), sans fuseau par site.
- Pas de back-office : l'administration plateforme passe par le CLI et les fonctions SQL ci-dessus.
- Les tables sont des socles minimaux ; mandats de gestion, contrats et SLA arrivent aux incréments 2 et 3.
- Infrastructure OVH (Terraform) et déploiement automatisé : non faits, voir la PR.

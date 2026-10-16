# Déploiement OVHcloud — état, procédure et ce qui n'est pas vérifié

**Conclusion : tout est prêt à être essayé, rien n'est déployé.** Il manque votre projet OVHcloud, un nom de domaine, la région et l'offre de base, et plusieurs points ci-dessous n'ont pu être vérifiés ici. Rien n'a été fait chez OVHcloud.

## Ce qui a été vérifié localement
- L'API **compilée** (`node dist/src/main.js`, `NODE_ENV=production`) démarre ; le CLI compilé (`node dist/src/db/cli.js bootstrap | migrate | create-org`) migre une base vierge (7 migrations), crée une organisation et son invitation ; l'invitation est acceptée et la connexion réussit, avec le rôle applicatif sans droit d'administration.
- Un défaut a été corrigé au passage : le CLI compilé cherchait les migrations au mauvais endroit et l'image ne les contenait pas (`MIGRATIONS_DIR`, copie de `db/` dans l'image, test).
- En-têtes de sécurité de l'API (helmet, `no-store`), CORS par origines listées, limitation de débit par IP : tests automatisés.

## Ce qui n'a pas pu l'être (la CI le fera au premier passage)
- **Aucune image Docker n'a été construite** (pas de démon Docker ici). Le job `docker` de `.github/workflows/ci.yml` construit les deux images, exécute les migrations depuis l'image sur une base vierge, démarre l'API conteneurisée et contrôle les en-têtes de la console. S'il échoue, c'est qu'un défaut subsistait : le corriger avant tout déploiement. Point à surveiller : le module natif `argon2` dans l'image (base Debian `node:22-bookworm-slim`, choisie parce que c'est le cas déjà éprouvé en CI).
- `infra/terraform` : **jamais exécuté** (voir son README).
- `deploy/docker-compose.prod.yml`, `Caddyfile` : jamais lancés. Le certificat TLS automatique (Caddy) suppose que les enregistrements DNS pointent vers l'instance et que les ports 80 et 443 sont ouverts.
- Compatibilité avec la **base managée** OVHcloud : à contrôler (ci-dessous).

## Procédure (à dérouler une fois les prérequis réunis)
1. **Prérequis chez OVHcloud** : projet Public Cloud, région en France, identifiants API (clé, secret, clé de consommateur, droits sur `/cloud/project/*/database/*`), nom de domaine et deux noms (`console.…`, `api.…`).
2. **Base** : `infra/terraform` (après relecture), ou création manuelle. Restreindre l'accès réseau à l'instance applicative. Offre : *Essential* (1 nœud, sans haute disponibilité) pour le staging, *Business* pour la production (source : [page PostgreSQL OVHcloud](https://www.ovhcloud.com/fr/public-cloud/postgresql/)). **Prix non relevés sur une source OVHcloud** (voir `docs/phase1/08-cout-hebergement.md`). Des relevés tiers donnent environ 0,086 USD/h pour un nœud *Essential* db1-4 et 0,171 USD/h pour db1-7 ([Spare Cores](https://sparecores.com/database/ovh/postgresql-essential-db1-4)) : indicatif, non officiel.
3. **Rôles et extension** : `node dist/src/db/cli.js bootstrap` crée `nova_owner` (sans connexion) et `nova_app` (connexion, sans `BYPASSRLS`). Il exige un compte de base pouvant créer des rôles. **À vérifier sur la base managée** : droit de créer des rôles, de se donner le rôle `nova_owner`, et autorisation de l'extension `btree_gist` (migration 0003). Sinon, créer les rôles et l'extension par la console OVHcloud, puis lancer seulement `migrate`.
4. **Secrets** : `deploy/env.prod.example` → `deploy/.env.prod` (hors dépôt, droits 600). `JWT_SECRET` et `APP_ENCRYPTION_KEY` générés aléatoirement ; **sauvegarder `APP_ENCRYPTION_KEY` à part** (la perdre rend les secrets MFA illisibles). Connexion à la base avec `sslmode=require` ; **vérifier la validation du certificat** (autorité de certification de la base).
5. **Images** : les construire en CI et les pousser dans un registre de votre choix (non choisi : à décider ; privilégier un registre hébergé en France).
6. **Migrations** (jamais au démarrage de l'API) : `docker run --rm -e DATABASE_URL_ADMIN=… IMAGE_API node dist/src/db/cli.js migrate`, avant de démarrer la nouvelle version. Elles sont transactionnelles et rejouables.
7. **Premier compte** : `node dist/src/db/cli.js create-org property_manager "Nom" admin@exemple.fr` affiche le jeton d'invitation **une seule fois** ; l'administrateur crée son compte via `https://console.…/invitations/JETON`. Il devra activer la MFA (obligatoire pour son rôle).
8. **Démarrage** : `docker compose --env-file deploy/.env.prod -f deploy/docker-compose.prod.yml up -d`. Contrôler `https://api.…/health`.

## Points de sécurité à traiter avant d'ouvrir à de vrais clients
| Point | État |
|---|---|
| E-mails (invitations, mot de passe oublié) | **Simulés** (journal de l'API) : sans prestataire d'envoi, personne ne reçoit ses liens. Choisir un prestataire européen (D20) avant toute ouverture |
| Limitation de débit | En mémoire, par instance ; `TRUST_PROXY=1` derrière Caddy. Un seul exemplaire de l'API tant qu'il n'y a pas Redis |
| Jeton d'accès dans le stockage local de la console | Exposé à un XSS : CSP stricte fournie (`deploy/nginx.conf.template`), mais jamais éprouvée dans un navigateur sur l'image réelle |
| Sauvegardes et restauration | **Non testées.** Contrôler ce que l'offre retenue sauvegarde (RPO/RTO du document 08 non validés) et réaliser un exercice de restauration chronométré |
| Chiffrement des sauvegardes hors site avec une clé qui vous appartient | Non fait (document 01) |
| Journal d'audit, supervision, alertes | Non faits |
| Politique de mots de passe (12 caractères) | À valider avec les recommandations CNIL / ANSSI en vigueur |
| RGPD (registre, sous-traitants, durées de conservation, occupants) | **À faire valider par un juriste** |

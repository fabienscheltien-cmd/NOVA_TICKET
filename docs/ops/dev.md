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
- Pas de back-office : l'administration plateforme passe par le CLI et les fonctions SQL ci-dessus.
- Les tables sont des socles minimaux ; mandats de gestion, contrats et SLA arrivent aux incréments 2 et 3.
- Infrastructure OVH (Terraform) et déploiement automatisé : non faits, voir la PR.

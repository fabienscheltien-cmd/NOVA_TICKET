# Développement local

```bash
cp .env.example .env && set -a && . ./.env && set +a
docker compose up -d
pnpm install
pnpm --filter @nova/api db:bootstrap   # crée les rôles nova_owner et nova_app (une fois)
pnpm db:migrate                        # applique db/migrations/*.sql
pnpm test                              # tests d'isolation, base PostgreSQL réelle
```

## Rôles de base de données
- `nova_owner` (NOLOGIN) : propriétaire des objets ; les migrations s'exécutent sous ce rôle. Il est soumis à la RLS (FORCE), sauf pour les politiques `TO nova_owner` réservées aux fonctions `SECURITY DEFINER`.
- `nova_app` : rôle de l'API, sans `BYPASSRLS`, sans propriété de table, droits explicites uniquement.
- L'administrateur de base ne sert qu'au bootstrap, aux migrations et au jeu de données de test.

## Règles à respecter pour toute nouvelle table
1. `ENABLE` et `FORCE ROW LEVEL SECURITY`, au moins une politique, `GRANT` explicite à `nova_app`.
2. Le test de catalogue (`test/catalog.test.ts`) échoue sinon.
3. Toute nouvelle fonction `SECURITY DEFINER` doit être ajoutée à la liste figée du test et relue.

## Limites connues de l'incrément 0
- Le contexte (`userId`, `orgId`) est reçu tel quel par `TenantDb` : la vérification de l'appartenance à l'organisation arrive à l'incrément 1 (fonction dédiée d'authentification).
- Les tables sont des socles minimaux ; mandats de gestion, contrats et SLA arrivent aux incréments 2 et 3.
- Infrastructure OVH (Terraform) et déploiement automatisé : non faits, voir la PR.

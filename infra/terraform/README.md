# Infrastructure OVHcloud (Terraform) — squelette non validé

**Statut : non exécuté.** Aucun `terraform init`, `validate` ni `plan` n'a pu être lancé (Terraform absent de l'environnement de développement, registre injoignable). Ce dossier fixe l'organisation et les variables ; **relisez chaque ressource avec la documentation du fournisseur `ovh/ovh` avant usage.**

Ce qui est établi (source : guide OVHcloud « Public Cloud Databases — Terraform » et article d'aide, trouvés par recherche le 16/10/2026) : fournisseur `ovh/ovh`, point d'accès `ovh-eu`, trois identifiants API (clé, secret, clé de consommateur) avec droits sur `/cloud/project/*/database/*`, `service_name` = identifiant du projet, paramètres minimaux d'un cluster PostgreSQL (moteur, version, région, offre, taille).

Ce qui reste à faire par vous : créer le projet Public Cloud et les identifiants API, choisir la région (France) et l'offre, puis `terraform init && terraform plan`. Voir [docs/ops/deploiement.md](../../docs/ops/deploiement.md).

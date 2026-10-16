provider "ovh" {
  endpoint           = var.ovh_endpoint
  application_key    = var.ovh_application_key
  application_secret = var.ovh_application_secret
  consumer_key       = var.ovh_consumer_key
}

# Base PostgreSQL managée (Public Cloud Databases).
# ATTENTION — NON VALIDÉ : `terraform` n'est pas installé dans l'environnement de développement et le registre n'était pas
# joignable ; les paramètres minimaux (moteur, version, région, offre, taille) viennent d'un article d'aide OVHcloud trouvé par
# recherche. La STRUCTURE EXACTE de la ressource (bloc `nodes`, noms d'arguments) est à vérifier contre la documentation
# du fournisseur ovh/ovh avant le premier `terraform plan`.
resource "ovh_cloud_project_database" "postgres" {
  service_name = var.service_name
  description  = "nova-${var.environment}"
  engine       = "postgresql"
  version      = var.postgres_version
  plan         = var.postgres_plan
  flavor       = var.postgres_flavor

  nodes {
    region = var.region
  }
}

# À ajouter après vérification dans la documentation du fournisseur (non écrit ici pour ne pas inventer de noms d'arguments) :
#   - la base « nova » et un utilisateur d'administration dédié aux migrations ;
#   - la restriction d'accès par adresse IP (n'autoriser que l'instance applicative) ;
#   - le bucket Object Storage (pièces jointes, incrément 4) et son bucket de sauvegarde ;
#   - l'instance applicative (Docker) et son réseau privé.

variable "ovh_endpoint" {
  description = "Point d'accès de l'API OVHcloud : ovh-eu pour l'Europe (source : guide OVHcloud « Public Cloud Databases — Terraform »)."
  type        = string
  default     = "ovh-eu"
}

# Identifiants API : créés dans le générateur de jeton OVHcloud avec les droits GET/POST/PUT/DELETE sur /cloud/project/*/database/*.
# À fournir par variables d'environnement (TF_VAR_...) ou OVH_APPLICATION_KEY / OVH_APPLICATION_SECRET / OVH_CONSUMER_KEY ; jamais dans le dépôt.
variable "ovh_application_key" {
  type      = string
  sensitive = true
}
variable "ovh_application_secret" {
  type      = string
  sensitive = true
}
variable "ovh_consumer_key" {
  type      = string
  sensitive = true
}

variable "service_name" {
  description = "Identifiant du projet Public Cloud (copié depuis la console OVHcloud)."
  type        = string
}

variable "environment" {
  description = "staging ou production."
  type        = string
  validation {
    condition     = contains(["staging", "production"], var.environment)
    error_message = "environment doit valoir staging ou production."
  }
}

variable "region" {
  description = "Région OVHcloud en France (ex. GRA ou SBG : à confirmer pour l'offre PostgreSQL choisie)."
  type        = string
}

variable "postgres_version" {
  description = "Version majeure de PostgreSQL. Le projet est testé avec la 16."
  type        = string
  default     = "16"
}

variable "postgres_plan" {
  description = "Offre : essential (1 nœud, sans haute disponibilité) pour staging ; business (multi-nœuds) pour la production."
  type        = string
  default     = "essential"
}

variable "postgres_flavor" {
  description = "Taille des nœuds (ex. db1-4, db1-7). Prix non relevés sur une source OVHcloud : voir docs/phase1/08-cout-hebergement.md."
  type        = string
  default     = "db1-4"
}

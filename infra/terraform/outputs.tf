output "database_id" {
  description = "Identifiant du cluster PostgreSQL managé."
  value       = ovh_cloud_project_database.postgres.id
}

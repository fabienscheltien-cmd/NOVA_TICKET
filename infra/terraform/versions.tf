terraform {
  required_version = ">= 1.5"
  required_providers {
    ovh = {
      source = "ovh/ovh"
      # À figer sur la version testée lors du premier `terraform init` (fichier .terraform.lock.hcl à committer).
    }
  }
}

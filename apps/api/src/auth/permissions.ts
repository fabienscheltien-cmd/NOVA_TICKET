/**
 * Matrice rôles / permissions (docs/phase1/04-roles-permissions.md).
 * 'yes' = accordée ; 'cond' = accordée sous condition vérifiée par le module concerné
 * (périmètre, affectation, statut) ; absente = refusée.
 */
export type Grant = 'yes' | 'cond';
export type Role =
  | 'admin_org' | 'gestionnaire_fm' | 'accueil' | 'responsable_site' | 'asset_manager'
  | 'technicien' | 'prestataire_externe' | 'support' | 'super_admin';

const A = 'yes' as const;
const C = 'cond' as const;

export const PERMISSIONS: Record<string, Partial<Record<Role, Grant>>> = {
  'ticket.create': { admin_org: A, gestionnaire_fm: A, accueil: A, responsable_site: A, technicien: C },
  'ticket.read': { admin_org: A, gestionnaire_fm: A, accueil: A, responsable_site: A, asset_manager: A, technicien: C, prestataire_externe: C },
  'ticket.qualify': { admin_org: A, gestionnaire_fm: A, responsable_site: A },
  'ticket.assign': { admin_org: A, gestionnaire_fm: A, responsable_site: C },
  'ticket.transition': { admin_org: A, gestionnaire_fm: A, responsable_site: A, technicien: C, prestataire_externe: C },
  'ticket.close': { admin_org: A, gestionnaire_fm: A, responsable_site: A },
  'ticket.merge_link': { admin_org: A, gestionnaire_fm: A, accueil: A },
  'ticket.comment_shared': { admin_org: A, gestionnaire_fm: A, accueil: A, responsable_site: A, technicien: A, prestataire_externe: A },
  'ticket.comment_internal': { admin_org: A, gestionnaire_fm: A, accueil: A, responsable_site: A, technicien: A },
  'ticket.satisfaction_record': { admin_org: A, gestionnaire_fm: A, accueil: A, responsable_site: A },
  'ot.create': { admin_org: A, gestionnaire_fm: A },
  'ot.accept': { admin_org: A, gestionnaire_fm: A },
  'ot.execute': { technicien: A, prestataire_externe: A },
  'ot.validate': { admin_org: A, gestionnaire_fm: A, responsable_site: A },
  'ot.subcontract': { admin_org: A, gestionnaire_fm: A },
  'patrimoine.read': { admin_org: A, gestionnaire_fm: A, accueil: A, responsable_site: A, asset_manager: A, technicien: C, prestataire_externe: C },
  'patrimoine.write': { admin_org: A, gestionnaire_fm: A, responsable_site: C },
  'actif.write': { admin_org: A, gestionnaire_fm: A, responsable_site: C },
  'contrat.read': { admin_org: A, gestionnaire_fm: A, asset_manager: A },
  'contrat.write': { admin_org: A, gestionnaire_fm: A },
  'user.invite': { admin_org: A },
  'user.manage': { admin_org: A },
  'sla.configure': { admin_org: A, gestionnaire_fm: A },
  'annuaire.read': { admin_org: A, gestionnaire_fm: A, accueil: A, responsable_site: A, asset_manager: A },
  'config.manage': { admin_org: A, gestionnaire_fm: A },
  'report.read': { admin_org: A, gestionnaire_fm: A, accueil: C, responsable_site: A, asset_manager: A },
  'export.run': { admin_org: A, gestionnaire_fm: A, asset_manager: A },
  'audit.read': { admin_org: A, support: C },
  'support.access': { support: C },
};

/**
 * Le bailleur a une VISION (décision du porteur, 16/10/2026) : il ne crée, ne qualifie, n'affecte ni ne
 * configure rien dans le dispatch, quel que soit son rôle. Le PM qu'il mandate agit.
 */
const BAILLEUR_LECTURE_SEULE = new Set([
  'ticket.create', 'ticket.qualify', 'ticket.assign', 'ticket.transition', 'ticket.close', 'ticket.merge_link',
  'ticket.comment_shared', 'ticket.comment_internal', 'ticket.satisfaction_record',
  'ot.create', 'ot.accept', 'ot.execute', 'ot.validate', 'ot.subcontract', 'config.manage', 'sla.configure',
]);

export function grantFor(role: string, permission: string, orgType?: string): Grant | null {
  if (orgType === 'bailleur' && BAILLEUR_LECTURE_SEULE.has(permission)) return null;
  return PERMISSIONS[permission]?.[role as Role] ?? null;
}

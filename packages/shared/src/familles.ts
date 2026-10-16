/** Familles de tickets proposées par défaut (niveau « plateforme » de la configuration, modifiables par organisation). */
export const FAMILLES_STANDARD: ReadonlyArray<{ code: string; libelle: string }> = [
  { code: 'plomberie', libelle: 'Plomberie' },
  { code: 'electricite', libelle: 'Électricité' },
  { code: 'cvc', libelle: 'CVC (chauffage, ventilation, climatisation)' },
  { code: 'serrurerie', libelle: 'Serrurerie' },
  { code: 'ascenseurs', libelle: 'Ascenseurs' },
  { code: 'securite_incendie', libelle: 'Sécurité incendie' },
  { code: 'controle_acces', libelle: 'Contrôle d\'accès' },
  { code: 'menuiserie_vitrerie', libelle: 'Menuiserie et vitrerie' },
  { code: 'peinture_revetements', libelle: 'Peinture et revêtements' },
  { code: 'toiture_etancheite', libelle: 'Toiture et étanchéité' },
  { code: 'nettoyage', libelle: 'Nettoyage' },
  { code: 'espaces_verts', libelle: 'Espaces verts' },
];

/** Identifiant stable dérivé d'un libellé : « Contrôle d'accès » → « controle_d_acces ». */
export function codeDepuisLibelle(libelle: string): string {
  return libelle
    .normalize('NFD').replace(/[̀-ͯ]/g, '')
    .toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '')
    .slice(0, 60);
}

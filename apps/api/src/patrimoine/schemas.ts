import { z } from 'zod';

const uuid = z.string().uuid();
const text = (max = 200) => z.string().trim().min(1).max(max);
const optText = (max = 200) => z.string().trim().max(max).optional();
const date = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'format AAAA-MM-JJ');
const surface = z.coerce.number().min(0).max(10_000_000);

export const LOCAL_TYPES = ['bureau', 'logement', 'commerce', 'local_technique', 'partie_commune', 'parking', 'stockage', 'autre'] as const;

export const siteSchema = z.object({
  nom: text(), reference: optText(60), adresse: optText(300), code_postal: optText(20), ville: optText(120),
  pays: z.string().trim().length(2).toUpperCase().optional(),
  latitude: z.coerce.number().min(-90).max(90).optional(), longitude: z.coerce.number().min(-180).max(180).optional(),
  fuseau: optText(60), usage: optText(60), surface_m2: surface.optional(),
  portefeuille_id: uuid.nullable().optional(),
});
export const siteCreateSchema = siteSchema.extend({ owner_org_id: uuid.optional() });
export const sitePatchSchema = siteSchema.partial();

export const portefeuilleSchema = z.object({ nom: text(), owner_org_id: uuid.optional() });
export const batimentSchema = z.object({ site_id: uuid, nom: text(), reference: optText(60), surface_m2: surface.optional() });
export const niveauSchema = z.object({ batiment_id: uuid, nom: text(), ordre: z.coerce.number().int().min(-50).max(500).optional() });
export const localSchema = z.object({
  niveau_id: uuid, nom: text(), reference: optText(60), type: z.enum(LOCAL_TYPES).optional(), surface_m2: surface.optional(),
});
export const localPatchSchema = localSchema.omit({ niveau_id: true }).partial();
export const occupantSchema = z.object({ nom: text(), type: z.enum(['societe', 'particulier']).optional(), owner_org_id: uuid.optional() });
export const contactSchema = z.object({
  occupant_id: uuid, nom: text(), email: z.string().email().max(254).optional(), telephone: optText(40), fonction: optText(120),
});
export const occupationSchema = z.object({
  local_id: uuid, occupant_id: uuid, debut: date.optional(), fin: date.nullable().optional(),
  type: z.enum(['locataire', 'proprietaire', 'autre']).optional(), surface_m2: surface.optional(),
});
export const occupationEndSchema = z.object({ fin: date });
export const mandatSchema = z.object({
  pm_org_id: uuid, portefeuille_id: uuid.optional(), site_id: uuid.optional(), debut: date.optional(), fin: date.optional(),
}).refine((m) => !(m.portefeuille_id && m.site_id), 'portefeuille_id et site_id sont exclusifs');
export const mandatEndSchema = z.object({ fin: date });

export const pageSchema = z.object({
  limit: z.coerce.number().int().min(1).max(500).default(100),
  offset: z.coerce.number().int().min(0).default(0),
});

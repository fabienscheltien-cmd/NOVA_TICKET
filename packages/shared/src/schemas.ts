import { z } from 'zod';

const uuid = z.string().uuid();
const text = (max = 200) => z.string().trim().min(1, 'obligatoire').max(max);
const optText = (max = 200) => z.string().trim().max(max).nullish().transform((v) => (v ? v : null));
const date = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'format AAAA-MM-JJ').refine((d) => !Number.isNaN(Date.parse(d)), 'date invalide');

export const referencementSchema = z.object({ famille_id: uuid, priorite: z.coerce.number().int().min(1).max(99) });

export const familleCreateSchema = z.object({ libelle: text(120) });
export const famillePatchSchema = z.object({
  libelle: text(120).optional(), actif: z.boolean().optional(), ordre: z.coerce.number().int().min(0).max(999).optional(),
}).refine((p) => Object.keys(p).length > 0, 'aucun champ à modifier');

export const prestataireInputSchema = z.object({
  nom: text(160),
  contact_nom: optText(120),
  contact_email: z.string().trim().email('adresse invalide').max(254).nullish().transform((v) => (v ? v : null)),
  contact_telephone: optText(40),
  zone: optText(120),
  statut: z.enum(['actif', 'suspendu']).default('actif'),
  assurance_expire_le: date.nullish().transform((v) => v ?? null),
  notes: optText(1000),
  familles: z.array(referencementSchema).max(50).default([]).refine(
    (l) => new Set(l.map((f) => f.famille_id)).size === l.length, 'une famille ne peut être référencée qu\'une fois'),
});
export const prestatairePatchSchema = prestataireInputSchema.partial();

export const ticketCreateSchema = z.object({
  titre: text(200),
  description: optText(4000),
  famille_id: uuid,
  site_id: uuid,
  local_id: uuid.nullish().transform((v) => v ?? null),
  priorite: z.enum(['p1', 'p2', 'p3', 'p4']).default('p3'),
});

export const affectationInputSchema = z.object({ annuaire_id: uuid, motif: optText(500) });
export const statutPrestataireSchema = z.object({ statut: z.enum(['actif', 'suspendu']) });

export type FamilleCreate = z.input<typeof familleCreateSchema>;
export type FamillePatch = z.input<typeof famillePatchSchema>;
export type PrestataireInput = z.input<typeof prestataireInputSchema>;
export type PrestatairePatch = z.input<typeof prestatairePatchSchema>;
export type TicketCreate = z.input<typeof ticketCreateSchema>;
export type AffectationInput = z.input<typeof affectationInputSchema>;

import { z } from 'zod';
import { CalendrierInvalide, validerCalendrier } from './sla.js';

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

const heure = z.string().regex(/^\d{2}:\d{2}$/, 'format HH:MM');
export const plageSchema = z.object({
  jours: z.array(z.coerce.number().int().min(1).max(7)).min(1).max(7).refine((j) => new Set(j).size === j.length, 'jour répété'),
  debut: heure, fin: heure,
});
export const fermetureSchema = z.object({ du: date, au: date, libelle: optText(120) });
export const calendrierInputSchema = z.object({
  nom: text(120),
  fuseau: z.string().trim().min(1).max(64).default('Europe/Paris'),
  plages: z.array(plageSchema).min(1).max(50),
  fermetures: z.array(fermetureSchema).max(500).default([]),
}).superRefine((c, ctx) => {
  try { validerCalendrier({ fuseau: c.fuseau, plages: c.plages, fermetures: c.fermetures }); }
  catch (e) { if (e instanceof CalendrierInvalide) ctx.addIssue({ code: 'custom', message: e.message }); else throw e; }
});

const priorite = z.enum(['p1', 'p2', 'p3', 'p4']);
const minutes = z.coerce.number().int().min(1).max(525_600);
export const regleSlaSchema = z.object({
  priorite, delai_prise_en_compte_min: minutes, delai_resolution_min: minutes, calendrier_id: uuid.nullish().transform((v) => v ?? null),
}).refine((r) => r.delai_resolution_min >= r.delai_prise_en_compte_min, { message: 'le délai de résolution ne peut pas être inférieur à la prise en compte' });
export const perimetreSchema = z.object({ site_id: uuid, famille_id: uuid.nullish().transform((v) => v ?? null) });
const perimetreListe = z.array(perimetreSchema).min(1, 'au moins un site').max(500).refine(
  (l) => new Set(l.map((p) => `${p.site_id}|${p.famille_id}`)).size === l.length, 'périmètre en double');
const reglesListe = z.array(regleSlaSchema).max(4).refine((l) => new Set(l.map((r) => r.priorite)).size === l.length, 'une règle par priorité');
export const contratInputSchema = z.object({
  annuaire_id: uuid,
  libelle: text(160),
  date_debut: date,
  date_fin: date.nullish().transform((v) => v ?? null),
  statut: z.enum(['actif', 'suspendu']).default('actif'),
  calendrier_id: uuid.nullish().transform((v) => v ?? null),
  notes: optText(1000),
  perimetre: perimetreListe,
  regles: reglesListe.default([]),
}).refine((c) => c.date_fin === null || c.date_fin >= c.date_debut, { message: 'date_fin : antérieure à la date de début', path: ['date_fin'] });
export const contratPatchSchema = z.object({
  libelle: text(160).optional(), date_debut: date.optional(), date_fin: date.nullable().optional(), statut: z.enum(['actif', 'suspendu']).optional(),
  calendrier_id: uuid.nullable().optional(), notes: optText(1000).optional(),
  perimetre: perimetreListe.optional(), regles: reglesListe.optional(),
}).refine((p) => Object.keys(p).length > 0, 'aucun champ à modifier');
export const parametresSchema = z.object({ exiger_contrat: z.boolean() });

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
export type CalendrierInput = z.input<typeof calendrierInputSchema>;
export type ContratInput = z.input<typeof contratInputSchema>;
export type ContratPatch = z.input<typeof contratPatchSchema>;
export type ParametresInput = z.input<typeof parametresSchema>;
export type TicketCreate = z.input<typeof ticketCreateSchema>;
export type AffectationInput = z.input<typeof affectationInputSchema>;

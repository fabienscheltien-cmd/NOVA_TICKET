import pg from 'pg';
import { loadAuthConfig } from '../src/auth/config.js';
import { hashPassword } from '../src/auth/crypto.js';
import { encryptSecret } from '../src/auth/crypto.js';
import { TenantDb } from '../src/db/tenant-db.js';

// SECRETS DE TEST FACTICES : jamais utilisés hors tests.
process.env.JWT_SECRET ??= 'test-only-jwt-secret-0123456789abcdef0123456789';
process.env.APP_ENCRYPTION_KEY ??= Buffer.alloc(32, 7).toString('base64');
process.env.DATABASE_URL_APP ??= 'postgres://nova_app:nova_app_dev@localhost:5432/nova';
export const authConfig = () => loadAuthConfig();

export const TEST_PASSWORD = 'correct horse battery staple';

/** Crée un utilisateur avec identifiants (connexion administrateur). MFA optionnelle avec secret connu. */
export async function createUser(
  admin: pg.Client,
  input: { email: string; memberships: Array<[orgId: string, role: string]>; mfaSecret?: string; id?: string },
): Promise<string> {
  const u = await admin.query<{ id: string }>(
    'INSERT INTO utilisateur (id, email, nom) VALUES (COALESCE($1, gen_random_uuid()), $2, $2) RETURNING id', [input.id ?? null, input.email]);
  const id = u.rows[0]!.id;
  await admin.query(
    'INSERT INTO credential (utilisateur_id, password_hash, mfa_secret_enc, mfa_enabled) VALUES ($1, $2, $3, $4)',
    [id, await hashPassword(TEST_PASSWORD), input.mfaSecret ? encryptSecret(input.mfaSecret, authConfig().encKey) : null, Boolean(input.mfaSecret)]);
  for (const [org, role] of input.memberships) {
    await admin.query('INSERT INTO appartenance (utilisateur_id, org_id, role) VALUES ($1, $2, $3)', [id, org, role]);
  }
  return id;
}

export const ADMIN_URL = process.env.DATABASE_URL_ADMIN ?? 'postgres://postgres:postgres@localhost:5432/nova';
export const APP_URL = process.env.DATABASE_URL_APP ?? 'postgres://nova_app:nova_app_dev@localhost:5432/nova';

// Identifiants fixes : DONNÉES DE TEST FACTICES, jamais utilisées hors tests.
const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
export const ID = {
  B1: id(1), B2: id(2), PM1: id(3), PM2: id(4), P1: id(5), P2: id(6), P3: id(7), S1: id(8), ED: id(9), PM3: id(10),
  uPM1: id(11), uP1: id(12), uP2: id(13), uMulti: id(14), uB1: id(15), uB2: id(16),
  siteB1a: id(21), siteB1b: id(22), siteB2: id(23),
  t1: id(31), t2: id(32), t3: id(33), t4: id(34),
} as const;

export const adminClient = async () => {
  const c = new pg.Client({ connectionString: ADMIN_URL });
  await c.connect();
  return c;
};

export const appPool = () => new pg.Pool({ connectionString: APP_URL, max: 1 });
export const tenantDb = (pool: pg.Pool) => new TenantDb(pool);

// Tables lisibles par nova_app : sans espace de travail, elles doivent toutes renvoyer 0 ligne.
export const DATA_TABLES = [
  'sla_instance', 'sla_regle', 'contrat_perimetre', 'contrat_service', 'calendrier_fermeture', 'calendrier_ouvre', 'message', 'fil_participant', 'fil', 'acces_objet', 'affectation_ticket', 'ticket', 'prestataire_famille', 'prestataire_annuaire', 'famille_ticket', 'occupation', 'contact', 'occupant', 'local', 'niveau', 'batiment',
  'site', 'mandat_gestion', 'portefeuille', 'appartenance', 'utilisateur', 'organisation', 'invitation',
] as const;
// Tables d'authentification : aucun droit pour nova_app.
export const AUTH_TABLES = ['credential', 'code_secours', 'session_refresh', 'password_reset'] as const;

/** Vide et reconstruit le jeu de données de test (connexion administrateur, hors RLS). */
export async function seed(admin: pg.Client): Promise<void> {
  await admin.query(`TRUNCATE ${[...DATA_TABLES, ...AUTH_TABLES].join(', ')} CASCADE`);
  const orgs: Array<[string, string, string]> = [
    [ID.B1, 'bailleur', 'Bailleur 1'], [ID.B2, 'bailleur', 'Bailleur 2'],
    [ID.PM1, 'property_manager', 'PM 1 (mandats B1 et B2)'], [ID.PM2, 'property_manager', 'PM 2'],
    [ID.P1, 'prestataire', 'Prestataire 1'], [ID.P2, 'prestataire', 'Prestataire 2 (concurrent de P1)'],
    [ID.P3, 'prestataire', 'Prestataire 3'], [ID.S1, 'prestataire', 'Sous-traitant de P1'],
    [ID.ED, 'editeur', 'Éditeur'], [ID.PM3, 'property_manager', 'PM 3'],
  ];
  for (const [i, t, n] of orgs) await admin.query('INSERT INTO organisation (id, type, nom) VALUES ($1,$2,$3)', [i, t, n]);
  // Mandats : PM1 gère tout le patrimoine de B1, PM2 celui de B2 ; PM3 n'a aucun mandat au départ.
  await admin.query('INSERT INTO mandat_gestion (bailleur_org_id, pm_org_id) VALUES ($1, $2), ($3, $4)', [ID.B1, ID.PM1, ID.B2, ID.PM2]);
  const users: Array<[string, string]> = [
    [ID.uPM1, 'pm1@test.invalid'], [ID.uP1, 'p1@test.invalid'], [ID.uP2, 'p2@test.invalid'],
    [ID.uMulti, 'multi@test.invalid'], [ID.uB1, 'b1@test.invalid'], [ID.uB2, 'b2@test.invalid'],
  ];
  for (const [i, e] of users) await admin.query('INSERT INTO utilisateur (id, email) VALUES ($1,$2)', [i, e]);
  const members: Array<[string, string, string]> = [
    [ID.uPM1, ID.PM1, 'gestionnaire_fm'], [ID.uP1, ID.P1, 'technicien'], [ID.uP2, ID.P2, 'technicien'],
    [ID.uMulti, ID.P1, 'technicien'], [ID.uMulti, ID.P2, 'technicien'], [ID.uB1, ID.B1, 'asset_manager'],
    [ID.uB2, ID.B2, 'asset_manager'],
  ];
  for (const [u, o, r] of members)
    await admin.query('INSERT INTO appartenance (utilisateur_id, org_id, role) VALUES ($1,$2,$3)', [u, o, r]);
  const sites: Array<[string, string, string]> = [
    [ID.siteB1a, ID.B1, 'Site B1 A'], [ID.siteB1b, ID.B1, 'Site B1 B'], [ID.siteB2, ID.B2, 'Site B2'],
  ];
  for (const [i, o, n] of sites) await admin.query('INSERT INTO site (id, org_id, nom) VALUES ($1,$2,$3)', [i, o, n]);
  const tickets: Array<[string, string, string, string, string]> = [
    [ID.t1, ID.B1, ID.PM1, ID.siteB1a, 'T1 B1/PM1 site A'],
    [ID.t2, ID.B1, ID.PM1, ID.siteB1a, 'T2 B1/PM1 site A (non partagé)'],
    [ID.t3, ID.B2, ID.PM2, ID.siteB2, 'T3 B2/PM2'],
    [ID.t4, ID.B1, ID.PM1, ID.siteB1b, 'T4 B1/PM1 site B'],
  ];
  for (const [i, o, m, s, t] of tickets)
    await admin.query('INSERT INTO ticket (id, owner_org_id, managing_org_id, site_id, titre) VALUES ($1,$2,$3,$4,$5)', [i, o, m, s, t]);
}

export interface CatalogViolation { table: string; problem: string }

/** Contrôle de catalogue : toute table du schéma doit avoir RLS activée, forcée et une politique. */
export async function checkCatalog(client: pg.Client | pg.PoolClient, schema = 'public', allow: string[] = ['schema_migrations']): Promise<CatalogViolation[]> {
  const { rows } = await client.query<{ relname: string; relrowsecurity: boolean; relforcerowsecurity: boolean; policies: string }>(
    `SELECT c.relname, c.relrowsecurity, c.relforcerowsecurity,
            (SELECT count(*) FROM pg_policy p WHERE p.polrelid = c.oid)::text AS policies
       FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE n.nspname = $1 AND c.relkind IN ('r', 'p') ORDER BY c.relname`, [schema]);
  const out: CatalogViolation[] = [];
  for (const r of rows) {
    if (allow.includes(r.relname)) continue;
    if (!r.relrowsecurity) out.push({ table: r.relname, problem: 'RLS non activée' });
    if (!r.relforcerowsecurity) out.push({ table: r.relname, problem: 'RLS non forcée' });
    if (Number(r.policies) === 0) out.push({ table: r.relname, problem: 'aucune politique' });
  }
  return out;
}

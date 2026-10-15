import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import pg from 'pg';
import { createOrgWithAdminInvitation } from './create-org.js';

const MIGRATIONS_DIR = path.resolve(import.meta.dirname, '../../../../db/migrations');

function adminUrl(): string {
  const url = process.env.DATABASE_URL_ADMIN;
  if (!url) throw new Error('DATABASE_URL_ADMIN est requis');
  return url;
}

/** Crée les rôles (une seule fois, par un administrateur de base). Idempotent. */
export async function bootstrap(client: pg.Client, appPassword: string): Promise<void> {
  const { rows } = await client.query<{ db: string; me: string }>(
    'SELECT current_database() AS db, current_user AS me',
  );
  const { db, me } = rows[0]!;
  await client.query(`DO $$ BEGIN
    IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'nova_owner') THEN
      CREATE ROLE nova_owner NOLOGIN NOSUPERUSER NOBYPASSRLS;
    END IF; END $$`);
  const exists = await client.query("SELECT 1 FROM pg_roles WHERE rolname = 'nova_app'");
  const pwd = client.escapeLiteral(appPassword);
  await client.query(
    exists.rowCount
      ? `ALTER ROLE nova_app LOGIN NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE PASSWORD ${pwd}`
      : `CREATE ROLE nova_app LOGIN NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE PASSWORD ${pwd}`,
  );
  await client.query(`GRANT nova_owner TO ${client.escapeIdentifier(me)}`);
  await client.query(`GRANT CREATE ON DATABASE ${client.escapeIdentifier(db)} TO nova_owner`);
  await client.query('GRANT USAGE, CREATE ON SCHEMA public TO nova_owner');
}

/** Applique les migrations SQL versionnées, chacune dans une transaction, sous le rôle nova_owner. */
export async function migrate(client: pg.Client): Promise<string[]> {
  await client.query(`CREATE TABLE IF NOT EXISTS schema_migrations (
    name text PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now())`);
  const done = new Set((await client.query<{ name: string }>('SELECT name FROM schema_migrations')).rows.map((r) => r.name));
  const files = (await readdir(MIGRATIONS_DIR)).filter((f) => f.endsWith('.sql')).sort();
  const applied: string[] = [];
  for (const file of files) {
    if (done.has(file)) continue;
    const sql = await readFile(path.join(MIGRATIONS_DIR, file), 'utf8');
    await client.query('BEGIN');
    try {
      await client.query('SET LOCAL ROLE nova_owner');
      await client.query(sql);
      await client.query('RESET ROLE');
      await client.query('INSERT INTO schema_migrations (name) VALUES ($1)', [file]);
      await client.query('COMMIT');
      applied.push(file);
    } catch (err) {
      await client.query('ROLLBACK');
      throw new Error(`Migration ${file} en échec : ${(err as Error).message}`);
    }
  }
  return applied;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const command = process.argv[2];
  const client = new pg.Client({ connectionString: adminUrl() });
  await client.connect();
  try {
    if (command === 'bootstrap') {
      const pwd = process.env.NOVA_APP_PASSWORD;
      if (!pwd) throw new Error('NOVA_APP_PASSWORD est requis');
      await bootstrap(client, pwd);
      console.log('rôles nova_owner et nova_app prêts');
    } else if (command === 'migrate') {
      const applied = await migrate(client);
      console.log(applied.length ? `appliquées : ${applied.join(', ')}` : 'rien à appliquer');
    } else if (command === 'create-org') {
      const [type, nom, adminEmail] = process.argv.slice(3);
      if (!type || !nom || !adminEmail || !['bailleur', 'property_manager', 'prestataire'].includes(type)) {
        throw new Error('usage : cli.ts create-org <bailleur|property_manager|prestataire> <nom> <email-admin>');
      }
      const r = await createOrgWithAdminInvitation(client, { type: type as 'bailleur', nom, adminEmail });
      console.log(`organisation ${r.orgId} créée ; jeton d'invitation (affiché une seule fois) : ${r.token}`);
    } else {
      throw new Error('usage : cli.ts bootstrap | migrate | create-org');
    }
  } finally {
    await client.end();
  }
}

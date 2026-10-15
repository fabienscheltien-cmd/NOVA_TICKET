import type pg from 'pg';
import { randomToken, sha256Hex } from '../auth/crypto.js';

/**
 * Création d'une organisation et de l'invitation de son premier administrateur.
 * Opération de plateforme (connexion administrateur, hors RLS) : réservée à l'éditeur / au CLI.
 * Le jeton n'est affiché qu'une fois ; seule son empreinte est stockée.
 */
export async function createOrgWithAdminInvitation(
  client: pg.Client,
  input: { type: 'bailleur' | 'property_manager' | 'prestataire'; nom: string; adminEmail: string; ttlDays?: number },
): Promise<{ orgId: string; token: string }> {
  const token = randomToken();
  await client.query('BEGIN');
  try {
    const org = await client.query<{ id: string }>('INSERT INTO organisation (type, nom) VALUES ($1, $2) RETURNING id', [input.type, input.nom]);
    const orgId = org.rows[0]!.id;
    await client.query(
      `INSERT INTO invitation (org_id, email, role, token_hash, expires_at)
       VALUES ($1, lower($2), 'admin_org', $3, now() + make_interval(days => $4))`,
      [orgId, input.adminEmail, sha256Hex(token), input.ttlDays ?? 7]);
    await client.query('COMMIT');
    return { orgId, token };
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  }
}

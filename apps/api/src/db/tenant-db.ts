import pg from 'pg';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export interface TenantContext {
  /** Utilisateur authentifié. */
  userId: string;
  /** Espace de travail actif (organisation), déjà vérifié contre l'appartenance. */
  orgId: string;
  /** Périmètre restreint à ces sites ; absent ou '*' = tout l'espace. */
  scopeSiteIds?: string[] | '*';
}

/**
 * Seul point d'accès aux données métier. Chaque appel ouvre une transaction et pose le
 * contexte avec set_config(..., true) (équivalent de SET LOCAL) : le contexte disparaît au
 * COMMIT/ROLLBACK et ne peut pas fuiter d'une requête à l'autre via le pool de connexions.
 */
export class TenantDb {
  constructor(private readonly pool: pg.Pool) {}

  async withTenant<T>(ctx: TenantContext, fn: (client: pg.PoolClient) => Promise<T>): Promise<T> {
    if (!UUID.test(ctx.userId) || !UUID.test(ctx.orgId)) throw new Error('contexte invalide');
    const scope = ctx.scopeSiteIds ?? '*';
    if (scope !== '*' && !scope.every((s) => UUID.test(s))) throw new Error('périmètre invalide');
    return this.run(fn, async (c) => {
      await c.query(
        `SELECT set_config('app.user_id', $1, true),
                set_config('app.org_id', $2, true),
                set_config('app.scope_site_ids', $3, true)`,
        [ctx.userId, ctx.orgId, scope === '*' ? '*' : scope.join(',')],
      );
    });
  }

  /** Sans contexte : toutes les politiques RLS doivent refuser (utilisé par health et les tests). */
  async withoutTenant<T>(fn: (client: pg.PoolClient) => Promise<T>): Promise<T> {
    return this.run(fn);
  }

  private async run<T>(fn: (c: pg.PoolClient) => Promise<T>, setup?: (c: pg.PoolClient) => Promise<void>): Promise<T> {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      if (setup) await setup(client);
      const result = await fn(client);
      await client.query('COMMIT');
      return result;
    } catch (err) {
      await client.query('ROLLBACK').catch(() => undefined);
      throw err;
    } finally {
      client.release();
    }
  }
}

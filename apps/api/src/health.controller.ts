import { Controller, Get, Inject, ServiceUnavailableException } from '@nestjs/common';
import { TenantDb } from './db/tenant-db.js';

@Controller('health')
export class HealthController {
  constructor(@Inject(TenantDb) private readonly db: TenantDb) {}

  @Get()
  async check(): Promise<{ status: 'ok' }> {
    try {
      await this.db.withoutTenant((c) => c.query('SELECT 1'));
      return { status: 'ok' };
    } catch {
      throw new ServiceUnavailableException({ status: 'database_unavailable' });
    }
  }
}

import { Module } from '@nestjs/common';
import pg from 'pg';
import { TenantDb } from './tenant-db.js';

@Module({
  providers: [
    {
      provide: TenantDb,
      useFactory: () => {
        const connectionString = process.env.DATABASE_URL_APP;
        if (!connectionString) throw new Error('DATABASE_URL_APP est requis');
        return new TenantDb(new pg.Pool({ connectionString, max: 10 }));
      },
    },
  ],
  exports: [TenantDb],
})
export class DbModule {}

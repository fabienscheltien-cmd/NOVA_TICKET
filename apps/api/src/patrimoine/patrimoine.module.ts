import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module.js';
import { loadAuthConfig } from '../auth/config.js';
import { DbModule } from '../db/db.module.js';
import { TenantDb } from '../db/tenant-db.js';
import { ImportService } from './import.service.js';
import { PatrimoineController } from './patrimoine.controller.js';
import { PatrimoineService } from './patrimoine.service.js';

@Module({
  imports: [DbModule, AuthModule],
  controllers: [PatrimoineController],
  providers: [
    { provide: PatrimoineService, inject: [TenantDb], useFactory: (db: TenantDb) => new PatrimoineService(db, loadAuthConfig().appBaseUrl) },
    { provide: ImportService, inject: [TenantDb], useFactory: (db: TenantDb) => new ImportService(db) },
  ],
})
export class PatrimoineModule {}

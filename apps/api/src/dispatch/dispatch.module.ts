import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module.js';
import { DbModule } from '../db/db.module.js';
import { TenantDb } from '../db/tenant-db.js';
import { ContratsService } from './contrats.service.js';
import { ContratsController, DispatchController } from './dispatch.controller.js';
import { DispatchService } from './dispatch.service.js';

@Module({
  imports: [DbModule, AuthModule],
  controllers: [DispatchController, ContratsController],
  providers: [
    { provide: DispatchService, inject: [TenantDb], useFactory: (db: TenantDb) => new DispatchService(db) },
    { provide: ContratsService, inject: [TenantDb], useFactory: (db: TenantDb) => new ContratsService(db) },
  ],
})
export class DispatchModule {}

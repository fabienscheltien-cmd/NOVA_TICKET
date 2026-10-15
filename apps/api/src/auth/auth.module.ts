import { Module } from '@nestjs/common';
import { DbModule } from '../db/db.module.js';
import { TenantDb } from '../db/tenant-db.js';
import { AuthController, InvitationsController, MeController } from './auth.controller.js';
import { AuthService } from './auth.service.js';
import { loadAuthConfig } from './config.js';
import { OrgGuard, UserGuard } from './guards.js';
import { ConsoleMailer, MAILER, type Mailer } from './mailer.js';

@Module({
  imports: [DbModule],
  controllers: [AuthController, MeController, InvitationsController],
  providers: [
    { provide: MAILER, useFactory: (): Mailer => new ConsoleMailer() },
    {
      provide: AuthService,
      inject: [TenantDb, MAILER],
      useFactory: (db: TenantDb, mailer: Mailer) => new AuthService(db, loadAuthConfig(), mailer),
    },
    UserGuard,
    OrgGuard,
  ],
  exports: [AuthService],
})
export class AuthModule {}

import { Module } from '@nestjs/common';
import { AuthModule } from './auth/auth.module.js';
import { DbModule } from './db/db.module.js';
import { DispatchModule } from './dispatch/dispatch.module.js';
import { HealthController } from './health.controller.js';
import { PatrimoineModule } from './patrimoine/patrimoine.module.js';

@Module({ imports: [DbModule, AuthModule, PatrimoineModule, DispatchModule], controllers: [HealthController] })
export class AppModule {}

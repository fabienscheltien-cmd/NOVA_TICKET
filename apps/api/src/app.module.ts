import { Module } from '@nestjs/common';
import { AuthModule } from './auth/auth.module.js';
import { DbModule } from './db/db.module.js';
import { HealthController } from './health.controller.js';
import { PatrimoineModule } from './patrimoine/patrimoine.module.js';

@Module({ imports: [DbModule, AuthModule, PatrimoineModule], controllers: [HealthController] })
export class AppModule {}

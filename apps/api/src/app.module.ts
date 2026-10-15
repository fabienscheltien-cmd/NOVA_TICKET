import { Module } from '@nestjs/common';
import { AuthModule } from './auth/auth.module.js';
import { DbModule } from './db/db.module.js';
import { HealthController } from './health.controller.js';

@Module({ imports: [DbModule, AuthModule], controllers: [HealthController] })
export class AppModule {}

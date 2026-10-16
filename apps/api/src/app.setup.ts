import type { INestApplication } from '@nestjs/common';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { PgExceptionFilter } from './http-errors.js';

/** Configuration commune au serveur et aux tests : limites de corps, CSV en texte, filtre d'erreurs. */
export function configureApp(app: INestApplication): void {
  const express = app as unknown as NestExpressApplication;
  const hops = Number(process.env.TRUST_PROXY);
  if (Number.isInteger(hops) && hops > 0) express.set('trust proxy', hops);
  express.useBodyParser('json', { limit: '1mb' });
  express.useBodyParser('text', { type: ['text/csv', 'text/plain'], limit: '5mb' });
  app.useGlobalFilters(new PgExceptionFilter());
}

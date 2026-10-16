import type { INestApplication } from '@nestjs/common';
import type { NestExpressApplication } from '@nestjs/platform-express';
import helmet from 'helmet';
import { PgExceptionFilter } from './http-errors.js';

/** Configuration commune au serveur et aux tests : limites de corps, CSV en texte, filtre d'erreurs. */
export function configureApp(app: INestApplication): void {
  const express = app as unknown as NestExpressApplication;
  // En-têtes de sécurité (nosniff, HSTS, pas de X-Powered-By…). La console étant sur un autre sous-domaine du même site,
  // `same-site` suffit pour la politique de ressources ; le CORS reste la seule ouverture entre origines.
  express.use(helmet({ crossOriginResourcePolicy: { policy: 'same-site' } }));
  // Réponses d'API : jamais en cache partagé par défaut (les routes qui le veulent, comme le QR, posent leur propre en-tête).
  express.use((_req: unknown, res: { setHeader(n: string, v: string): void }, next: () => void) => { res.setHeader('Cache-Control', 'no-store'); next(); });
  const hops = Number(process.env.TRUST_PROXY);
  if (Number.isInteger(hops) && hops > 0) express.set('trust proxy', hops);
  express.useBodyParser('json', { limit: '1mb' });
  express.useBodyParser('text', { type: ['text/csv', 'text/plain'], limit: '5mb' });
  // La console web est servie depuis une autre origine : seules les origines listées sont autorisées (jamais « * »).
  // Les jetons voyagent dans l'en-tête Authorization, pas dans des cookies : pas de credentials.
  const origines = (process.env.CORS_ORIGINS ?? process.env.APP_BASE_URL ?? 'http://localhost:5173').split(',').map((o) => o.trim().replace(/\/$/, '')).filter(Boolean);
  app.enableCors({
    origin: origines,
    methods: ['GET', 'POST', 'PATCH', 'PUT', 'DELETE'],
    allowedHeaders: ['authorization', 'content-type'],
    exposedHeaders: ['retry-after'],
    maxAge: 600,
  });
  app.useGlobalFilters(new PgExceptionFilter());
}

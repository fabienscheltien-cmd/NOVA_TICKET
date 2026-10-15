import { HttpException } from '@nestjs/common';

/** Erreur métier d'authentification : code stable pour les clients, statut HTTP associé. */
export class AuthError extends HttpException {
  constructor(public readonly code: string, status: number, message?: string) {
    super({ error: code, message: message ?? code }, status);
  }
}

export const invalidCredentials = () => new AuthError('invalid_credentials', 401, 'Identifiants invalides');
export const unauthorized = () => new AuthError('unauthorized', 401, 'Authentification requise');
export const forbidden = (code = 'forbidden') => new AuthError(code, 403);

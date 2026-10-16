import { ArgumentsHost, Catch, ExceptionFilter, HttpException, HttpStatus } from '@nestjs/common';

interface PgLikeError { code?: string; message?: string; constraint?: string; detail?: string }
interface Reply { status(code: number): { json(body: unknown): void } }

const PG_STATUS: Record<string, [number, string]> = {
  '42501': [HttpStatus.FORBIDDEN, 'forbidden'],       // droit refusé / politique RLS
  '23505': [HttpStatus.CONFLICT, 'conflict'],         // unicité
  '23P01': [HttpStatus.CONFLICT, 'conflict'],         // exclusion (chevauchement)
  '23503': [HttpStatus.BAD_REQUEST, 'invalid_reference'],
  '23514': [HttpStatus.BAD_REQUEST, 'invalid_value'],
  '22P02': [HttpStatus.BAD_REQUEST, 'invalid_value'],
  '22007': [HttpStatus.BAD_REQUEST, 'invalid_value'],
  '22003': [HttpStatus.BAD_REQUEST, 'invalid_value'],
};

/** Traduit les erreurs PostgreSQL attendues en réponses HTTP sans exposer le détail interne. */
@Catch()
export class PgExceptionFilter implements ExceptionFilter {
  catch(exception: unknown, host: ArgumentsHost): void {
    const res = host.switchToHttp().getResponse<Reply>();
    if (exception instanceof HttpException) {
      res.status(exception.getStatus()).json(exception.getResponse());
      return;
    }
    const e = exception as PgLikeError;
    const mapped = e?.code ? PG_STATUS[e.code] : undefined;
    const rls = typeof e?.message === 'string' && e.message.includes('row-level security');
    if (mapped || rls) {
      const [status, code] = mapped ?? [HttpStatus.FORBIDDEN, 'forbidden'];
      res.status(rls ? HttpStatus.FORBIDDEN : status).json({ error: rls ? 'forbidden' : code, message: rls ? 'Action non autorisée' : e.message });
      return;
    }
    console.error(exception);
    res.status(HttpStatus.INTERNAL_SERVER_ERROR).json({ error: 'internal_error', message: 'Erreur interne' });
  }
}

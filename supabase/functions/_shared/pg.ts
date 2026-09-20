// A PostgREST error as the edge functions map it: the SQLSTATE and the writer's fixed message.
//
// The one class both database ports throw (db.ts for finalize-trip, actions_db.ts for
// trip-actions). `isPgError` also accepts the same shape from any other module, so a handler never
// depends on which module threw.

export class PgError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly details: string | null = null,
    readonly hint: string | null = null
  ) {
    super(message);
    this.name = 'PgError';
  }
}

export interface PostgrestError {
  code?: string;
  message: string;
  details?: string | null;
  hint?: string | null;
}

export const asPgError = (e: PostgrestError): PgError =>
  new PgError(e.code ?? 'unknown', e.message, e.details ?? null, e.hint ?? null);

/** True for a `PgError` from any module: the class here, or the same shape thrown by db.ts. */
export function isPgError(err: unknown): err is PgError {
  return (
    err instanceof PgError ||
    (err instanceof Error && err.name === 'PgError' && typeof (err as { code?: unknown }).code === 'string')
  );
}

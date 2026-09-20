// A PostgREST error as the edge functions map it: the SQLSTATE and the writer's fixed message.
//
// Extracted from db.ts (finalize-trip) unchanged. db.ts keeps its own copy of the class until its
// fix round imports this module, so `isPgError` recognises the shape from either — the handlers
// must not depend on which module threw.

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

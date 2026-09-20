// The HTTP plumbing every edge function shares: JSON replies, the request id for structured logs,
// the bearer token, the method and body guards, the zod refusal, and the mapping of the writers'
// SQLSTATE families to responses. Extracted from finalize-trip's handler, behaviour unchanged; a
// handler layers its own special cases (a 422 for a specific message, say) before falling through
// to `pgFailure`.
import type { ZodError } from 'zod';
import { isPgError } from './pg.ts';

export interface Logger {
  warn(...args: unknown[]): void;
  error(...args: unknown[]): void;
}

/** Lock timeout, deadlock, serialization failure: the client should simply try again. */
export const RETRYABLE_CODES: ReadonlySet<string> = new Set(['55P03', '40P01', '40001']);
/** Table CHECKs and keys on event rows: zod refuses these first, so a hit is server-side drift. */
export const ROW_CODES: ReadonlySet<string> = new Set(['23514', '23505', '22P02', '23502']);

export const json = (status: number, body: unknown, headers: Record<string, string> = {}): Response =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json', ...headers },
  });

/** The gateway's request id (§4.7), else a fresh one; never a position or a name goes with it. */
export const requestId = (req: Request): string =>
  req.headers.get('x-request-id') ?? req.headers.get('sb-request-id') ?? crypto.randomUUID();

export const bearerToken = (req: Request): string | null => {
  const m = /^Bearer\s+(\S+)$/i.exec(req.headers.get('authorization') ?? '');
  return m ? m[1] : null;
};

/** The 405 for anything but POST, or null when the method is fine. */
export const requirePost = (req: Request): Response | null =>
  req.method === 'POST' ? null : json(405, { code: 'method_not_allowed' }, { allow: 'POST' });

export type BodyResult = { ok: true; body: unknown } | { ok: false; response: Response };

/** The parsed JSON body, or the 413 / 400 that refuses it. */
export async function readJsonBody(req: Request, maxBytes: number): Promise<BodyResult> {
  const tooLarge = { ok: false as const, response: json(413, { code: 'payload_too_large' }) };
  if (Number(req.headers.get('content-length')) > maxBytes) return tooLarge;
  const raw = await req.arrayBuffer();
  if (raw.byteLength > maxBytes) return tooLarge;
  try {
    return { ok: true, body: JSON.parse(new TextDecoder().decode(raw)) };
  } catch {
    return { ok: false, response: json(400, { code: 'invalid_json' }) };
  }
}

/** The 400 for a contract refusal: dotted paths, an unknown key reports path ''. */
export const invalidPayload = (error: ZodError): Response =>
  json(400, {
    code: 'invalid_payload',
    issues: error.issues.map((i) => ({ path: i.path.join('.'), message: i.message })),
  });

/**
 * The shared mapping of a failure to a response, logged under `name`:
 * retryable → 503 + Retry-After; 22023 → 400 `invalid_envelope` (server-side drift after zod);
 * row codes → 400 `invalid_event_rows`; 42501 → 500 `misconfigured` when the service role is
 * missing, else 403; anything else → 500 with no detail.
 */
export function pgFailure(err: unknown, log: Logger, ctx: object, name: string): Response {
  if (isPgError(err)) {
    if (RETRYABLE_CODES.has(err.code)) return json(503, { code: 'retry' }, { 'retry-after': '2' });
    if (err.code === '22023') {
      log.error(`${name} envelope refused`, { ...ctx, message: err.message });
      return json(400, { code: 'invalid_envelope', message: err.message });
    }
    if (ROW_CODES.has(err.code)) {
      log.error(`${name} event rows refused`, { ...ctx, code: err.code, message: err.message });
      return json(400, { code: 'invalid_event_rows', message: err.message });
    }
    if (err.code === '42501') {
      log.error(`${name} refused by the writer`, { ...ctx, message: err.message });
      return err.message.includes('requires the service role')
        ? json(500, { code: 'misconfigured' })
        : json(403, { code: 'forbidden' });
    }
    log.error(`${name} database failure`, { ...ctx, code: err.code, message: err.message });
    return json(500, { code: 'internal' });
  }
  log.error(`${name} failed`, { ...ctx, error: err instanceof Error ? err.message : String(err) });
  return json(500, { code: 'internal' });
}

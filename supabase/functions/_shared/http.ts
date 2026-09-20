// The HTTP plumbing every edge function shares: JSON replies, the request id for structured logs,
// the bearer token, the method and body guards, the zod refusal, and the mapping of the writers'
// SQLSTATE families to responses. A handler layers its own special cases (a 422 for a specific
// message, say) before falling through to `pgFailure`.
//
// Two rules hold for every function: the request id is minted here and never taken from a header,
// and no database message ever reaches a response body — the mapped code does, the message goes
// to the log.
import type { ZodError } from 'zod';
import { isPgError } from './pg.ts';

export interface Logger {
  warn(...args: unknown[]): void;
  error(...args: unknown[]): void;
}

/** Lock timeout, deadlock, serialization failure: the client should simply try again. */
export const RETRYABLE_CODES: ReadonlySet<string> = new Set(['55P03', '40P01', '40001']);
/**
 * Table CHECKs, keys and casts on event rows (22003 is an `int` cast overflow): zod and the
 * plausibility rules refuse these first, so a hit is server-side drift.
 */
export const ROW_CODES: ReadonlySet<string> = new Set(['23514', '23505', '22P02', '23502', '22003']);

export const json = (status: number, body: unknown, headers: Record<string, string> = {}): Response =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json', ...headers },
  });

/**
 * A fresh id for this request's structured logs (§4.7). Never a client header: a caller could
 * collide with or spoof another request's id. Hand it back with `withRequestId` so the caller can
 * quote it.
 */
export const requestId = (): string => crypto.randomUUID();

/** The id on the response, so a caller's report can be matched to the log line. */
export const withRequestId = (res: Response, id: string): Response => {
  res.headers.set('x-request-id', id);
  return res;
};

export const bearerToken = (req: Request): string | null => {
  const m = /^Bearer\s+(\S+)$/i.exec(req.headers.get('authorization') ?? '');
  return m ? m[1] : null;
};

/** The 405 for anything but POST, or null when the method is fine. */
export const requirePost = (req: Request): Response | null =>
  req.method === 'POST' ? null : json(405, { code: 'method_not_allowed' }, { allow: 'POST' });

export type BodyResult = { ok: true; body: unknown } | { ok: false; response: Response };

/**
 * The body, bounded: refused on a declared length over the cap without reading, and cut off at the
 * cap while streaming, so a chunked upload cannot buffer more than that. Null means too large.
 */
async function readBounded(req: Request, max: number): Promise<Uint8Array | null> {
  if (Number(req.headers.get('content-length')) > max) return null;
  if (!req.body) return new Uint8Array();
  const reader = req.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > max) {
      await reader.cancel();
      return null;
    }
    chunks.push(value);
  }
  const out = new Uint8Array(total);
  let at = 0;
  for (const c of chunks) {
    out.set(c, at);
    at += c.byteLength;
  }
  return out;
}

/** The parsed JSON body, or the 413 / 400 that refuses it. */
export async function readJsonBody(req: Request, maxBytes: number): Promise<BodyResult> {
  const raw = await readBounded(req, maxBytes);
  if (raw === null) return { ok: false, response: json(413, { code: 'payload_too_large' }) };
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
 * missing, else 403; anything else → 500. Bodies carry the mapped code only.
 */
export function pgFailure(err: unknown, log: Logger, ctx: object, name: string): Response {
  if (isPgError(err)) {
    if (RETRYABLE_CODES.has(err.code)) return json(503, { code: 'retry' }, { 'retry-after': '2' });
    if (err.code === '22023') {
      log.error(`${name} envelope refused`, { ...ctx, message: err.message });
      return json(400, { code: 'invalid_envelope' });
    }
    if (ROW_CODES.has(err.code)) {
      log.error(`${name} event rows refused`, { ...ctx, code: err.code, message: err.message });
      return json(400, { code: 'invalid_event_rows' });
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

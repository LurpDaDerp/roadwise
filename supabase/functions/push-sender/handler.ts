// push-sender: one sweep of the server-originated notifications (design §8, product spec §11.1).
// pg_cron's `dispatch_push` (0007) calls it about once a minute when something is due; it claims
// the due inbox items, decides each one (`push_policy.ts`), sends what may go now through Expo in
// one pass, records every outcome, then reads the receipts that are due.
//
// Authentication (ruling T2 concern 1, condition 4; task-2-report "fix round 1"). The ONLY
// credential is `X-Sweep-Signature: <ts>.<sig>`: `sig` is the lower-case hex HMAC-SHA256, keyed by
// the UTF-8 bytes of `PUSH_SENDER_HMAC_KEY` (the Vault secret `push_sender_hmac_key`, ≥ 32 bytes,
// never the service-role key or the JWT secret), over `'push-sender-sweep:' || ts`, with `ts` in
// unix seconds within ±120 s. It is checked in constant time before anything else — before the
// method, before any database call — and a missing, malformed, stale or wrong header is a 401
// `{ code: 'unauthorized' }`. The header is never logged. The gateway's JWT check is off for this
// function (`verify_jwt = false`) because its caller is not a user.
//
// What the key buys is "run a sweep" and nothing more: the request body is never read, every
// piece of work comes from `claim_push_batch`, and the response is counts only. Sweeps do not
// overlap: the claim is a lease (`for update skip locked`, rows move to `sending`), so two sweeps
// never hold the same item, and within one isolate a sweep that arrives while another runs returns
// 409 at once.
//
// At most once. An item Expo accepted is recorded `sent`; if recording fails after the send, the
// row stays `sending` and the claim's lease expiry fails it (`lease_expired`) rather than send it
// again. When Expo is unavailable (429, 5xx, no answer), every item it did not accept is deferred
// two minutes (`expo_unavailable`).
//
// Logs carry the request id, the counts, inbox ids and reason codes — never a push token, a
// title, a body, a payload or the signature.
import { CATALOG, type Catalog } from '../_shared/catalog.ts';
import {
  type ExpoDeps,
  type ExpoMessage,
  ExpoUnavailable,
  getReceipts,
  type Receipt,
  sendPush,
  type Ticket,
} from '../_shared/expo_push.ts';
import { json, pgFailure, requestId, requirePost, withRequestId, type Logger } from '../_shared/http.ts';
import type { Delivery, Outcome, PushDb, ReceiptReport } from '../_shared/push_db.ts';
import { decideBatch } from '../_shared/push_policy.ts';

/** Items per sweep: one Expo pass of at most 1000 messages (≤ 10 tokens each). */
export const CLAIM_LIMIT = 100;
/** The claim's lease; longer than a sweep can take. */
export const LEASE_SECONDS = 300;
/** Receipts per sweep. */
export const RECEIPT_LIMIT = 300;
/** How long an item waits when Expo is unavailable. */
export const EXPO_RETRY_MS = 2 * 60_000;
/** The signature's accepted clock skew, either way, in whole seconds. */
export const SIGNATURE_WINDOW_S = 120;
/** The signed message's fixed prefix: ties the signature to this one purpose. */
export const SIGNATURE_PREFIX = 'push-sender-sweep:';
/** `PUSH_SENDER_HMAC_KEY`'s minimum length in bytes (the same bound `dispatch_push` enforces). */
export const MIN_KEY_BYTES = 32;

const SIGNATURE = /^([0-9]{1,12})\.([0-9a-f]{64})$/;

export interface PushLogger extends Logger {
  info(...args: unknown[]): void;
}

export interface SenderDeps {
  /** `PUSH_SENDER_HMAC_KEY`. */
  hmacKey: string;
  db: PushDb;
  expo: ExpoDeps;
  now?: () => number;
  log?: PushLogger;
  catalog?: Catalog;
}

export interface SweepCounts {
  claimed: number;
  sent: number;
  deferred: number;
  skipped: number;
  failed: number;
  receipts: number;
}

const encoder = new TextEncoder();

const hex = (bytes: Uint8Array): string => [...bytes].map((b) => b.toString(16).padStart(2, '0')).join('');

/** Compares two equal-length strings without an early exit. */
function constantTimeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

/** Whether `header` is a valid sweep signature under `key` at `nowMs`. */
export async function verifySweepSignature(header: string | null, key: string, nowMs: number): Promise<boolean> {
  if (header === null) return false;
  const m = SIGNATURE.exec(header);
  if (!m) return false;
  const ts = Number(m[1]);
  if (Math.abs(Math.floor(nowMs / 1000) - ts) > SIGNATURE_WINDOW_S) return false;
  const k = await crypto.subtle.importKey('raw', encoder.encode(key), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const mac = new Uint8Array(await crypto.subtle.sign('HMAC', k, encoder.encode(`${SIGNATURE_PREFIX}${m[1]}`)));
  return constantTimeEqual(hex(mac), m[2]);
}

const iso = (ms: number): string => new Date(ms).toISOString();

/** An item's outcome from its tickets: sent while any token took it, failed when none did. */
function sentOutcome(inboxId: string, tokens: string[], tickets: (Ticket | null)[], now: number): Outcome {
  const deliveries: Delivery[] = [];
  tokens.forEach((token, i) => {
    const t = tickets[i];
    if (t === null) return;
    deliveries.push(t.status === 'ok' ? { token, ticket_id: t.id } : { token, error: t.error });
  });
  if (deliveries.length === 0) {
    return { inbox_id: inboxId, state: 'deferred', reason: 'expo_unavailable', push_after: iso(now + EXPO_RETRY_MS) };
  }
  const anyOk = tickets.some((t) => t !== null && t.status === 'ok');
  return anyOk
    ? { inbox_id: inboxId, state: 'sent', reason: 'ok', deliveries }
    : { inbox_id: inboxId, state: 'failed', reason: 'expo_error', deliveries };
}

/** The request handler, holding the one-sweep-at-a-time guard for this isolate. */
export function createPushSender(deps: SenderDeps): (req: Request) => Promise<Response> {
  const log: PushLogger = deps.log ?? console;
  const now = deps.now ?? Date.now;
  const catalog = deps.catalog ?? CATALOG;
  let running = false;

  async function sweep(rid: string): Promise<Response> {
    const ctx = { requestId: rid };
    const counts: SweepCounts = { claimed: 0, sent: 0, deferred: 0, skipped: 0, failed: 0, receipts: 0 };
    try {
      const items = await deps.db.claim(CLAIM_LIMIT, LEASE_SECONDS);
      counts.claimed = items.length;
      const t = now();
      const decisions = decideBatch(items, t, catalog);

      // One Expo pass: a message per token of every send, remembering whose it is.
      const messages: ExpoMessage[] = [];
      const spans = new Map<number, { from: number; tokens: string[] }>();
      decisions.forEach((d, i) => {
        if (d.kind !== 'send') return;
        spans.set(i, { from: messages.length, tokens: d.tokens });
        for (const to of d.tokens) messages.push({ to, ...d.message });
      });
      let tickets: (Ticket | null)[] = [];
      if (messages.length > 0) {
        try {
          tickets = await sendPush(messages, deps.expo);
        } catch (err) {
          if (!(err instanceof ExpoUnavailable)) throw err;
          log.warn('push-sender expo unavailable', { ...ctx, messages: messages.length });
          tickets = err.tickets;
        }
      }

      const outcomes: Outcome[] = items.map((it, i) => {
        const d = decisions[i];
        if (d.kind === 'skip') return { inbox_id: it.inboxId, state: 'skipped', reason: d.reason };
        if (d.kind === 'defer') return { inbox_id: it.inboxId, state: 'deferred', reason: d.reason, push_after: iso(d.until) };
        const span = spans.get(i)!;
        const mine = span.tokens.map((_, k) => tickets[span.from + k] ?? null);
        return sentOutcome(it.inboxId, span.tokens, mine, t);
      });
      for (const o of outcomes) {
        if (o.state === 'sent') counts.sent++;
        else if (o.state === 'deferred') counts.deferred++;
        else if (o.state === 'skipped') counts.skipped++;
        else counts.failed++;
      }
      if (outcomes.length > 0) await deps.db.recordOutcomes(outcomes);

      const due = await deps.db.receiptsDue(RECEIPT_LIMIT);
      if (due.length > 0) {
        let found: Record<string, Receipt>;
        try {
          found = await getReceipts(
            due.map((d) => d.ticketId),
            deps.expo
          );
        } catch (err) {
          if (!(err instanceof ExpoUnavailable)) throw err;
          log.warn('push-sender expo unavailable for receipts', { ...ctx, due: due.length });
          found = err.receipts;
        }
        const reports: ReceiptReport[] = due.map((d) => {
          const r = found[d.ticketId];
          if (!r) return { delivery_id: d.deliveryId, status: null, error: null };
          return r.status === 'ok'
            ? { delivery_id: d.deliveryId, status: 'ok', error: null }
            : { delivery_id: d.deliveryId, status: 'error', error: r.error };
        });
        await deps.db.recordReceipts(reports);
        counts.receipts = reports.length;
      }

      log.info('push-sender sweep', {
        ...ctx,
        ...counts,
        outcomes: outcomes.map((o) => ({ inboxId: o.inbox_id, state: o.state, reason: o.reason })),
      });
      return json(200, counts);
    } catch (err) {
      return pgFailure(err, log, { ...ctx, ...counts }, 'push-sender');
    }
  }

  return async (req: Request): Promise<Response> => {
    const rid = requestId();
    const reply = (res: Response) => withRequestId(res, rid);
    // The signature first: nothing else is looked at for an unauthenticated caller.
    if (!(await verifySweepSignature(req.headers.get('x-sweep-signature'), deps.hmacKey, now()))) {
      log.warn('push-sender unauthorized', { requestId: rid });
      return reply(json(401, { code: 'unauthorized' }));
    }
    const notPost = requirePost(req);
    if (notPost) return reply(notPost);
    // The body is never read: the key authorises a sweep, and a sweep takes its work from the claim.
    if (running) {
      log.warn('push-sender sweep already running', { requestId: rid });
      return reply(json(409, { code: 'sweep_running' }));
    }
    running = true;
    try {
      return reply(await sweep(rid));
    } finally {
      running = false;
    }
  };
}

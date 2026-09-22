// push-sender: one sweep of the server-originated notifications (design §8, product spec §11.1).
// pg_cron's `dispatch_push` (0007) calls it about once a minute when something is due; it claims
// the due inbox items, decides each one (`push_policy.ts`), sends what may go now through Expo in
// one pass, records every outcome, then reads the receipts that are due.
//
// Authentication (ruling T2 concern 1, condition 4; task-2-report "fix round 1"). The ONLY
// credential is `X-Sweep-Signature: <ts>.<sig>`: `sig` is the lower-case hex HMAC-SHA256, keyed by
// the UTF-8 bytes of `PUSH_SENDER_HMAC_KEY` (the Vault secret `push_sender_hmac_key`, ≥ 32 bytes,
// never the service-role key or the JWT secret), over `'push-sender-sweep:' || ts`, with `ts` in
// unix seconds within ±120 s. It is checked by `_shared/sweep_auth.ts` (the one implementation of
// the contract, shared with purge-trace-objects) in constant time before anything else — before the
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
// At most once (ruling T3 round 1 m1). An item Expo accepted is recorded `sent`. A send whose
// answer never came once the request may have left (a timeout, a reset) is AMBIGUOUS: recorded
// `sent` with a token-only delivery (no ticket) and never sent again. Only a failure proven before
// sending (no connection, a 429 or 5xx) defers the items two minutes (`expo_unavailable`). If
// recording fails after the send it is retried once on a retryable code (m4); after that the row
// stays `sending` and the claim's lease expiry fails it (`lease_expired`) rather than send it again.
// A claimed row that breaks the contract is failed on its own (`failed/bad_payload`, m2).
//
// Time budget. pg_net gives the call 10 s; the whole sweep stays under `SWEEP_BUDGET_MS` (8 s).
// Every database call carries an abort signal for the budget; Expo requests are sized to what is
// left minus `OUTCOME_RESERVE_MS` (kept for recording outcomes) and capped at 5 s; a send that
// cannot start in time leaves its items due for the next sweep (`expo_unavailable`, `push_after`
// now); receipts are read only with `RECEIPTS_MIN_MS` left, and otherwise wait for the next sweep.
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
import { json, pgFailure, requestId, requirePost, RETRYABLE_CODES, withRequestId, type Logger } from '../_shared/http.ts';
import { isPgError } from '../_shared/pg.ts';
import type { Delivery, Outcome, PushDb, ReceiptReport } from '../_shared/push_db.ts';
import { decideBatch } from '../_shared/push_policy.ts';
import { SWEEP_SIGNATURE_HEADER, verifySweepSignature } from '../_shared/sweep_auth.ts';

/** Items per sweep: one Expo pass of at most 1000 messages (≤ 10 tokens each). */
export const CLAIM_LIMIT = 100;
/** The claim's lease; longer than a sweep can take. */
export const LEASE_SECONDS = 300;
/** Receipts per sweep. */
export const RECEIPT_LIMIT = 300;
/** How long an item waits when Expo is unavailable. */
export const EXPO_RETRY_MS = 2 * 60_000;
/** The signed message's purpose: `'push-sender-sweep:' || ts` (0007's `push_sweep_signature`). */
export const SWEEP_PURPOSE = 'push-sender-sweep';
/** The whole sweep's budget, under pg_net's 10 s client timeout. */
export const SWEEP_BUDGET_MS = 8_000;
/** Budget kept back from the Expo send for recording the outcomes (and their one retry). */
export const OUTCOME_RESERVE_MS = 2_000;
/** Receipts are read only when at least this much budget is left. */
export const RECEIPTS_MIN_MS = 2_000;
/** Budget kept back from the receipt read for recording the receipts. */
export const RECEIPT_RESERVE_MS = 1_000;

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
  /** The sweep's budget in ms (default `SWEEP_BUDGET_MS`); tests shrink it. */
  budgetMs?: number;
  /** A monotonic ms clock for the budget (default `performance.now`). */
  clock?: () => number;
}

export interface SweepCounts {
  claimed: number;
  sent: number;
  deferred: number;
  skipped: number;
  failed: number;
  receipts: number;
}

const iso = (ms: number): string => new Date(ms).toISOString();

/**
 * An item's outcome from its tickets: sent while any token took it or may have (`unknown`: an
 * ambiguous send, recorded without a ticket and never re-sent), failed when every token errored,
 * deferred when no token was attempted (`retryAt`).
 */
function sentOutcome(inboxId: string, tokens: string[], tickets: (Ticket | null)[], retryAt: number): Outcome {
  const deliveries: Delivery[] = [];
  tokens.forEach((token, i) => {
    const t = tickets[i];
    if (t === null) return;
    if (t.status === 'ok') deliveries.push({ token, ticket_id: t.id });
    else if (t.status === 'error') deliveries.push({ token, error: t.error });
    else deliveries.push({ token });
  });
  if (deliveries.length === 0) {
    return { inbox_id: inboxId, state: 'deferred', reason: 'expo_unavailable', push_after: iso(retryAt) };
  }
  const anyOk = tickets.some((t) => t !== null && t.status !== 'error');
  return anyOk
    ? { inbox_id: inboxId, state: 'sent', reason: 'ok', deliveries }
    : { inbox_id: inboxId, state: 'failed', reason: 'expo_error', deliveries };
}

/** Inbox ids with their state and reason: what a log line may say about an outcome. */
const summary = (outcomes: Outcome[]) => outcomes.map((o) => ({ inboxId: o.inbox_id, state: o.state, reason: o.reason }));

/** The request handler, holding the one-sweep-at-a-time guard for this isolate. */
export function createPushSender(deps: SenderDeps): (req: Request) => Promise<Response> {
  const log: PushLogger = deps.log ?? console;
  const now = deps.now ?? Date.now;
  const catalog = deps.catalog ?? CATALOG;
  const budgetMs = deps.budgetMs ?? SWEEP_BUDGET_MS;
  const clock = deps.clock ?? (() => performance.now());
  let running = false;

  async function sweep(rid: string): Promise<Response> {
    const ctx = { requestId: rid };
    const counts: SweepCounts = { claimed: 0, sent: 0, deferred: 0, skipped: 0, failed: 0, receipts: 0 };
    const started = clock();
    const left = () => budgetMs - (clock() - started);
    const budget = new AbortController();
    const timer = setTimeout(() => budget.abort(), budgetMs);
    const signal = budget.signal;
    try {
      const claim = await deps.db.claim(CLAIM_LIMIT, LEASE_SECONDS, signal);
      const items = claim.items;
      counts.claimed = items.length + claim.malformed.length + claim.unidentified;
      if (claim.malformed.length + claim.unidentified > 0) {
        log.warn('push-sender claimed rows outside the contract', {
          ...ctx,
          malformed: claim.malformed,
          unidentified: claim.unidentified,
        });
      }
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
      let retryAt = t + EXPO_RETRY_MS;
      if (messages.length > 0) {
        try {
          tickets = await sendPush(messages, { ...deps.expo, timeLeft: () => left() - OUTCOME_RESERVE_MS });
        } catch (err) {
          if (!(err instanceof ExpoUnavailable)) throw err;
          const attempted = err.tickets.filter((x) => x !== null).length;
          const ambiguous = err.tickets.filter((x) => x?.status === 'unknown').length;
          log.warn(err.budget ? 'push-sender budget spent before sending' : 'push-sender expo unavailable', {
            ...ctx,
            messages: messages.length,
            attempted,
            ambiguous,
          });
          tickets = err.tickets;
          // Out of budget: nothing is wrong with Expo, so the rest is due again at the next sweep.
          if (err.budget) retryAt = t;
        }
      }

      const outcomes: Outcome[] = items.map((it, i) => {
        const d = decisions[i];
        if (d.kind === 'skip') return { inbox_id: it.inboxId, state: 'skipped', reason: d.reason };
        if (d.kind === 'defer') return { inbox_id: it.inboxId, state: 'deferred', reason: d.reason, push_after: iso(d.until) };
        const span = spans.get(i)!;
        const mine = span.tokens.map((_, k) => tickets[span.from + k] ?? null);
        return sentOutcome(it.inboxId, span.tokens, mine, retryAt);
      });
      for (const id of claim.malformed) outcomes.push({ inbox_id: id, state: 'failed', reason: 'bad_payload' });
      for (const o of outcomes) {
        if (o.state === 'sent') counts.sent++;
        else if (o.state === 'deferred') counts.deferred++;
        else if (o.state === 'skipped') counts.skipped++;
        else counts.failed++;
      }
      // A row without an inbox id cannot be recorded; its lease expiry fails it.
      counts.failed += claim.unidentified;
      if (outcomes.length > 0) {
        try {
          await deps.db.recordOutcomes(outcomes, signal);
        } catch (err) {
          // One retry on a lock timeout, deadlock or serialization failure (m4): the pushes have gone,
          // and an unrecorded send leaves pushed_at null, which undercounts the day's cap.
          if (!(isPgError(err) && RETRYABLE_CODES.has(err.code))) throw err;
          log.warn('push-sender outcomes retried', { ...ctx, code: err.code });
          await deps.db.recordOutcomes(outcomes, signal);
        }
      }

      if (left() < RECEIPTS_MIN_MS) {
        log.warn('push-sender receipts left for the next sweep', ctx);
        log.info('push-sender sweep', { ...ctx, ...counts, outcomes: summary(outcomes) });
        return json(200, counts);
      }
      const due = await deps.db.receiptsDue(RECEIPT_LIMIT, signal);
      if (due.length > 0) {
        let found: Record<string, Receipt>;
        try {
          found = await getReceipts(
            due.map((d) => d.ticketId),
            { ...deps.expo, timeLeft: () => left() - RECEIPT_RESERVE_MS }
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
        await deps.db.recordReceipts(reports, signal);
        counts.receipts = reports.length;
      }

      log.info('push-sender sweep', { ...ctx, ...counts, outcomes: summary(outcomes) });
      return json(200, counts);
    } catch (err) {
      return pgFailure(err, log, { ...ctx, ...counts }, 'push-sender');
    } finally {
      clearTimeout(timer);
    }
  }

  return async (req: Request): Promise<Response> => {
    const rid = requestId();
    const reply = (res: Response) => withRequestId(res, rid);
    // The signature first: nothing else is looked at for an unauthenticated caller.
    const header = req.headers.get(SWEEP_SIGNATURE_HEADER);
    if (!(await verifySweepSignature(header, SWEEP_PURPOSE, deps.hmacKey, Math.floor(now() / 1000)))) {
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

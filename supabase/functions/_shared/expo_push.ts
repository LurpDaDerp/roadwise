// The Expo push service, as push-sender uses it: send messages (tickets back) and read receipts.
//
// Two rules keep a push token out of everything this returns: a ticket or a receipt keeps only
// Expo's error CODE (`details.error`, e.g. `DeviceNotRegistered`), never its `message`, which quotes
// the token; and nothing here logs.
//
// Failure classes (at most once, ruling T3 round 1 m1):
// - PROVEN NOT SENT: a 429 or 5xx answer, or a failure to connect at all (DNS, connection
//   refused: the fetch error names the `Connect` stage). Nothing in the chunk was accepted, so it
//   is `ExpoUnavailable` and push-sender defers those items and tries again.
// - AMBIGUOUS: a timeout, a reset or any other failure once the request may have gone out. Expo may
//   well have accepted the chunk, so its messages get `{ status: 'unknown' }` tickets: push-sender
//   records them sent with no ticket and never sends them again. Sending stops there
//   (`ExpoUnavailable`): later chunks were never attempted, so they are proven not sent.
// - Any other refusal, or an answer that cannot be read, fails that chunk's messages (an error
//   ticket): a request Expo refuses would be refused again, and a 200 that cannot be read may still
//   have been delivered.
// `ExpoUnavailable` carries what the earlier chunks already got, so an accepted message is never
// sent twice.
//
// Time budget: `timeLeft` (from push-sender's sweep budget) sizes every request's timeout, capped at
// `EXPO_TIMEOUT_MAX_MS`; a chunk with less than `MIN_REQUEST_MS` left is not started
// (`ExpoUnavailable` with `budget: true`), and its items wait for the next sweep.
import { z } from 'zod';

export const DEFAULT_EXPO_PUSH_URL = 'https://exp.host/--/api/v2/push';
/** Expo accepts at most 100 messages per send request. */
export const SEND_CHUNK = 100;
/** Expo accepts at most 1000 ids per receipts request; 300 keeps each answer small. */
export const RECEIPT_CHUNK = 300;
/** The longest any one Expo request may take; the sweep's remaining budget can make it shorter. */
export const EXPO_TIMEOUT_MAX_MS = 5_000;
/** A request is not started with less time than this left in the budget. */
export const MIN_REQUEST_MS = 500;
/** `push_deliveries.error` and `receipt_error` are at most 64 characters. */
const MAX_ERROR = 64;

export interface ExpoMessage {
  to: string;
  title: string;
  body: string;
  data: { inboxId: string; url: string };
  sound: 'default';
  priority: 'default' | 'normal' | 'high';
  channelId: string;
  categoryId?: string;
}

/** `unknown`: the request may have reached Expo but no answer came (never re-sent). */
export type Ticket = { status: 'ok'; id: string } | { status: 'error'; error: string } | { status: 'unknown' };
export type Receipt = { status: 'ok' } | { status: 'error'; error: string };

export interface ExpoDeps {
  fetch?: typeof fetch;
  /** The push API base; `/send` and `/getReceipts` are appended. */
  url?: string;
  /** `EXPO_ACCESS_TOKEN`, when the project enforces push security. */
  accessToken?: string | null;
  /** Milliseconds left for Expo calls; absent means no budget beyond `EXPO_TIMEOUT_MAX_MS`. */
  timeLeft?: () => number;
}

/**
 * Sending stopped: 429, 5xx, no connection, an ambiguous chunk (its tickets are `unknown`), or the
 * budget ran out (`budget: true`). `tickets` holds what was attempted (null: never attempted);
 * `receipts` what was read.
 */
export class ExpoUnavailable extends Error {
  constructor(
    readonly tickets: (Ticket | null)[] = [],
    readonly receipts: Record<string, Receipt> = {},
    readonly budget = false
  ) {
    super('expo unavailable');
    this.name = 'ExpoUnavailable';
  }
}

const ErrorShape = z.object({ status: z.literal('error'), details: z.object({ error: z.string().optional() }).passthrough().optional() }).passthrough();
const TicketShape = z.union([z.object({ status: z.literal('ok'), id: z.string().min(1).max(128) }).passthrough(), ErrorShape]);
const ReceiptShape = z.union([z.object({ status: z.literal('ok') }).passthrough(), ErrorShape]);
const SendAnswer = z.object({ data: z.array(TicketShape) }).passthrough();
const ReceiptsAnswer = z.object({ data: z.record(z.string(), ReceiptShape) }).passthrough();

const errorCode = (e: z.infer<typeof ErrorShape>): string => (e.details?.error || 'ExpoError').slice(0, MAX_ERROR);

type Outcome =
  | { kind: 'unavailable' }
  | { kind: 'ambiguous' }
  | { kind: 'budget' }
  | { kind: 'rejected' }
  | { kind: 'ok'; body: unknown };

/** The fetch failed before any byte of the request left: DNS or TCP connect (Deno's `(Connect)` stage). */
export function failedBeforeSend(err: unknown): boolean {
  if (!(err instanceof Error) || err.name === 'TimeoutError' || err.name === 'AbortError') return false;
  const cause = (err as { cause?: unknown }).cause;
  const text = `${err.message} ${cause instanceof Error ? cause.message : String(cause ?? '')}`;
  return /client error \(Connect\)|tcp connect error|dns error|connection refused|actively refused/i.test(text);
}

async function post(path: string, body: unknown, deps: ExpoDeps): Promise<Outcome> {
  const timeout = Math.min(EXPO_TIMEOUT_MAX_MS, deps.timeLeft ? deps.timeLeft() : EXPO_TIMEOUT_MAX_MS);
  if (timeout < MIN_REQUEST_MS) return { kind: 'budget' };
  const headers: Record<string, string> = {
    'content-type': 'application/json',
    accept: 'application/json',
    'accept-encoding': 'gzip, deflate',
  };
  if (deps.accessToken) headers.authorization = `Bearer ${deps.accessToken}`;
  let res: Response;
  try {
    res = await (deps.fetch ?? fetch)(`${deps.url ?? DEFAULT_EXPO_PUSH_URL}${path}`, {
      method: 'POST',
      headers,
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(timeout),
    });
  } catch (err) {
    return failedBeforeSend(err) ? { kind: 'unavailable' } : { kind: 'ambiguous' };
  }
  if (res.status === 429 || res.status >= 500) {
    await res.body?.cancel();
    return { kind: 'unavailable' };
  }
  if (!res.ok) {
    await res.body?.cancel();
    return { kind: 'rejected' };
  }
  try {
    return { kind: 'ok', body: await res.json() };
  } catch {
    // Accepted (2xx) but the body could not be read: the messages count as sent.
    return { kind: 'ok', body: null };
  }
}

/** One ticket per message, in order. */
export async function sendPush(messages: ExpoMessage[], deps: ExpoDeps = {}): Promise<Ticket[]> {
  const out: (Ticket | null)[] = messages.map(() => null);
  for (let at = 0; at < messages.length; at += SEND_CHUNK) {
    const chunk = messages.slice(at, at + SEND_CHUNK);
    const answer = await post('/send', chunk, deps);
    if (answer.kind === 'budget') throw new ExpoUnavailable(out, {}, true);
    if (answer.kind === 'unavailable') throw new ExpoUnavailable(out);
    if (answer.kind === 'ambiguous') {
      chunk.forEach((_, i) => (out[at + i] = { status: 'unknown' }));
      throw new ExpoUnavailable(out);
    }
    const failAll = (error: string) => chunk.forEach((_, i) => (out[at + i] = { status: 'error', error }));
    if (answer.kind === 'rejected') {
      failAll('ExpoRequestRejected');
      continue;
    }
    const parsed = SendAnswer.safeParse(answer.body);
    if (!parsed.success || parsed.data.data.length !== chunk.length) {
      failAll('ExpoBadResponse');
      continue;
    }
    parsed.data.data.forEach((t, i) => {
      out[at + i] = t.status === 'ok' ? { status: 'ok', id: (t as { id: string }).id } : { status: 'error', error: errorCode(t) };
    });
  }
  return out as Ticket[];
}

/**
 * The receipts Expo has for `ids`, keyed by ticket id. An id with no receipt yet is absent. A
 * rejected or unreadable answer leaves its ids absent too (they are checked again later).
 */
export async function getReceipts(ids: string[], deps: ExpoDeps = {}): Promise<Record<string, Receipt>> {
  const out: Record<string, Receipt> = {};
  for (let at = 0; at < ids.length; at += RECEIPT_CHUNK) {
    const chunk = ids.slice(at, at + RECEIPT_CHUNK);
    const answer = await post('/getReceipts', { ids: chunk }, deps);
    // A receipt read is idempotent: an ambiguous one is simply read again later.
    if (answer.kind === 'budget') throw new ExpoUnavailable([], out, true);
    if (answer.kind === 'unavailable' || answer.kind === 'ambiguous') throw new ExpoUnavailable([], out);
    if (answer.kind === 'rejected') continue;
    const parsed = ReceiptsAnswer.safeParse(answer.body);
    if (!parsed.success) continue;
    const wanted = new Set(chunk);
    for (const [id, r] of Object.entries(parsed.data.data)) {
      if (!wanted.has(id)) continue;
      out[id] = r.status === 'ok' ? { status: 'ok' } : { status: 'error', error: errorCode(r) };
    }
  }
  return out;
}

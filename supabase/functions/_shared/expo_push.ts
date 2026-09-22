// The Expo push service, as push-sender uses it: send messages (tickets back) and read receipts.
//
// Two rules keep a push token out of everything this returns: a ticket or a receipt keeps only
// Expo's error CODE (`details.error`, e.g. `DeviceNotRegistered`), never its `message`, which quotes
// the token; and nothing here logs.
//
// Failure classes. 429, 5xx and a network failure are `ExpoUnavailable`: nothing in the failing
// chunk was accepted, so push-sender defers those items and tries again. It carries what the
// earlier chunks already got, so an accepted message is never sent twice. Any other refusal, or an
// answer that cannot be read, fails that chunk's messages (an error ticket): a request Expo refuses
// would be refused again, and a 200 that cannot be read may still have been delivered.
import { z } from 'zod';

export const DEFAULT_EXPO_PUSH_URL = 'https://exp.host/--/api/v2/push';
/** Expo accepts at most 100 messages per send request. */
export const SEND_CHUNK = 100;
/** Expo accepts at most 1000 ids per receipts request; 300 keeps each answer small. */
export const RECEIPT_CHUNK = 300;
/** Per request; pg_net gives the whole sweep 10 s, but the sweep's work outlives the caller. */
export const EXPO_TIMEOUT_MS = 15_000;
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

export type Ticket = { status: 'ok'; id: string } | { status: 'error'; error: string };
export type Receipt = { status: 'ok' } | { status: 'error'; error: string };

export interface ExpoDeps {
  fetch?: typeof fetch;
  /** The push API base; `/send` and `/getReceipts` are appended. */
  url?: string;
  /** `EXPO_ACCESS_TOKEN`, when the project enforces push security. */
  accessToken?: string | null;
}

/** 429, 5xx or no answer: try again later. Holds whatever the earlier chunks already got. */
export class ExpoUnavailable extends Error {
  constructor(
    readonly tickets: (Ticket | null)[] = [],
    readonly receipts: Record<string, Receipt> = {}
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

type Outcome = { kind: 'unavailable' } | { kind: 'rejected' } | { kind: 'ok'; body: unknown };

async function post(path: string, body: unknown, deps: ExpoDeps): Promise<Outcome> {
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
      signal: AbortSignal.timeout(EXPO_TIMEOUT_MS),
    });
  } catch {
    return { kind: 'unavailable' };
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
    return { kind: 'ok', body: null };
  }
}

/** One ticket per message, in order. */
export async function sendPush(messages: ExpoMessage[], deps: ExpoDeps = {}): Promise<Ticket[]> {
  const out: (Ticket | null)[] = messages.map(() => null);
  for (let at = 0; at < messages.length; at += SEND_CHUNK) {
    const chunk = messages.slice(at, at + SEND_CHUNK);
    const answer = await post('/send', chunk, deps);
    if (answer.kind === 'unavailable') throw new ExpoUnavailable(out);
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
    if (answer.kind === 'unavailable') throw new ExpoUnavailable([], out);
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

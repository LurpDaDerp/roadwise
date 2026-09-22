// An in-memory stand-in for push-sender's database port (`push_db.ts`). It holds the claimable
// items, hands them out once (a second claim gets `[]`, as the lease does), and checks every
// outcome the way 0007's `record_push_outcomes` does — the same states, reasons, 7-day `push_after`
// bound and fixed 22023 messages, one bad outcome refusing the whole call — so a handler that sends
// `deliver_after`, an unknown reason or an outcome for an unclaimed item fails here as it would on
// the stack. Every call is logged in order, so a test can prove no call happened (auth first).
import { PgError } from '../pg.ts';
import type { DueReceipt, Outcome, PushDb, ReceiptReport } from '../push_db.ts';
import type { PushItem } from '../push_policy.ts';

const STATES = new Set(['sent', 'deferred', 'skipped', 'failed']);
const REASONS = new Set([
  'ok',
  'driving',
  'quiet_hours',
  'window',
  'expo_unavailable',
  'local',
  'inbox_only',
  'category_off',
  'capped',
  'weekly_limit',
  'no_device',
  'stale',
  'already_read',
  'dismissed',
  'subject_gone',
  'unknown_type',
  'bad_payload',
  'expo_error',
]);
const WEEK_MS = 7 * 86_400_000;

export interface FakePushDbCall {
  fn: 'claim' | 'recordOutcomes' | 'receiptsDue' | 'recordReceipts';
  args: unknown;
}

export interface FakePushDb {
  db: PushDb;
  calls: FakePushDbCall[];
  /** Outcomes the writer accepted. */
  outcomes: Outcome[];
  /** Receipts reported. */
  receipts: ReceiptReport[];
}

export interface FakePushDbOptions {
  items?: PushItem[];
  due?: DueReceipt[];
  now?: () => number;
  /** Make one port call fail with this error. */
  fail?: Partial<Record<FakePushDbCall['fn'], Error>>;
  /** Resolves before `claim` answers: lets a test hold a sweep open. */
  claimGate?: Promise<void>;
}

const refuse = (message: string) => new PgError('22023', message);

export function fakePushDb(opts: FakePushDbOptions = {}): FakePushDb {
  const now = opts.now ?? Date.now;
  let pending = [...(opts.items ?? [])];
  const sending = new Set<string>();
  const calls: FakePushDbCall[] = [];
  const outcomes: Outcome[] = [];
  const receipts: ReceiptReport[] = [];
  const failIf = (fn: FakePushDbCall['fn']) => {
    const e = opts.fail?.[fn];
    if (e) throw e;
  };

  const db: PushDb = {
    async claim(limit, leaseSeconds) {
      calls.push({ fn: 'claim', args: { limit, leaseSeconds } });
      if (opts.claimGate) await opts.claimGate;
      failIf('claim');
      const out = pending.slice(0, limit);
      pending = pending.slice(limit);
      for (const it of out) sending.add(it.inboxId);
      return structuredClone(out);
    },
    recordOutcomes(list) {
      calls.push({ fn: 'recordOutcomes', args: structuredClone(list) });
      failIf('recordOutcomes');
      if (!Array.isArray(list) || list.length > 500) throw refuse('outcomes must be an array of at most 500 items');
      const seen = new Set<string>();
      for (const o of list) {
        const raw = o as unknown as Record<string, unknown>;
        if (typeof o.inbox_id !== 'string') throw refuse('outcome must be an object with a uuid inbox_id');
        if (!STATES.has(o.state)) throw refuse('unknown outcome state');
        if (!REASONS.has(o.reason)) throw refuse('unknown outcome reason');
        if (o.state === 'deferred') {
          const at = typeof raw.push_after === 'string' ? Date.parse(raw.push_after) : NaN;
          if (!Number.isFinite(at) || at > now() + WEEK_MS) throw refuse('deferred outcome needs push_after within 7 days');
        }
        const del = o.deliveries ?? [];
        if (!Array.isArray(del) || del.length > 10) throw refuse('deliveries must be an array of at most 10 items');
        for (const d of del) {
          if (
            (d.token !== undefined && d.token.length > 256) ||
            (d.ticket_id !== undefined && d.ticket_id.length > 128) ||
            (d.error !== undefined && d.error.length > 64)
          ) {
            throw refuse('delivery must be an object with bounded token, ticket_id and error');
          }
        }
        if (!sending.has(o.inbox_id) || seen.has(o.inbox_id)) throw refuse('outcome for an unclaimed item');
        seen.add(o.inbox_id);
      }
      for (const o of list) sending.delete(o.inbox_id);
      outcomes.push(...structuredClone(list));
      return Promise.resolve(list.length);
    },
    receiptsDue(limit) {
      calls.push({ fn: 'receiptsDue', args: { limit } });
      failIf('receiptsDue');
      return Promise.resolve(structuredClone((opts.due ?? []).slice(0, limit)));
    },
    recordReceipts(list) {
      calls.push({ fn: 'recordReceipts', args: structuredClone(list) });
      failIf('recordReceipts');
      for (const r of list) {
        if (!(r.status === null || r.status === 'ok' || r.status === 'error')) {
          throw refuse('receipt must be { delivery_id, status ok|error|null, error }');
        }
      }
      receipts.push(...structuredClone(list));
      const known = new Set((opts.due ?? []).map((d) => d.deliveryId));
      return Promise.resolve(list.filter((r) => known.has(r.delivery_id)).length);
    },
  };
  return { db, calls, outcomes, receipts };
}

/** A claimable permission-lapse item with an all-defaults ctx; override what a test is about. */
export function pushItem(overrides: Partial<PushItem> = {}, ctx: Partial<PushItem['ctx']> = {}): PushItem {
  const base: PushItem = {
    inboxId: crypto.randomUUID(),
    userId: '11111111-1111-4111-8111-111111111111',
    type: 'permission_lapsed',
    payload: { permission: 'location_always', platform: 'ios', deviceId: 'phone-a' },
    createdAt: 0,
    read: false,
    dismissed: false,
    subjectGone: false,
    ctx: {
      tz: 'America/Los_Angeles',
      quiet: { enabled: true, start: '22:00', end: '07:00' },
      categories: {},
      drivingSince: null,
      recent: [],
      localSentToday: 0,
      tokens: ['ExponentPushToken[aaaaaaaaaaaaaaaaaaaaaa]'],
    },
  };
  return { ...base, ...overrides, ctx: { ...base.ctx, ...ctx } };
}

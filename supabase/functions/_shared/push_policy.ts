// push-sender's policy: whether one claimed inbox item is sent now, deferred, or skipped for good
// (product spec §11.1, design §8). Pure: it reads the item, the claim's per-user `ctx`, the clock
// and the catalog, and nothing else, so every rule is a unit test.
//
// The rules run in a fixed order and the first that applies decides:
//   local → unknown_type → bad_payload → dismissed → already_read → subject_gone → stale →
//   category_off → no_device → driving (defer) → quiet_hours (defer) → window (defer) →
//   weekly_limit → capped → send.
//
// The daily cap (§11.1 rule 2) is decided ONLY through the catalog's `countsTowardDailyCap`, which
// reads `capClass` (rulings T4 I1 and r1): the phone's own count today (`local_sent_today`), the
// server's pushes today in the user's zone (`recent`), and the sends already decided earlier in
// this batch. A capped permission lapse is deferred to the next local day's first slot, never
// dropped (ruling T4 minor); its 48 h ttl keeps it alive until then, and the claim's
// `subject_gone` re-checks that the lapse is still current when it comes back.
//
// Time zones: every local-time rule runs in `ctx.tz` with zoned arithmetic through Intl, so a
// deferral across a DST shift lands on the wall-clock time it names. A zone Intl does not know (the
// database accepts a few V8 lacks) falls back to the notification default zone, never a throw.
import {
  CATALOG,
  type Catalog,
  type CatalogEntry,
  countsTowardDailyCap,
  DAILY_CAP,
  type DeliveryWindow,
  type NotificationType,
  PayloadSchemas,
  renderPush,
} from './catalog.ts';
import type { ExpoMessage } from './expo_push.ts';

/** 0007's `notification_defaults.tz`: the zone used when `ctx.tz` is unknown to Intl. */
export const DEFAULT_TZ = 'America/Los_Angeles';
/** How long a push waits while one of the user's devices is recording. */
export const DRIVING_RETRY_MS = 5 * 60_000;
/**
 * The types the cap carries to the next day instead of dropping (ruling T4 minor): a lapse is the
 * one notice that says recording is broken. Everything else the cap blocks is skipped.
 */
export const DEFER_WHEN_CAPPED: readonly NotificationType[] = ['permission_lapsed'];

const HOUR_MS = 3_600_000;
const DAY_MS = 24 * HOUR_MS;

export interface QuietHours {
  enabled: boolean;
  /** `HH:MM`; `start = end` means off. */
  start: string;
  end: string;
}

/** One claimed inbox item as push-sender works with it (`claim_push_batch`, camel-cased). */
export interface PushItem {
  inboxId: string;
  userId: string;
  /** Any string: an unknown one is refused as `unknown_type`. */
  type: string;
  payload: unknown;
  /** epoch ms */
  createdAt: number;
  read: boolean;
  dismissed: boolean;
  subjectGone: boolean;
  ctx: {
    tz: string;
    quiet: QuietHours;
    /** A missing key is ON. */
    categories: Record<string, boolean>;
    /** epoch ms, or null when no device is recording. */
    drivingSince: number | null;
    /**
     * The user's server pushes of the last 8 days. `lapseKey` (0007 round 3) is present only on a
     * `permission_lapsed` push: `<deviceId>:<permission>` of the lapse it was for.
     */
    recent: { type: string; pushedAt: number; lapseKey?: string }[];
    localSentToday: number;
    tokens: string[];
  };
}

/** The message every token of a send gets; `to` is added per token. */
export type PushMessage = Omit<ExpoMessage, 'to'>;

export type DeferReason = 'driving' | 'quiet_hours' | 'window' | 'capped';
export type SkipReason =
  | 'local'
  | 'unknown_type'
  | 'bad_payload'
  | 'dismissed'
  | 'already_read'
  | 'subject_gone'
  | 'stale'
  | 'category_off'
  | 'no_device'
  | 'weekly_limit'
  | 'capped';

export type Decision =
  | { kind: 'send'; tokens: string[]; message: PushMessage }
  /** `until` is epoch ms. */
  | { kind: 'defer'; until: number; reason: DeferReason }
  | { kind: 'skip'; reason: SkipReason };

// ——— zoned time ———

interface LocalParts {
  y: number;
  mo: number;
  d: number;
  h: number;
  mi: number;
  s: number;
}

const formatters = new Map<string, Intl.DateTimeFormat>();

function formatter(tz: string): Intl.DateTimeFormat {
  let f = formatters.get(tz);
  if (!f) {
    f = new Intl.DateTimeFormat('en-US', {
      timeZone: tz,
      hourCycle: 'h23',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
    });
    formatters.set(tz, f);
  }
  return f;
}

/** `tz` when Intl knows it, else the default zone. */
export function resolveTz(tz: string): string {
  try {
    formatter(tz);
    return tz;
  } catch {
    return DEFAULT_TZ;
  }
}

function localParts(t: number, tz: string): LocalParts {
  const out: Record<string, number> = {};
  for (const p of formatter(tz).formatToParts(new Date(t))) {
    if (p.type !== 'literal') out[p.type] = Number(p.value);
  }
  return { y: out.year, mo: out.month, d: out.day, h: out.hour, mi: out.minute, s: out.second };
}

/** The zone's offset from UTC at instant `t`, in ms (local = utc + offset). */
function offsetAt(t: number, tz: string): number {
  const p = localParts(t, tz);
  const whole = Math.floor(t / 1000) * 1000;
  return Date.UTC(p.y, p.mo - 1, p.d, p.h, p.mi, p.s) - whole;
}

/**
 * The instant a local wall-clock time names in `tz`. Tried under the offsets a day either side (a
 * DST shift is never closer than that to another): a time that exists under one of them is the
 * answer (the later, for a time that happens twice); a time in a spring-forward gap resolves to the
 * later candidate, just past the gap.
 */
function zonedInstant(y: number, mo: number, d: number, h: number, mi: number, tz: string): number {
  const wall = Date.UTC(y, mo - 1, d, h, mi);
  const candidates = [...new Set([offsetAt(wall - DAY_MS, tz), offsetAt(wall + DAY_MS, tz)])].map((o) => wall - o);
  const exact = candidates.filter((c) => {
    const p = localParts(c, tz);
    return p.y === y && p.mo === mo && p.d === d && p.h === h && p.mi === mi;
  });
  return Math.max(...(exact.length > 0 ? exact : candidates));
}

const minutesOf = (hhmm: string): number => {
  const [h, m] = hhmm.split(':').map(Number);
  return h * 60 + m;
};

/** The first instant strictly after `t` whose local time in `tz` is `hhmm`. */
function nextLocalTime(t: number, tz: string, hhmm: string): number {
  const p = localParts(t, tz);
  const target = minutesOf(hhmm);
  const h = Math.floor(target / 60);
  const mi = target % 60;
  const today = zonedInstant(p.y, p.mo, p.d, h, mi, tz);
  if (today > t) return today;
  const next = new Date(Date.UTC(p.y, p.mo - 1, p.d + 1));
  return zonedInstant(next.getUTCFullYear(), next.getUTCMonth() + 1, next.getUTCDate(), h, mi, tz);
}

/** `YYYY-MM-DD` of instant `t` in `tz` (an unknown zone reads as the default). */
export function localDate(t: number, tz: string): string {
  const p = localParts(t, resolveTz(tz));
  return `${p.y}-${String(p.mo).padStart(2, '0')}-${String(p.d).padStart(2, '0')}`;
}

/** Whether local minute-of-day `m` falls in [start, end), crossing midnight when start > end. */
function inSpan(m: number, start: number, end: number): boolean {
  return start < end ? m >= start && m < end : m >= start || m < end;
}

const minuteOfDay = (t: number, tz: string): number => {
  const p = localParts(t, tz);
  return p.h * 60 + p.mi;
};

/** Quiet hours in `tz` (start inclusive, end exclusive; off when disabled or start = end). */
export function inQuietHours(t: number, tz: string, quiet: QuietHours): boolean {
  if (!quiet.enabled || quiet.start === quiet.end) return false;
  const zone = resolveTz(tz);
  return inSpan(minuteOfDay(t, zone), minutesOf(quiet.start), minutesOf(quiet.end));
}

function outsideWindow(t: number, tz: string, window: DeliveryWindow | undefined): boolean {
  if (!window || window.start === window.end) return false;
  return !inSpan(minuteOfDay(t, tz), minutesOf(window.start), minutesOf(window.end));
}

/**
 * The next local day's first deliverable instant after `t`: local midnight, moved past quiet hours
 * and to the type's window when it has one.
 */
export function firstSlotAfter(t: number, tz: string, quiet: QuietHours, window: DeliveryWindow | undefined): number {
  const zone = resolveTz(tz);
  let slot = nextLocalTime(t, zone, '00:00');
  for (let i = 0; i < 3; i++) {
    if (inQuietHours(slot, zone, quiet)) slot = nextLocalTime(slot, zone, quiet.end);
    else if (outsideWindow(slot, zone, window)) slot = nextLocalTime(slot, zone, window!.start);
    else break;
  }
  return slot;
}

// ——— the rules ———

const entryOf = (type: string, catalog: Catalog): CatalogEntry | null =>
  Object.hasOwn(catalog, type) ? catalog[type as NotificationType] : null;

/** An unknown type counts toward the cap: the conservative reading. */
const countsOnCap = (type: string, catalog: Catalog): boolean =>
  entryOf(type, catalog) === null || countsTowardDailyCap(type as NotificationType, catalog);

const isPromo = (type: string, catalog: Catalog): boolean => entryOf(type, catalog)?.capClass === 'promo';

/** What the cap does to `type`: a lapse waits for the next day's first slot, anything else is dropped. */
export function cappedDecision(
  type: NotificationType,
  now: number,
  tz: string,
  quiet: QuietHours,
  window: DeliveryWindow | undefined
): Decision {
  return DEFER_WHEN_CAPPED.includes(type)
    ? { kind: 'defer', reason: 'capped', until: firstSlotAfter(now, tz, quiet, window) }
    : { kind: 'skip', reason: 'capped' };
}

const PRIORITY: Record<CatalogEntry['priority'], ExpoMessage['priority']> = { normal: 'default', low: 'normal' };

/** The earlier sends of this batch, per user, that the cap and the limits must see. */
interface BatchState {
  sentTypes: Map<string, string[]>;
  /** Lapse items a newer lapse of the same device and kind in this batch replaces. */
  superseded: Set<string>;
}

const emptyState = (): BatchState => ({ sentTypes: new Map(), superseded: new Set() });

/**
 * A lapse's identity, device and kind without the day: `<deviceId>:<permission>`, built exactly as
 * 0007's claim builds `recent[].lapse_key`. Only ever compared, never split (a device id may hold
 * `:`). Null for anything that is not a well-formed lapse.
 */
export function lapseKeyOf(type: string, payload: unknown): string | null {
  if (type !== 'permission_lapsed') return null;
  const p = PayloadSchemas.permission_lapsed.safeParse(payload);
  return p.success ? `${p.data.deviceId}:${p.data.permission}` : null;
}

/**
 * A lapse the user has already been told about (T2 r1 n3: a cap-deferred lapse and a fresh one of
 * the same device and kind are never both pushed). In one batch: a newer lapse with the same key
 * replaces the older. Across sweeps: a push in `recent` with exactly this `lapseKey`, sent at or
 * after this lapse was raised. A recent entry without a key never matches.
 */
function lapseSuperseded(item: PushItem, state: BatchState): boolean {
  const key = lapseKeyOf(item.type, item.payload);
  if (key === null) return false;
  if (state.superseded.has(item.inboxId)) return true;
  return item.ctx.recent.some((r) => r.lapseKey !== undefined && r.lapseKey === key && r.pushedAt >= item.createdAt);
}

function decideWith(item: PushItem, now: number, catalog: Catalog, state: BatchState): Decision {
  const entry = entryOf(item.type, catalog);
  if (entry?.delivery === 'local') return { kind: 'skip', reason: 'local' };
  if (entry === null || !entry.live) return { kind: 'skip', reason: 'unknown_type' };
  const type = entry.type;
  const schema = (PayloadSchemas as Record<string, { safeParse(v: unknown): { success: boolean } }>)[type];
  const copy = renderPush(type, item.payload, catalog);
  if (!schema || !schema.safeParse(item.payload).success || copy === null) return { kind: 'skip', reason: 'bad_payload' };
  if (item.dismissed) return { kind: 'skip', reason: 'dismissed' };
  if (item.read) return { kind: 'skip', reason: 'already_read' };
  if (item.subjectGone || lapseSuperseded(item, state)) return { kind: 'skip', reason: 'subject_gone' };
  if (now - item.createdAt > entry.ttlHours * HOUR_MS) return { kind: 'skip', reason: 'stale' };
  if (item.ctx.categories[entry.category] === false) return { kind: 'skip', reason: 'category_off' };
  if (item.ctx.tokens.length === 0) return { kind: 'skip', reason: 'no_device' };
  if (item.ctx.drivingSince !== null) return { kind: 'defer', reason: 'driving', until: now + DRIVING_RETRY_MS };

  const tz = resolveTz(item.ctx.tz);
  const quiet = item.ctx.quiet;
  // `critical` is exempt from quiet hours (§11.1); no critical type is live.
  if (entry.capClass !== 'critical' && inQuietHours(now, tz, quiet)) {
    return { kind: 'defer', reason: 'quiet_hours', until: nextLocalTime(now, tz, quiet.end) };
  }
  if (outsideWindow(now, tz, entry.window)) {
    return { kind: 'defer', reason: 'window', until: nextLocalTime(now, tz, entry.window!.start) };
  }

  const batch = state.sentTypes.get(item.userId) ?? [];
  const weekAgo = now - 7 * DAY_MS;
  const lastWeek = item.ctx.recent.filter((r) => r.pushedAt > weekAgo).map((r) => r.type);
  if (entry.weeklyLimit !== undefined) {
    const n = [...lastWeek, ...batch].filter((t) => t === type).length;
    if (n >= entry.weeklyLimit) return { kind: 'skip', reason: 'weekly_limit' };
  }
  if (entry.capClass === 'promo') {
    const n = [...lastWeek, ...batch].filter((t) => isPromo(t, catalog)).length;
    if (n >= DAILY_CAP.promoPer7Days) return cappedDecision(type, now, tz, quiet, entry.window);
  }
  if (countsTowardDailyCap(type, catalog)) {
    const today = localDate(now, tz);
    const serverToday = item.ctx.recent.filter(
      (r) => countsOnCap(r.type, catalog) && localDate(r.pushedAt, tz) === today
    ).length;
    const batchToday = batch.filter((t) => countsOnCap(t, catalog)).length;
    if (item.ctx.localSentToday + serverToday + batchToday >= DAILY_CAP.nonFamilyPerDay) {
      return cappedDecision(type, now, tz, quiet, entry.window);
    }
  }

  return {
    kind: 'send',
    tokens: [...item.ctx.tokens],
    message: {
      title: copy.title,
      body: copy.body,
      data: { inboxId: item.inboxId, url: copy.url },
      sound: 'default',
      priority: PRIORITY[entry.priority],
      channelId: copy.channelId,
    },
  };
}

/** One item on its own (no earlier sends in the batch). */
export function decide(item: PushItem, now: number, catalog: Catalog = CATALOG): Decision {
  return decideWith(item, now, catalog, emptyState());
}

/**
 * Every item of a claim, in claim order, each seeing the sends decided before it for the same
 * user (the cap, the weekly and promo limits) and the newer lapses of the same device and kind.
 */
export function decideBatch(items: PushItem[], now: number, catalog: Catalog = CATALOG): Decision[] {
  const state = emptyState();
  const newest = new Map<string, PushItem>();
  for (const it of items) {
    const lapse = lapseKeyOf(it.type, it.payload);
    if (lapse === null) continue;
    const key = `${it.userId}|${lapse}`;
    const held = newest.get(key);
    if (!held) {
      newest.set(key, it);
    } else if (it.createdAt > held.createdAt) {
      state.superseded.add(held.inboxId);
      newest.set(key, it);
    } else {
      state.superseded.add(it.inboxId);
    }
  }
  return items.map((it) => {
    const d = decideWith(it, now, catalog, state);
    if (d.kind === 'send') {
      const sent = state.sentTypes.get(it.userId) ?? [];
      sent.push(it.type);
      state.sentTypes.set(it.userId, sent);
    }
    return d;
  });
}

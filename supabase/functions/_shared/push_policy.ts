// push-sender's policy: whether one claimed inbox item is sent now, deferred, or skipped for good.
// Pure: it reads the item, the claim's per-user `ctx`, the clock, and nothing else.
//
// Rules, in order; the first that applies decides:
//   unknown_type → bad_payload → category_off → no_device → stale → quiet_hours (defer) → send.
//
// Quiet hours run in `ctx.tz` with zoned arithmetic through Intl, so a deferral across a DST shift
// lands on the wall-clock time it names. A zone Intl does not know falls back to New York.
import type { ExpoMessage } from './expo_push.ts';
import { ANDROID_CHANNEL, isPushKind, renderPush, TTL_MS } from './push_copy.ts';

/** The zone used when `ctx.tz` is unknown to Intl (the database's own fallback, plan decision 11). */
export const DEFAULT_TZ = 'America/New_York';

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
  kind: string;
  payload: unknown;
  /** epoch ms */
  createdAt: number;
  ctx: {
    tz: string;
    quiet: QuietHours;
    /** The user's preference for this kind. */
    enabled: boolean;
    tokens: string[];
  };
}

/** The message every token of a send gets; `to` is added per token. */
export type PushMessage = Omit<ExpoMessage, 'to'>;

export type DeferReason = 'quiet_hours';
export type SkipReason = 'unknown_type' | 'category_off' | 'no_device' | 'stale';

export type Decision =
  | { kind: 'send'; tokens: string[]; message: PushMessage }
  /** `until` is epoch ms. */
  | { kind: 'defer'; until: number; reason: DeferReason }
  | { kind: 'skip'; reason: SkipReason }
  /** The payload is not what the kind needs: failed for good. */
  | { kind: 'fail'; reason: 'bad_payload' };

// ——— zoned time ———

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

interface LocalParts {
  y: number;
  mo: number;
  d: number;
  h: number;
  mi: number;
  s: number;
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

/** The instant of a wall-clock time in `tz` (two passes settle a DST shift). */
function zonedInstant(y: number, mo: number, d: number, h: number, mi: number, tz: string): number {
  const guess = Date.UTC(y, mo - 1, d, h, mi);
  const t1 = guess - offsetAt(guess, tz);
  return guess - offsetAt(t1, tz);
}

const minutesOf = (hhmm: string): number => {
  const [h, m] = hhmm.split(':').map(Number);
  return h * 60 + m;
};

/** The next instant strictly after `t` whose wall clock in `tz` reads `hhmm`. */
export function nextLocalTime(t: number, tz: string, hhmm: string): number {
  const p = localParts(t, tz);
  const [h, mi] = hhmm.split(':').map(Number);
  const today = zonedInstant(p.y, p.mo, p.d, h, mi, tz);
  if (today > t) return today;
  return zonedInstant(p.y, p.mo, p.d + 1, h, mi, tz);
}

const minuteOfDay = (t: number, tz: string): number => {
  const p = localParts(t, tz);
  return p.h * 60 + p.mi;
};

/** Whether `t` falls in the quiet span (start inclusive, end exclusive; a span may cross midnight). */
export function inQuietHours(t: number, tz: string, quiet: QuietHours): boolean {
  if (!quiet.enabled) return false;
  const start = minutesOf(quiet.start);
  const end = minutesOf(quiet.end);
  if (start === end) return false;
  const m = minuteOfDay(t, tz);
  return start < end ? m >= start && m < end : m >= start || m < end;
}

export function decide(item: PushItem, now: number): Decision {
  if (!isPushKind(item.kind)) return { kind: 'skip', reason: 'unknown_type' };
  const copy = renderPush(item.kind, item.payload);
  if (!copy) return { kind: 'fail', reason: 'bad_payload' };
  if (!item.ctx.enabled) return { kind: 'skip', reason: 'category_off' };
  if (item.ctx.tokens.length === 0) return { kind: 'skip', reason: 'no_device' };
  if (now - item.createdAt > TTL_MS[item.kind]) return { kind: 'skip', reason: 'stale' };
  const tz = resolveTz(item.ctx.tz);
  if (inQuietHours(now, tz, item.ctx.quiet)) {
    return { kind: 'defer', until: nextLocalTime(now, tz, item.ctx.quiet.end), reason: 'quiet_hours' };
  }
  return {
    kind: 'send',
    tokens: item.ctx.tokens,
    message: {
      title: copy.title,
      body: copy.body,
      data: { inboxId: item.inboxId, url: copy.url },
      sound: 'default',
      priority: 'default',
      channelId: ANDROID_CHANNEL,
    },
  };
}

export const decideBatch = (items: PushItem[], now: number): Decision[] => items.map((it) => decide(it, now));

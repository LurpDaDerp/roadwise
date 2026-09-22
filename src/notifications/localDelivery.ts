/**
 * The phone's own notifications, decided before the OS is asked: whether a drive summary is shown,
 * and when (H6's categories and quiet hours), and the phone's half of the §11.1 daily cap.
 *
 * **The cap (rev1: C1; ruling N-I1).** §11.1 rule 2 caps non-family notifications at 2 a day, local
 * and pushed together. The phone counts what it shows; the server counts what it pushed
 * (`countServerPushesToday`); `local + pushed ≥ 2` is capped. Whether a type counts is decided ONLY
 * by the catalog (`countsTowardDailyCap`), so the pending drive-summary question is one switch.
 * A notification counts on the local day it is DELIVERED: a summary deferred by quiet hours to
 * 07:00 belongs to tomorrow. One scheduled but cancelled before delivery (a new drive candidate)
 * is uncounted; its replacement, if any, is counted when it is scheduled.
 *
 * **Storage.** `LOCAL_LEDGER_KEY` holds each counted notification `{ id, at, day }` (today and
 * later only). `LOCAL_SENT_KEY` is the exported total for today, exactly `{ day: 'YYYY-MM-DD',
 * count }`, rewritten whenever the ledger changes or the day rolls over: the background permission
 * report (Task 10) and `syncNotificationPrefs` send it to `notification_prefs.local_sent_*`, and
 * push-sender reads it back as `ctx.local_sent_today`. Days are in the user's zone, normalised
 * through `normaliseZone` exactly as the drive's zone is.
 *
 * Pure apart from the settings reads and writes; no timers, nothing on the drive path.
 */
import type { ConfigValues } from '@/data/config/appConfig';
import type { SettingsRepo } from '@/data/db/settings';
import { normaliseZone } from '@/core/engine/finalize';

import {
  CATALOG,
  countsTowardDailyCap,
  DAILY_CAP,
  NOTIFICATION_CATEGORIES,
  type Catalog,
  type NotificationCategory,
  type NotificationType,
} from './catalog';
import { LOCAL_SENT_KEY, PREFS_CACHE_KEY } from './keys';

/** §11.2 "≥ 2 min after end". */
export const SUMMARY_DELAY_MS = 120_000;

/** Settings key: every counted local notification of today and later, `LedgerEntry[]`. */
export const LOCAL_LEDGER_KEY = 'notifications.localLedger';

const DAY_MS = 86_400_000;
const LEDGER_MAX = 50;

export type NotificationDefaults = ConfigValues['notification_defaults'];

/** Quiet hours as the phone applies them: `HH:MM`, start inclusive, end exclusive; start = end is off. */
export interface QuietHours {
  enabled: boolean;
  start: string;
  end: string;
}

/** The preferences in force: the row where it says something, the config defaults elsewhere. */
export interface EffectivePrefs {
  categories: Record<NotificationCategory, boolean>;
  quiet: QuietHours;
}

export interface PlanInput {
  type: 'trip_summary';
  /** Epoch ms the drive ended. */
  endedAt: number;
  now: number;
  prefs: EffectivePrefs;
  tz: string;
  /** Counted local notifications on today's local day (`readLocalCounts(...).today.count`). */
  localSentToday: number;
  /** The server's pushes today (`countServerPushesToday`). */
  serverPushedToday: number;
  /** Counted local notifications by later local day (`readLocalCounts(...).byDay`), for a deferral. */
  localScheduledByDay?: Readonly<Record<string, number>>;
  /** Tests build both readings of the cap question; the app uses `CATALOG`. */
  catalog?: Catalog;
}

export type LocalPlan =
  | { kind: 'skip'; reason: 'category_off' | 'capped' }
  | { kind: 'schedule'; at: number };

// ——— zoned time (the same arithmetic as push-sender's `_shared/push_policy.ts`) ———

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

function localParts(t: number, tz: string): LocalParts {
  const out: Record<string, number> = {};
  for (const p of formatter(tz).formatToParts(new Date(t))) {
    if (p.type !== 'literal') out[p.type] = Number(p.value);
  }
  // Some engines print midnight as 24 even under h23.
  const h = out.hour === 24 ? 0 : (out.hour as number);
  return { y: out.year as number, mo: out.month as number, d: out.day as number, h, mi: out.minute as number, s: out.second as number };
}

/** The zone's offset from UTC at instant `t`, in ms (local = utc + offset). */
function offsetAt(t: number, tz: string): number {
  const p = localParts(t, tz);
  const whole = Math.floor(t / 1000) * 1000;
  return Date.UTC(p.y, p.mo - 1, p.d, p.h, p.mi, p.s) - whole;
}

/**
 * The instant a local wall-clock time names in `tz`, tried under the offsets a day either side: a
 * time that exists is the answer (the later, for one that happens twice); a time in a
 * spring-forward gap resolves just past the gap.
 */
function zonedInstant(y: number, mo: number, d: number, h: number, mi: number, tz: string): number {
  const wall = Date.UTC(y, mo - 1, d, h, mi);
  const candidates = [...new Set([offsetAt(wall - DAY_MS, tz), offsetAt(wall + DAY_MS, tz)])].map(
    (o) => wall - o
  );
  const exact = candidates.filter((c) => {
    const p = localParts(c, tz);
    return p.y === y && p.mo === mo && p.d === d && p.h === h && p.mi === mi;
  });
  return Math.max(...(exact.length > 0 ? exact : candidates));
}

const minutesOf = (hhmm: string): number => {
  const [h, m] = hhmm.split(':').map(Number);
  return (h as number) * 60 + (m as number);
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

/** `YYYY-MM-DD` of instant `t` in `tz` (normalised: an unknown zone reads as UTC). */
export function localDay(t: number, tz: string): string {
  const p = localParts(t, normaliseZone(tz));
  return `${p.y}-${String(p.mo).padStart(2, '0')}-${String(p.d).padStart(2, '0')}`;
}

/** Whether local minute-of-day `m` falls in [start, end), crossing midnight when start > end. */
function inSpan(m: number, start: number, end: number): boolean {
  return start < end ? m >= start && m < end : m >= start || m < end;
}

/** Quiet hours at instant `t` in `tz` (start inclusive, end exclusive; off when disabled or start = end). */
export function inQuietHours(t: number, tz: string, quiet: QuietHours): boolean {
  if (!quiet.enabled || quiet.start === quiet.end) return false;
  const p = localParts(t, normaliseZone(tz));
  return inSpan(p.h * 60 + p.mi, minutesOf(quiet.start), minutesOf(quiet.end));
}

// ——— the plan ———

/**
 * When the drive summary may be shown, or why not. The category first; then the target
 * `max(now, endedAt + 120 s)`, moved to the quiet end when it falls inside quiet hours (DST-correct);
 * then the cap, counted on the day of that delivery: today's local and pushed counts for today, the
 * already-scheduled local count (and no pushes, which cannot have happened yet) for a later day.
 */
export function localDeliveryPlan(input: PlanInput): LocalPlan {
  const catalog = input.catalog ?? CATALOG;
  const entry = catalog[input.type];
  if (!input.prefs.categories[entry.category]) return { kind: 'skip', reason: 'category_off' };

  const tz = normaliseZone(input.tz);
  const target = Math.max(input.now, input.endedAt + SUMMARY_DELAY_MS);
  const at = inQuietHours(target, tz, input.prefs.quiet)
    ? nextLocalTime(target, tz, input.prefs.quiet.end)
    : target;

  if (countsTowardDailyCap(input.type, catalog)) {
    const day = localDay(at, tz);
    const today = localDay(input.now, tz);
    const counted =
      day === today
        ? input.localSentToday + input.serverPushedToday
        : (input.localScheduledByDay?.[day] ?? 0);
    if (counted >= DAILY_CAP.nonFamilyPerDay) return { kind: 'skip', reason: 'capped' };
  }
  return { kind: 'schedule', at };
}

// ——— the local count ———

type Settings = Pick<SettingsRepo, 'get' | 'set'>;

interface LedgerEntry {
  id: string;
  /** Epoch ms of delivery (the OS trigger time, or when it was shown). */
  at: number;
  /** `YYYY-MM-DD` of `at` in the user's zone when it was recorded. */
  day: string;
}

export interface DayCount {
  day: string;
  count: number;
}

const DAY_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

const isEntry = (v: unknown): v is LedgerEntry => {
  if (typeof v !== 'object' || v === null) return false;
  const e = v as Record<string, unknown>;
  return (
    typeof e.id === 'string' &&
    typeof e.at === 'number' &&
    Number.isFinite(e.at) &&
    typeof e.day === 'string' &&
    DAY_PATTERN.test(e.day)
  );
};

/**
 * The ledger for today and later. An unreadable or absent ledger starts from the exported
 * `LOCAL_SENT_KEY` when it names today (over-counting only holds a notification back).
 */
async function loadLedger(settings: Settings, today: string, now: number): Promise<LedgerEntry[]> {
  let raw: unknown = null;
  try {
    raw = await settings.get<unknown>(LOCAL_LEDGER_KEY);
  } catch {
    raw = null;
  }
  if (Array.isArray(raw)) return raw.filter(isEntry).filter((e) => e.day >= today);

  let exported: unknown = null;
  try {
    exported = await settings.get<unknown>(LOCAL_SENT_KEY);
  } catch {
    exported = null;
  }
  if (typeof exported !== 'object' || exported === null) return [];
  const { day, count } = exported as Record<string, unknown>;
  if (day !== today || typeof count !== 'number' || !Number.isInteger(count) || count <= 0) return [];
  return Array.from({ length: Math.min(count, LEDGER_MAX) }, (_, i) => ({
    id: `carried:${i}`,
    at: now,
    day: today,
  }));
}

const countOn = (ledger: readonly LedgerEntry[], day: string): number =>
  ledger.filter((e) => e.day === day).length;

async function store(settings: Settings, ledger: LedgerEntry[], today: string): Promise<DayCount> {
  const kept = ledger.filter((e) => e.day >= today).slice(-LEDGER_MAX);
  await settings.set(LOCAL_LEDGER_KEY, kept);
  const exported: DayCount = { day: today, count: countOn(kept, today) };
  await settings.set(LOCAL_SENT_KEY, exported);
  return exported;
}

export interface RecordOptions {
  /** The OS request's identifier, so a cancel can uncount it. Default: a fresh id. */
  id?: string;
  /** When it will be (or was) delivered; default `now`. It counts on this instant's local day. */
  at?: number;
  /** Default `trip_summary`, the only local type. */
  type?: NotificationType;
  catalog?: Catalog;
}

/**
 * Count a local notification that was shown or scheduled. Returns the count on its delivery day
 * (today for one shown now). A type the catalog exempts from the cap is not recorded; the day's
 * count is returned unchanged. Recording the same `id` again replaces it.
 */
export async function recordLocalSent(
  settings: Settings,
  tz: string,
  now: number,
  opts: RecordOptions = {}
): Promise<number> {
  const zone = normaliseZone(tz);
  const at = opts.at ?? now;
  const day = localDay(at, zone);
  const today = localDay(now, zone);
  const ledger = await loadLedger(settings, today, now);
  if (!countsTowardDailyCap(opts.type ?? 'trip_summary', opts.catalog ?? CATALOG)) {
    return countOn(ledger, day);
  }
  const id = opts.id ?? `shown:${now}:${ledger.length}`;
  const next = [...ledger.filter((e) => e.id !== id), { id, at, day }];
  await store(settings, next, today);
  return countOn(next, day);
}

/**
 * A scheduled notification was cancelled before it was delivered: take it off its day's count.
 * One already delivered (`at <= now`) stays counted. Returns whether anything was removed.
 */
export async function uncountLocalSent(
  settings: Settings,
  id: string,
  tz: string,
  now: number
): Promise<boolean> {
  const today = localDay(now, tz);
  const ledger = await loadLedger(settings, today, now);
  const next = ledger.filter((e) => !(e.id === id && e.at > now));
  if (next.length === ledger.length) return false;
  await store(settings, next, today);
  return true;
}

/**
 * Today's count, and the exported `LOCAL_SENT_KEY` brought up to date with it (a new day, or a
 * deferred delivery whose day has come).
 */
export async function readLocalSent(settings: Settings, tz: string, now: number): Promise<DayCount> {
  return (await readLocalCounts(settings, tz, now)).today;
}

/** Today's count, and every day's (today and later), for `localDeliveryPlan`. */
export async function readLocalCounts(
  settings: Settings,
  tz: string,
  now: number
): Promise<{ today: DayCount; byDay: Record<string, number> }> {
  const today = localDay(now, tz);
  const ledger = await loadLedger(settings, today, now);
  let exported: unknown = null;
  try {
    exported = await settings.get<unknown>(LOCAL_SENT_KEY);
  } catch {
    exported = null;
  }
  const current: DayCount = { day: today, count: countOn(ledger, today) };
  const same =
    typeof exported === 'object' &&
    exported !== null &&
    (exported as DayCount).day === current.day &&
    (exported as DayCount).count === current.count;
  if (!same) await store(settings, ledger, today);
  const byDay: Record<string, number> = {};
  for (const e of ledger) byDay[e.day] = (byDay[e.day] ?? 0) + 1;
  return { today: current, byDay };
}

// ——— effective preferences ———

/** The row's fields the effective preferences read (`notification_prefs`). */
export interface PrefsFields {
  categories: Readonly<Record<string, unknown>>;
  quiet_enabled: boolean | null;
  quiet_start: string | null;
  quiet_end: string | null;
}

const CLOCK = /^([01]\d|2[0-3]):([0-5]\d)(:[0-5]\d)?$/;

/** `HH:MM` from Postgres `time` (`22:00:00`) or `HH:MM`; null when malformed or absent. */
export function toClock(value: string | null | undefined): string | null {
  if (typeof value !== 'string' || !CLOCK.test(value)) return null;
  return value.slice(0, 5);
}

/** The row where it says something (a category missing is on), the config defaults elsewhere. */
export function effectivePrefs(row: PrefsFields | null, defaults: NotificationDefaults): EffectivePrefs {
  const categories = {} as Record<NotificationCategory, boolean>;
  for (const c of NOTIFICATION_CATEGORIES) {
    const v = row?.categories[c];
    categories[c] = typeof v === 'boolean' ? v : true;
  }
  return {
    categories,
    quiet: {
      enabled: row?.quiet_enabled ?? defaults.quiet_enabled,
      start: toClock(row?.quiet_start) ?? defaults.quiet_start,
      end: toClock(row?.quiet_end) ?? defaults.quiet_end,
    },
  };
}

const isPrefs = (v: unknown): v is EffectivePrefs => {
  if (typeof v !== 'object' || v === null) return false;
  const p = v as Record<string, unknown>;
  const cats = p.categories as Record<string, unknown> | undefined;
  const quiet = p.quiet as Record<string, unknown> | undefined;
  return (
    typeof cats === 'object' &&
    cats !== null &&
    NOTIFICATION_CATEGORIES.every((c) => typeof cats[c] === 'boolean') &&
    typeof quiet === 'object' &&
    quiet !== null &&
    typeof quiet.enabled === 'boolean' &&
    toClock(quiet.start as string) !== null &&
    toClock(quiet.end as string) !== null
  );
};

/** Store the effective preferences for the notifier to read offline. */
export async function writePrefsCache(settings: Settings, prefs: EffectivePrefs): Promise<void> {
  await settings.set(PREFS_CACHE_KEY, prefs);
}

/** The cached effective preferences; the defaults when there are none or they cannot be read. */
export async function readCachedPrefs(
  settings: Pick<SettingsRepo, 'get'>,
  defaults: NotificationDefaults
): Promise<EffectivePrefs> {
  try {
    const cached = await settings.get<unknown>(PREFS_CACHE_KEY);
    if (isPrefs(cached)) return cached;
  } catch {
    // unreadable is the same as absent
  }
  return effectivePrefs(null, defaults);
}

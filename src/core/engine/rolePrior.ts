// The evidence about who drives that the device keeps between drives (spec §9.7, plan R11).
//
// Two settings, both trained only by the driver's own answers (C10 / D5, `roleActions.ts`):
//   - `role.prior` — how often this user's answers said "I drove", as a Laplace-smoothed share;
//   - `role.routes` — per start/end pair of geohash-5 cells, how often each answer came up there,
//     so a route the teen has confirmed driving stops asking.
// The finalizer reads neither: the host reads them before it calls `finalizeTrip` and passes the
// result in `FinalizeDeps` (`rolePrior`, `habitualRoute`), so the finalize stays one pass over
// its own inputs. Both live in `settings`, which the device-owner handover wipes, so a prior never
// crosses from one account to the next.
//
// `longestHandlingRunMinutes` is the one piece of trip evidence the inference reads from the rows
// (§9.7 "continuous screen-on handling for minutes"): the longest single stretch, never a sum, so
// a driver who glances at the phone three times is not read as a passenger (rev1 C1).
import { CONSTANTS } from '@scoring';
import { knownSpeed, ROW_MS } from '@/core/detectors/common';
import { createSettingsRepo, type Db } from '@/data/db';
import type { DetectedEvent, FeatureRow } from './types';

/** `{ driverAnswers: number; answers: number }` */
export const ROLE_PRIOR_KEY = 'role.prior';
/** `Record<routeKey, { driver: number; other: number }>`, at most `ROLE_ROUTES_MAX` keys. */
export const ROLE_ROUTES_KEY = 'role.routes';
/** Driver answers a route needs before it counts as habitual (and more than the other answers). */
export const HABITUAL_MIN_CONFIRMATIONS = 2;
/**
 * Routes kept; past this the route answered longest ago goes (LRU by last answer). The object's
 * key order is the recency order: an answered route is re-inserted at the end.
 */
export const ROLE_ROUTES_MAX = 200;

/** A row counts toward a handling run from this handling score up (§9.7). */
export const HANDLING_SCORE_MIN = 0.6;
/** Rows further apart than this are not consecutive: rows are missing between them. */
const MAX_ROW_GAP_MS = 2 * ROW_MS;
const HARSH: ReadonlySet<DetectedEvent['category']> = new Set(['braking', 'accel', 'cornering']);

export interface RolePriorCounts {
  driverAnswers: number;
  answers: number;
}

export type RouteCounts = Record<string, { driver: number; other: number }>;

/**
 * The route a trip belongs to: its start and end geohash-5 cells as an unordered pair, so the
 * drive to school and the drive home are one route.
 *
 * TUNING-SENSITIVE (ruling N-m5): a geohash-5 cell is roughly 5 km across, so a teen's own school
 * run and the same run a parent drives share a key, as do two different routes between the same
 * two neighbourhoods. The `driver > other` rule in `isHabitualDriverRoute` keeps a shared route
 * from counting once the other answers catch up; a finer cell would split them but needs more
 * answers per route before any of them becomes habitual.
 */
export const routeKey = (startGeohash5: string, endGeohash5: string): string =>
  startGeohash5 <= endGeohash5
    ? `${startGeohash5}|${endGeohash5}`
    : `${endGeohash5}|${startGeohash5}`;

const count = (v: unknown): number | null =>
  typeof v === 'number' && Number.isInteger(v) && v >= 0 ? v : null;

/** The stored counts, or zero answers when nothing sane is stored. */
async function readCounts(db: Db): Promise<RolePriorCounts> {
  const stored = await createSettingsRepo(db).get<Partial<RolePriorCounts>>(ROLE_PRIOR_KEY);
  const driverAnswers = count(stored?.driverAnswers);
  const answers = count(stored?.answers);
  if (driverAnswers === null || answers === null || driverAnswers > answers) {
    return { driverAnswers: 0, answers: 0 };
  }
  return { driverAnswers, answers };
}

async function readRoutes(db: Db): Promise<RouteCounts> {
  const stored = await createSettingsRepo(db).get<unknown>(ROLE_ROUTES_KEY);
  return stored !== null && typeof stored === 'object' && !Array.isArray(stored)
    ? (stored as RouteCounts)
    : {};
}

/** P(driver) before this trip's evidence: `(driverAnswers + 1) / (answers + 2)`, 0.5 with no answers. */
export async function readRolePrior(db: Db): Promise<number> {
  const { driverAnswers, answers } = await readCounts(db);
  return (driverAnswers + 1) / (answers + 2);
}

/**
 * The route between these cells has been confirmed as driven by this user at least
 * `HABITUAL_MIN_CONFIRMATIONS` times, and more often than not. False when either end is unknown.
 */
export async function isHabitualDriverRoute(
  db: Db,
  start: string | null,
  end: string | null
): Promise<boolean> {
  if (start === null || end === null) return false;
  const entry = (await readRoutes(db))[routeKey(start, end)];
  if (!entry) return false;
  const driver = count(entry.driver) ?? 0;
  const other = count(entry.other) ?? 0;
  return driver >= HABITUAL_MIN_CONFIRMATIONS && driver > other;
}

/**
 * Train both on one answer. `passenger` and `other` (transit) both count as "not driving". A trip
 * with either geohash unknown trains the prior only. Pass the transaction the answer is written
 * in, so the answer and what it taught commit together.
 */
export async function recordRoleAnswer(
  db: Db,
  role: 'driver' | 'passenger' | 'other',
  route: { start: string | null; end: string | null }
): Promise<void> {
  const settings = createSettingsRepo(db);
  const drove = role === 'driver';

  const prior = await readCounts(db);
  await settings.set(ROLE_PRIOR_KEY, {
    driverAnswers: prior.driverAnswers + (drove ? 1 : 0),
    answers: prior.answers + 1,
  } satisfies RolePriorCounts);

  if (route.start === null || route.end === null) return;
  const key = routeKey(route.start, route.end);
  const routes = await readRoutes(db);
  const was = routes[key];
  const next = {
    driver: (count(was?.driver) ?? 0) + (drove ? 1 : 0),
    other: (count(was?.other) ?? 0) + (drove ? 0 : 1),
  };
  // Re-insert at the end: key order is recency order.
  delete routes[key];
  routes[key] = next;
  const keys = Object.keys(routes);
  for (const stale of keys.slice(0, Math.max(0, keys.length - ROLE_ROUTES_MAX))) delete routes[stale];
  await settings.set(ROLE_ROUTES_KEY, routes);
}

/** A row the phone was being held and used on while the car moved. */
const handlingRow = (r: FeatureRow): boolean => {
  const speed = knownSpeed(r);
  return (
    r.handlingScore >= HANDLING_SCORE_MIN &&
    r.screenOn &&
    !r.locked &&
    speed !== null &&
    speed >= CONSTANTS.LOCKOUT_SPEED_MPS
  );
};

/**
 * The longest single stretch of consecutive rows with `handlingScore ≥ 0.6`, the screen on and
 * unlocked, at moving speed (at or above `LOCKOUT_SPEED_MPS`, the phone detector's moving line),
 * in minutes. A row inside a harsh event (braking, acceleration, cornering) ends the stretch: a
 * phone flung about by a manoeuvre is not a passenger scrolling. Missing rows end it too. One
 * continuous run, never a sum of runs (rev1 C1).
 */
export function longestHandlingRunMinutes(
  rows: readonly FeatureRow[],
  events: readonly DetectedEvent[]
): number {
  const harsh = events
    .filter((e) => HARSH.has(e.category))
    .map((e) => [e.startedAt, e.startedAt + Math.max(1, e.durationS) * 1000] as const);
  const inHarsh = (ts: number): boolean => harsh.some(([from, to]) => ts >= from && ts < to);

  let longest = 0;
  let run = 0;
  let prevTs: number | null = null;
  for (const r of rows) {
    const consecutive = prevTs !== null && r.ts - prevTs <= MAX_ROW_GAP_MS;
    prevTs = r.ts;
    if (!handlingRow(r) || inHarsh(r.ts)) {
      run = 0;
      continue;
    }
    run = consecutive ? run + 1 : 1;
    longest = Math.max(longest, run);
  }
  return (longest * ROW_MS) / 60_000;
}

/**
 * Restoring a driver's history from the server (M3 plan R10; M2 final review, M3 note 1).
 *
 * Every screen reads local SQLite and nothing else. Since M2, a device that changes hands is
 * wiped (correctly, on privacy grounds), and a reinstall starts empty — so without this the
 * driver's whole history is gone from their point of view while the server holds all of it. The
 * hydrator reads it back: `trips`, `trip_events`, `event_disputes`, `score_daily` and `baselines`,
 * over the owner-only `select` policies migration 0002 already grants. No server function, no new
 * privilege: the client reads exactly what RLS lets the signed-in user read, and additionally
 * filters every request on its own uid.
 *
 * **What it must never undo** (the M2 guarantees):
 * 1. *A deleted drive does not come back.* The server hides a soft-deleted trip from its owner
 *    (`deleted_at is null` in the policy, and in every request here). On the device, a trip whose
 *    row carries `deleted_at`, or whose `delete:<id>` queue item exists in any state, is never
 *    written — the item is the tombstone for the day the settled row survives.
 * 2. *A device that changed hands never receives the previous driver's data.* A run starts only
 *    when the session user is the device's recorded owner; after every await the generation and
 *    the session are checked again; and every commit asserts, inside its own transaction, that the
 *    device still records that owner. The wipe rewrites that record, so a page fetched for the
 *    previous owner writes nothing into the next owner's database.
 * 3. *Local work still owed to the server wins.* A server trip is skipped when the local row is
 *    `local | queued | uploading | failed`, is deleted or still recording, or has a `pending |
 *    inflight` queue item (its finalize, trace, role change, delete, or a report on one of its
 *    events); also when the local row changed after the page was requested — the runner applied
 *    a fresher answer in between.
 *
 * **Additive, and a delete made elsewhere is mirrored** (security review D1 I-1, amending plan
 * R10). Restoring puts a copy of every drive on every device the account signs in on, so a drive
 * deleted on one device must also leave the others. After a complete restore run, and at most once
 * a day otherwise, the device reads the ids of the user's live server trips (ids only, under RLS)
 * and — **only when that listing reached its end** — removes every local *synced* drive missing
 * from it, exactly as a local delete removes it (row, events, samples, trace file) but with
 * nothing queued. A drive with local work pending, still recording, or changed locally after the
 * listing began, is never removed.
 *
 * **A delete this device made is never undone by a restore** (M-2). A server trip this device
 * holds a tombstone for (`trips.deletedIds`, kept for the life of the install) or a settled
 * `delete:` item for is skipped — and, since the server evidently still has it, the delete is
 * sent again.
 *
 * **Paging (review I19).** Trips are read in keyset order on `(updated_at, id)` — `updated_at`
 * alone would drop the rest of a tie group that straddles a page boundary, and `touch_updated_at`
 * stamps every row of one statement with the same transaction time. The cursor is the last row's
 * pair, kept exactly as the server wrote it, and it moves only after the page has committed.
 * Known limitation (review D1 N4): `updated_at` is the transaction's start time, so an update
 * whose transaction commits after a later-stamped one can fall behind a cursor that has already
 * passed it. The self-heal covers a trip missing here, not a stale copy; for one user's write rate
 * and a 6-hour cadence the window is milliseconds, and the next change to that trip re-stamps it.
 * Every
 * run — full or not — resumes from it (review D1 I1): the wipe clears it and a first sign-in has
 * none, so a cursor that exists is this owner's and names committed pages, and an interrupted
 * restore continues where it stopped rather than from page one. A page whose last row does not
 * strictly advance the cursor ends the run (M-5), so a misbehaving response cannot loop. Each
 * page's events and disputes are fetched with `in(...)` (chunked at 100 ids): three requests per
 * page, not two per trip. `score_daily` and `baselines` are read once per run.
 *
 * **Never while the engine is busy.** A commit competes for SQLite's one write lock with the 1 Hz
 * recorder; `isBusy()` is asked before every commit, and a busy engine ends the run where it is
 * (the cursor already names the last committed page, so the next run resumes there).
 */
import type { Db } from '@/data/db/driver';
import { createSettingsRepo } from '@/data/db/settings';
import { addTombstone, readTombstones } from '@/data/db/tombstones';
import { emitDataChanged } from '@/data/events';
import { forgetRoleAnswer } from '@/core/engine/rolePrior';
import { appBuildId } from '@/data/hydrate/build';
import { setHydrationStatus } from '@/data/hydrate/status';
import { BASELINE_SETTING_KEY } from '@/data/queries/hooks';
import { CLIENT_TRIP_ID, deviceOwnerIs } from '@/data/sync/queue';

import {
  BASELINE_COLUMNS,
  DAY_COLUMNS,
  DISPUTE_COLUMNS,
  EVENT_COLUMNS,
  isUuid,
  parseRow,
  ServerBaselineSchema,
  ServerDaySchema,
  ServerDisputeSchema,
  ServerEventSchema,
  ServerTripSchema,
  TimestampText,
  toDayRow,
  toDisputeRecord,
  toEventRow,
  toStoredBaseline,
  parseTimestamp,
  toTripFields,
  TRIP_COLUMNS,
  type ServerDispute,
  type ServerEvent,
  type ServerTrip,
} from './map';

/** Settings key: where incremental runs resume — the last committed trip's `(updated_at, id)`. */
export const HYDRATE_CURSOR_KEY = 'hydrate.cursor';
/** Settings key: the newest `score_daily.updated_at` restored, for the incremental day top-up. */
export const HYDRATE_DAYS_CURSOR_KEY = 'hydrate.daysCursor';
/**
 * Settings key: when a full restore last reached the end (epoch ms). Absent on a device that has
 * never completed one — which is what makes the next foreground owe a full run. The wipe clears it.
 */
export const HYDRATE_RESTORED_AT_KEY = 'hydrate.restoredAt';
/** Settings key: when the live-id reconciliation last completed (epoch ms). */
export const HYDRATE_RECONCILED_AT_KEY = 'hydrate.reconciledAt';
/**
 * Settings key: live server trips this build could not read, `{ version, build, ids: { id:
 * firstSeenMs } }`, so the daily self-heal does not fetch and fail on the same row for ever
 * (review D1 N2). Three things release an entry, so a forgotten step can never hide a live drive
 * for good (security R3-M1):
 * - a different app build (`appBuildId`: the native line and the running update);
 * - `UNREADABLE_VERSION` moving — it must whenever `ServerTripSchema` changes, and a test holds
 *   the schema's shape to the version;
 * - age: an entry older than `UNREADABLE_TTL_MS` is retried.
 */
export const HYDRATE_UNREADABLE_KEY = 'hydrate.unreadable';
export const UNREADABLE_VERSION = 1;
export const UNREADABLE_TTL_MS = 30 * 24 * 3600 * 1000;
/** At most once a day outside a full restore: one narrow listing of ids. */
export const RECONCILE_INTERVAL_MS = 24 * 3600 * 1000;
/** Ids per reconciliation request; each is ~40 bytes on the wire. */
export const RECONCILE_LIMIT = 1000;
/**
 * A restore announces what it wrote every this many committed pages (and once at the end), not
 * after every page: each announcement refetches every mounted query (review D1 I2). Progress for
 * the "Restoring…" slot goes through the status store, which costs nothing.
 */
export const EMIT_EVERY_PAGES = 5;
/** How often the foreground top-up may run (H2 registers it with `runWhenForeground`). */
export const HYDRATE_INTERVAL_MS = 6 * 3600 * 1000;
/** Trips per page. Small enough that one page's events fit well inside PostgREST's row cap. */
export const DEFAULT_PAGE_SIZE = 50;
/** Ids per `in(...)` filter: keeps the request URL a few kilobytes long. */
export const IN_CHUNK = 100;
/**
 * Rows per events or disputes request. PostgREST caps a response (1000 by default on Supabase)
 * without saying so, so a chunk that fills this is read again from its last id rather than
 * trusted to be complete.
 */
export const CHILD_LIMIT = 1000;
/** Newest day rows a run reads; ~3 years of daily driving, more than any screen looks back. */
export const DAY_LIMIT = 1000;

export interface HydrateCursor {
  updatedAt: string;
  id: string;
}

export interface HydrateResult {
  /** Trips written (inserted or refreshed). */
  trips: number;
  events: number;
  days: number;
  /** Server trips left alone because the device holds newer or unfinished work for them. */
  skippedLocal: number;
  /** Local synced drives removed because the server no longer holds them live (I-1). */
  removed: number;
  /** Deletes this device made that the server had not applied, sent again (M-2). */
  redeleted: number;
  /** Live drives missing here, fetched again by the reconciliation's self-heal (R-I1). */
  refetched: number;
  /** The server's baseline medians were stored. */
  baseline: boolean;
  /** The run reached the end of the server's rows; false when it stopped early for any reason. */
  complete: boolean;
}

export interface Hydrator {
  run(opts: { full: boolean }): Promise<HydrateResult>;
  /** Ends this hydrator's lifetime; settles when a run in flight has stopped. Nothing it fetched is written after this returns. */
  stop(): Promise<void>;
}

/** What one PostgREST request answers. */
export interface HydrateResponse {
  data: unknown[] | null;
  error: unknown;
}

/**
 * The PostgREST filter builder, narrowed to the calls the restore makes. Structural, so the real
 * client fits and a test double needs nothing else.
 */
export interface HydrateQuery extends PromiseLike<HydrateResponse> {
  eq(column: string, value: string): HydrateQuery;
  is(column: string, value: null): HydrateQuery;
  in(column: string, values: readonly string[]): HydrateQuery;
  or(filters: string): HydrateQuery;
  gt(column: string, value: string): HydrateQuery;
  gte(column: string, value: string): HydrateQuery;
  order(column: string, options?: { ascending?: boolean }): HydrateQuery;
  limit(count: number): HydrateQuery;
}

export type HydrateTable = 'trips' | 'trip_events' | 'event_disputes' | 'score_daily' | 'baselines';

export interface HydrateSupabase {
  auth: {
    getSession(): Promise<{ data: { session: { user: { id: string } } | null } }>;
    /**
     * Optional: when present, a run caches its uid and learns of a session change from here
     * instead of re-reading the session (a Keychain read) after every await (review D1 M2).
     */
    onAuthStateChange?(
      callback: (event: string, session: { user: { id: string } } | null) => void
    ): { data: { subscription: { unsubscribe(): void } } };
  };
  from(table: HydrateTable): { select(columns: string): HydrateQuery };
}

/**
 * The minimum the real client offers: `auth` and a `from(table).select(columns)` whose result is a
 * PostgREST builder. Deliberately untyped past that point — see `hydrateSeam`.
 */
export interface PostgrestClientLike {
  auth: HydrateSupabase['auth'];
  from(table: HydrateTable): { select(columns: string): unknown };
}

/**
 * The app client, narrowed to the hydrator's seam.
 *
 * The generated client resolves every `select`/`eq`/`in` against the schema's types, which the
 * structural seam cannot spell (TypeScript gives up instantiating the select-string parser for an
 * arbitrary `string`). The builder `select` returns at runtime is exactly the thenable filter
 * builder `HydrateQuery` describes; `hydrate.test.ts` builds one from the real `supabase-js` client
 * and checks both the methods and the request it encodes.
 */
export function hydrateSeam(client: PostgrestClientLike): HydrateSupabase {
  return {
    auth: client.auth,
    from: (table) => ({
      select: (columns) => client.from(table).select(columns) as HydrateQuery,
    }),
  };
}

export interface HydratorDeps {
  db: Db;
  supabase: HydrateSupabase;
  now: () => number;
  /** True while the engine is recording or finalizing: nothing is committed then. */
  isBusy: () => boolean;
  pageSize?: number;
  onError?: (e: unknown, ctx: string) => void;
  /** The traces directory, so a drive removed by reconciliation loses its file too. */
  fs?: { remove(path: string): Promise<void> };
  /** Which app build is running. Default: `appBuildId` (expo-updates, guarded). */
  buildId?: () => Promise<string>;
}

/**
 * One run's fence. `quick` is asked after every await: the lifetime unchanged and no session
 * change announced (or, with no announcer to listen to, a fresh session read). `thorough` is asked
 * before every commit and always re-reads the session.
 */
interface Fence {
  quick(): Promise<void>;
  thorough(): Promise<void>;
  close(): void;
}

/** Thrown to end a run quietly: the device changed hands, the hydrator stopped, or the engine is busy. */
class Halt extends Error {
  constructor(readonly why: 'fenced' | 'busy') {
    super(`hydration halted: ${why}`);
    this.name = 'Halt';
  }
}

/** A request PostgREST answered with an error. */
export class HydrateRequestError extends Error {
  constructor(
    readonly table: HydrateTable,
    readonly reason: unknown
  ) {
    super(`hydration request to ${table} failed`);
    this.name = 'HydrateRequestError';
  }
}

const emptyResult = (): HydrateResult => ({
  trips: 0,
  events: 0,
  days: 0,
  skippedLocal: 0,
  removed: 0,
  redeleted: 0,
  refetched: 0,
  baseline: false,
  complete: false,
});

/** Whether cursor `next` is strictly after `prev` in `(updated_at, id)` order. */
export function cursorAdvances(prev: HydrateCursor | null, next: HydrateCursor): boolean {
  if (prev === null) return true;
  if (next.updatedAt !== prev.updatedAt) {
    const a = parseTimestamp(next.updatedAt);
    const b = parseTimestamp(prev.updatedAt);
    if (a === null || b === null) return false;
    if (a !== b) return a > b;
    // Same millisecond, different text: compare what lies past it (the server's microseconds).
    const micros = (t: string) => (/\.(\d+)/.exec(t)?.[1] ?? '').padEnd(9, '0').slice(3);
    const x = micros(next.updatedAt);
    const y = micros(prev.updatedAt);
    if (x !== y) return x > y;
  }
  return next.id > prev.id;
}

function chunks<T>(items: readonly T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}

/** A stored cursor, or null when there is none or it is not one this build wrote. */
function readCursor(value: unknown): HydrateCursor | null {
  if (typeof value !== 'object' || value === null) return null;
  const { updatedAt, id } = value as Record<string, unknown>;
  if (typeof updatedAt !== 'string' || typeof id !== 'string') return null;
  // Both values are interpolated into a PostgREST filter: only a timestamp and a uuid may pass.
  if (!TimestampText.safeParse(updatedAt).success || !isUuid(id)) return null;
  return { updatedAt, id };
}

/** Queue items still owed, and the trips they concern. */
const PENDING_ITEMS_SQL =
  "SELECT kind, payload_json FROM sync_queue WHERE status IN ('pending', 'inflight')";

/** Trip ids named by pending work, resolved on `tx` so the check and the write agree. */
async function tripsWithPendingWork(tx: Db): Promise<Set<string>> {
  const ids = new Set<string>();
  const eventIds: string[] = [];
  const { rows } = await tx.execute(PENDING_ITEMS_SQL);
  for (const row of rows) {
    let body: unknown;
    try {
      body = JSON.parse(String(row.payload_json));
    } catch {
      continue;
    }
    if (typeof body !== 'object' || body === null) continue;
    const { clientTripId, clientEventId } = body as Record<string, unknown>;
    if (typeof clientTripId === 'string') ids.add(clientTripId);
    if (typeof clientEventId === 'string') eventIds.push(clientEventId);
  }
  for (const group of chunks(eventIds, IN_CHUNK)) {
    const marks = group.map(() => '?').join(',');
    const found = await tx.execute(
      `SELECT DISTINCT client_trip_id FROM trip_events WHERE id IN (${marks})`,
      group
    );
    for (const row of found.rows) ids.add(String(row.client_trip_id));
  }
  return ids;
}

export function createHydrator(deps: HydratorDeps): Hydrator {
  const { db, supabase, now, isBusy } = deps;
  const pageSize = Math.max(1, deps.pageSize ?? DEFAULT_PAGE_SIZE);
  const report = (error: unknown, context: string): void => deps.onError?.(error, context);
  const settings = createSettingsRepo(db);

  let generation = 0;
  /** A stopped hydrator stays stopped: its runtime is being torn down. */
  let stopped = false;
  let inFlight: Promise<HydrateResult> | null = null;

  async function sessionUid(): Promise<string | null> {
    const { data } = await supabase.auth.getSession();
    return data.session?.user.id ?? null;
  }

  /**
   * One run's fence: the hydrator still in the lifetime the run began in, and the session still
   * the user it began for.
   */
  function fenceFor(of: number, uid: string): Fence {
    let changed = false;
    let close = (): void => {};
    const listen = supabase.auth.onAuthStateChange;
    if (listen) {
      const { data } = listen.call(supabase.auth, (_event, session) => {
        if ((session?.user.id ?? null) !== uid) changed = true;
      });
      close = () => data.subscription.unsubscribe();
    }
    const thorough = async (): Promise<void> => {
      if (of !== generation || changed) throw new Halt('fenced');
      const current = await sessionUid();
      if (of !== generation || changed || current !== uid) throw new Halt('fenced');
    };
    return {
      async quick() {
        if (of !== generation || changed) throw new Halt('fenced');
        if (!listen) await thorough();
      },
      thorough,
      close,
    };
  }

  async function request(table: HydrateTable, query: HydrateQuery): Promise<unknown[]> {
    const { data, error } = await query;
    if (error) throw new HydrateRequestError(table, error);
    return Array.isArray(data) ? data : [];
  }

  /**
   * A commit behind every fence: the engine idle, the lifetime and session unchanged, and — inside
   * the transaction — the device still recording this owner.
   */
  async function commit(fence: Fence, uid: string, fn: (tx: Db) => Promise<void>): Promise<void> {
    if (isBusy()) throw new Halt('busy');
    await fence.thorough();
    await db.transaction(async (tx) => {
      if (!(await deviceOwnerIs(tx, uid))) throw new Halt('fenced');
      await fn(tx);
    });
  }

  /**
   * Every row of `table` whose `column` is in `ids`, read in bounded, id-ordered requests.
   *
   * Paging on `orderBy` with `gt` is exact only while that column is unique within the result:
   * `trip_events.id` is the primary key, and `event_disputes.event_id` is `unique (event_id)`
   * (0002_trips.sql). If a later schema allowed several reports per event, the disputes read must
   * page on the dispute's own id instead, or rows sharing an `event_id` at a page boundary are
   * lost (review D1 M3).
   */
  async function fetchChildren(
    table: 'trip_events' | 'event_disputes',
    columns: string,
    column: string,
    ids: readonly string[],
    uid: string,
    orderBy: string,
    fence: Fence
  ): Promise<unknown[]> {
    const out: unknown[] = [];
    for (const group of chunks(ids, IN_CHUNK)) {
      let after: string | null = null;
      for (;;) {
        let query = supabase
          .from(table)
          .select(columns)
          .eq('user_id', uid)
          .in(column, group);
        if (after !== null) query = query.gt(orderBy, after);
        const rows = await request(table, query.order(orderBy).limit(CHILD_LIMIT));
        await fence.quick();
        out.push(...rows);
        if (rows.length < CHILD_LIMIT) break;
        const last = rows[rows.length - 1] as Record<string, unknown> | undefined;
        const next = typeof last?.[orderBy] === 'string' ? (last[orderBy] as string) : null;
        if (next === null || !isUuid(next) || next === after) break;
        after = next;
      }
    }
    return out;
  }

  /** The day rows and the baseline, read once and written in one transaction. */
  async function restoreDaysAndBaseline(
    full: boolean,
    uid: string,
    startedAt: number,
    fence: Fence,
    result: HydrateResult
  ): Promise<void> {
    const since = full ? null : await settings.get<unknown>(HYDRATE_DAYS_CURSOR_KEY);
    const sinceText =
      typeof since === 'string' && TimestampText.safeParse(since).success ? since : null;
    await fence.quick();

    let daysQuery = supabase.from('score_daily').select(DAY_COLUMNS).eq('user_id', uid);
    daysQuery =
      sinceText === null
        ? daysQuery.order('day', { ascending: false }).limit(DAY_LIMIT)
        : // `gte`, not `gt`: re-writing a day is idempotent, and a tie at the boundary is not lost.
          daysQuery.gte('updated_at', sinceText).order('updated_at').limit(DAY_LIMIT);
    const rawDays = await request('score_daily', daysQuery);
    await fence.quick();
    const rawBaselines = await request(
      'baselines',
      supabase.from('baselines').select(BASELINE_COLUMNS).eq('user_id', uid).limit(1)
    );
    await fence.quick();

    const days = rawDays.flatMap((raw) => {
      const parsed = parseRow(ServerDaySchema, raw);
      const row = parsed === null ? null : toDayRow(parsed);
      if (parsed === null || row === null) {
        report(new Error('unreadable score_daily row'), 'hydrate day');
        return [];
      }
      return [{ row, updatedAt: parsed.updated_at }];
    });
    const baselineRow = rawBaselines.length > 0 ? parseRow(ServerBaselineSchema, rawBaselines[0]) : null;
    const baseline = baselineRow === null ? null : toStoredBaseline(baselineRow);

    let newest = sinceText;
    for (const { updatedAt } of days) if (newest === null || updatedAt > newest) newest = updatedAt;

    await commit(fence, uid, async (tx) => {
      for (const { row } of days) {
        // A day the runner wrote after this run began is the server's newer word: keep it.
        const { rows } = await tx.execute(
          'SELECT updated_at FROM score_daily_cache WHERE day = ?',
          [row.day]
        );
        const local = rows[0]?.updated_at;
        if (typeof local === 'number' && local >= startedAt) continue;
        await tx.execute(
          'INSERT OR REPLACE INTO score_daily_cache (day, payload_json, updated_at) VALUES (?, ?, ?)',
          [row.day, JSON.stringify(row), now()]
        );
        result.days += 1;
      }
      if (baseline !== null) {
        await tx.execute('INSERT OR REPLACE INTO settings (key, value_json) VALUES (?, ?)', [
          BASELINE_SETTING_KEY,
          JSON.stringify(baseline),
        ]);
        result.baseline = true;
      }
      if (newest !== null) {
        await tx.execute('INSERT OR REPLACE INTO settings (key, value_json) VALUES (?, ?)', [
          HYDRATE_DAYS_CURSOR_KEY,
          JSON.stringify(newest),
        ]);
      }
    });
  }

  /**
   * What to do with one server trip: write it, leave it (local work wins), or send again a delete
   * this device made that the server has not applied.
   */
  async function decide(
    tx: Db,
    trip: ServerTrip,
    pending: ReadonlySet<string>,
    tombstones: ReadonlySet<string>,
    fetchedAt: number
  ): Promise<'write' | 'skip' | 'redelete'> {
    const id = trip.client_trip_id;
    if (pending.has(id)) return 'skip';
    const item = await tx.execute('SELECT status FROM sync_queue WHERE idempotency_key = ?', [
      `delete:${id}`,
    ]);
    const deleteStatus = item.rows[0]?.status;
    // A delete that gave up is the driver's to retry (the failed-delete banner): leave it be.
    if (deleteStatus === 'failed') return 'skip';
    // Settled here, or remembered by the tombstone after the item was purged — and yet the
    // server still has it live. Never write it back; send the delete again.
    if (deleteStatus === 'done' || tombstones.has(id)) return 'redelete';
    return (await localWins(tx, trip, fetchedAt)) ? 'skip' : 'write';
  }

  /** Whether the device's own row wins over the server's. */
  async function localWins(tx: Db, trip: ServerTrip, fetchedAt: number): Promise<boolean> {
    const id = trip.client_trip_id;
    const { rows } = await tx.execute(
      'SELECT sync_state, deleted_at, status, server_id, updated_at FROM trips WHERE client_trip_id = ?',
      [id]
    );
    const local = rows[0];
    if (!local) return false;
    if (local.deleted_at !== null && local.deleted_at !== undefined) return true;
    if (local.status === 'recording') return true;
    if (local.sync_state !== 'synced') return true;
    if (local.server_id !== null && local.server_id !== trip.id) return true;
    return typeof local.updated_at === 'number' && local.updated_at > fetchedAt;
  }

  /** Queue the delete again, owned by the restoring user; the tombstone is (re)recorded too. */
  async function redelete(tx: Db, clientTripId: string, uid: string): Promise<void> {
    const key = `delete:${clientTripId}`;
    const at = now();
    const reopened = await tx.execute(
      `UPDATE sync_queue
          SET status = 'pending', attempts = 0, next_attempt_at = ?, last_error = NULL,
              claimed_at = NULL, owner_uid = ?
        WHERE idempotency_key = ? AND status = 'done'`,
      [at, uid, key]
    );
    if (reopened.changes === 0) {
      await tx.execute(
        `INSERT OR IGNORE INTO sync_queue
           (kind, payload_json, idempotency_key, status, attempts, next_attempt_at, owner_uid, created_at)
         VALUES ('delete-trip', ?, ?, 'pending', 0, ?, ?, ?)`,
        [JSON.stringify({ action: 'delete', clientTripId }), key, at, uid, at]
      );
    }
    await addTombstone(tx, clientTripId);
  }

  /** Write one server trip and its events; the caller has already decided it may. */
  async function writeTrip(
    tx: Db,
    trip: ServerTrip,
    events: readonly ServerEvent[],
    disputes: ReadonlyMap<string, ServerDispute>,
    result: HydrateResult
  ): Promise<void> {
    const fields = toTripFields(trip);
    if (fields === null) {
      report(new Error('unreadable trip timestamps'), 'hydrate trip');
      return;
    }
    const at = now();
    const { rows } = await tx.execute(
      'SELECT start_label, end_label FROM trips WHERE client_trip_id = ?',
      [trip.client_trip_id]
    );
    const existing = rows[0];
    if (existing) {
      // Labels are the one thing the device may know that the server does not.
      const patch = {
        ...fields,
        start_label: fields.start_label ?? (existing.start_label as string | null) ?? null,
        end_label: fields.end_label ?? (existing.end_label as string | null) ?? null,
        updated_at: at,
      };
      const columns = Object.keys(patch);
      await tx.execute(
        `UPDATE trips SET ${columns.map((c) => `${c} = ?`).join(', ')} WHERE client_trip_id = ?`,
        [...columns.map((c) => (patch as Record<string, unknown>)[c]), trip.client_trip_id]
      );
    } else {
      const row = {
        client_trip_id: trip.client_trip_id,
        ...fields,
        checkpoint_ts: null,
        sync_error: null,
        deleted_at: null,
        created_at: at,
        updated_at: at,
      };
      const columns = Object.keys(row);
      await tx.execute(
        `INSERT INTO trips (${columns.join(', ')}) VALUES (${columns.map(() => '?').join(', ')})`,
        columns.map((c) => (row as Record<string, unknown>)[c])
      );
    }
    result.trips += 1;

    for (const event of events) {
      const serverDispute = disputes.get(event.id);
      const record = serverDispute === undefined ? null : toDisputeRecord(serverDispute);
      const row = toEventRow(event, trip.client_trip_id, record);
      if (row === null) {
        report(new Error('unreadable event timestamp'), 'hydrate event');
        continue;
      }
      // One statement: insert, or refresh an event this trip already holds. The WHERE keeps an id
      // that belongs to another local trip from ever being re-parented, and a report the server
      // never recorded (a closed window, a refusal) lives only here (carry-over 7), so it is kept
      // unless the server has a record of its own (review D1 M1).
      const { changes } = await tx.execute(
        `INSERT INTO trip_events (id, client_trip_id, category, started_at, duration_s, lat, lng,
           measured_json, severity, confidence, context_json, deduction, alert_shown, corrected,
           status, source, dispute_json)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET
           category = excluded.category, started_at = excluded.started_at,
           duration_s = excluded.duration_s, lat = excluded.lat, lng = excluded.lng,
           measured_json = excluded.measured_json, severity = excluded.severity,
           confidence = excluded.confidence, context_json = excluded.context_json,
           deduction = excluded.deduction, alert_shown = excluded.alert_shown,
           corrected = excluded.corrected, status = excluded.status, source = excluded.source,
           dispute_json = COALESCE(excluded.dispute_json, trip_events.dispute_json)
         WHERE trip_events.client_trip_id = excluded.client_trip_id`,
        [
          row.id,
          row.client_trip_id,
          row.category,
          row.started_at,
          row.duration_s,
          row.lat,
          row.lng,
          row.measured_json,
          row.severity,
          row.confidence,
          row.context_json,
          row.deduction,
          row.alert_shown,
          row.corrected,
          row.status,
          row.source,
          row.dispute_json,
        ]
      );
      if (changes === 0) continue;
      result.events += 1;
    }
  }

  /**
   * Parse one page of server trips, fetch its events and reports in bulk, and commit whatever
   * `decide` allows, together with `alsoInCommit` (the paging cursor, for the restore). Shared by
   * the paged restore and the reconciliation's re-fetch of live drives missing here.
   */
  async function applyPage(
    rawTrips: readonly unknown[],
    fetchedAt: number,
    uid: string,
    fence: Fence,
    result: HydrateResult,
    alsoInCommit?: (tx: Db) => Promise<void>
  ): Promise<void> {
    const trips: ServerTrip[] = [];
    const unreadable: string[] = [];
    for (const raw of rawTrips) {
      const parsed = parseRow(ServerTripSchema, raw);
      if (parsed !== null) {
        trips.push(parsed);
        continue;
      }
      report(new Error('unreadable trip row'), 'hydrate trip');
      const id = (raw as Record<string, unknown> | null)?.id;
      if (typeof id === 'string' && isUuid(id)) unreadable.push(id.toLowerCase());
    }

    const tripIds = trips.map((t) => t.id);
    const events: ServerEvent[] = [];
    for (const raw of await fetchChildren(
      'trip_events',
      EVENT_COLUMNS,
      'trip_id',
      tripIds,
      uid,
      'id',
      fence
    )) {
      const parsed = parseRow(ServerEventSchema, raw);
      if (parsed === null) report(new Error('unreadable event row'), 'hydrate event');
      else events.push(parsed);
    }
    const disputes = new Map<string, ServerDispute>();
    if (events.length > 0) {
      for (const raw of await fetchChildren(
        'event_disputes',
        DISPUTE_COLUMNS,
        'event_id',
        events.map((e) => e.id),
        uid,
        'event_id',
        fence
      )) {
        const parsed = parseRow(ServerDisputeSchema, raw);
        if (parsed === null) report(new Error('unreadable dispute row'), 'hydrate dispute');
        else disputes.set(parsed.event_id, parsed);
      }
    }
    const eventsByTrip = new Map<string, ServerEvent[]>();
    for (const event of events) {
      const list = eventsByTrip.get(event.trip_id) ?? [];
      list.push(event);
      eventsByTrip.set(event.trip_id, list);
    }

    const redeletedBefore = result.redeleted;
    await commit(fence, uid, async (tx) => {
      const pending = await tripsWithPendingWork(tx);
      const tombstones = await readTombstones(tx);
      for (const trip of trips) {
        const decision = await decide(tx, trip, pending, tombstones, fetchedAt);
        if (decision === 'write') {
          await writeTrip(tx, trip, eventsByTrip.get(trip.id) ?? [], disputes, result);
          continue;
        }
        result.skippedLocal += 1;
        if (decision === 'redelete') {
          await redelete(tx, trip.client_trip_id, uid);
          result.redeleted += 1;
        }
      }
      if (unreadable.length > 0) await rememberUnreadable(tx, unreadable);
      await alsoInCommit?.(tx);
    });
    // A re-sent delete wakes the runner, after the commit.
    if (result.redeleted > redeletedBefore) emitDataChanged({ source: 'enqueue' });
  }

  async function restoreTrips(
    full: boolean,
    uid: string,
    fence: Fence,
    result: HydrateResult,
    progress: () => void
  ): Promise<void> {
    // Always from the committed cursor, full run or not (review D1 I1).
    let cursor = readCursor(await settings.get<unknown>(HYDRATE_CURSOR_KEY));
    await fence.quick();
    let pagesSinceEmit = 0;
    const announce = (): void => {
      pagesSinceEmit = 0;
      emitDataChanged({ source: 'hydrate' }, (error) => report(error, 'data change listener'));
    };

    for (;;) {
      const fetchedAt = now();
      let query = supabase
        .from('trips')
        .select(TRIP_COLUMNS)
        .eq('user_id', uid)
        .is('deleted_at', null);
      if (cursor !== null) {
        query = query.or(
          `updated_at.gt.${cursor.updatedAt},and(updated_at.eq.${cursor.updatedAt},id.gt.${cursor.id})`
        );
      }
      const rawTrips = await request(
        'trips',
        query.order('updated_at').order('id').limit(pageSize)
      );
      await fence.quick();
      if (rawTrips.length === 0) {
        if (pagesSinceEmit > 0) announce();
        result.complete = true;
        return;
      }

      // The page's last row is where the next page starts, readable or not: a row this build
      // cannot parse must not hold the cursor back for ever.
      const lastRaw = rawTrips[rawTrips.length - 1] as Record<string, unknown>;
      const nextCursor = readCursor({ updatedAt: lastRaw.updated_at, id: lastRaw.id });
      if (nextCursor === null) throw new Error('hydration: the page ended on a row with no cursor');
      // A response that did not move past the cursor would be asked for again for ever (M-5).
      if (!cursorAdvances(cursor, nextCursor)) {
        throw new Error('hydration: the page did not advance the cursor');
      }

      const before = result.trips;
      await applyPage(rawTrips, fetchedAt, uid, fence, result, async (tx) => {
        await tx.execute('INSERT OR REPLACE INTO settings (key, value_json) VALUES (?, ?)', [
          HYDRATE_CURSOR_KEY,
          JSON.stringify(nextCursor),
        ]);
      });
      cursor = nextCursor;
      if (result.trips > before) {
        progress();
        pagesSinceEmit += 1;
        if (pagesSinceEmit >= EMIT_EVERY_PAGES) announce();
      }
      if (rawTrips.length < pageSize) {
        if (pagesSinceEmit > 0) announce();
        result.complete = true;
        return;
      }
    }
  }

  /**
   * Remove the local copies of drives deleted elsewhere (I-1), and bring back live drives missing
   * here (R-I1). Acts only on a complete listing of the user's live server trips; returns false
   * (and changes nothing) otherwise.
   *
   * **Complete means an empty page came back.** A short page is never taken as the end: PostgREST
   * caps a response at `max_rows` without saying so, and that cap is a dashboard setting that can
   * sit below `RECONCILE_LIMIT` — a listing that stopped at the first short page would judge
   * everything past the cap deleted (security re-audit R-I1). The cost is one empty request.
   * Every page must also be in strictly increasing id order, starting past the previous one; an
   * error, an unreadable row or an out-of-order page leaves the listing incomplete.
   */
  async function reconcile(uid: string, fence: Fence, result: HydrateResult): Promise<boolean> {
    const listedFrom = now();
    /** Live server id → its client id. */
    const live = new Map<string, string>();
    let after: string | null = null;
    for (;;) {
      let query = supabase
        .from('trips')
        .select('id,client_trip_id')
        .eq('user_id', uid)
        .is('deleted_at', null);
      if (after !== null) query = query.gt('id', after);
      const rows = await request('trips', query.order('id').limit(RECONCILE_LIMIT));
      await fence.quick();
      if (rows.length === 0) break;
      for (const raw of rows) {
        const { id, client_trip_id: clientId } = raw as Record<string, unknown>;
        // A row this build cannot read makes the listing untrustworthy: act on none of it.
        if (typeof id !== 'string' || !isUuid(id)) return false;
        if (typeof clientId !== 'string' || !CLIENT_TRIP_ID.test(clientId)) return false;
        const key = id.toLowerCase();
        // Out of order, or not past the previous page: the keyset was not honoured.
        if (after !== null && key <= after) return false;
        after = key;
        live.set(key, clientId);
      }
    }

    const removed: string[] = [];
    await commit(fence, uid, async (tx) => {
      const pending = await tripsWithPendingWork(tx);
      const { rows } = await tx.execute(
        `SELECT client_trip_id, server_id, updated_at FROM trips
          WHERE sync_state = 'synced' AND server_id IS NOT NULL AND deleted_at IS NULL
            AND status != 'recording'`
      );
      for (const row of rows) {
        const id = String(row.client_trip_id);
        if (live.has(String(row.server_id).toLowerCase())) continue;
        if (pending.has(id)) continue;
        // Written after the listing began — the runner just synced it: not ours to judge. Both
        // times are the device's clock; a clock jumping backwards mid-listing can defeat this,
        // and such a drive is then removed while live. The self-heal below (or the next pass)
        // re-fetches it from the server, but what only this device held — its labels, and any
        // report record the server never kept — is lost with it (re-audit R-M1).
        if (typeof row.updated_at === 'number' && row.updated_at > listedFrom) continue;
        // Exactly what a local delete destroys, with nothing queued: the server already did it.
        await tx.execute('DELETE FROM samples WHERE client_trip_id = ?', [id]);
        await tx.execute('DELETE FROM trip_events WHERE client_trip_id = ?', [id]);
        await tx.execute('DELETE FROM trips WHERE client_trip_id = ?', [id]);
        // Its role answer stops counting toward the prior, and its route key goes with it
        // (ruling E2 delete hook).
        await forgetRoleAnswer(tx, id);
        // A settled finalize body is the drive itself (its route); it goes too.
        await tx.execute(
          "DELETE FROM sync_queue WHERE idempotency_key IN (?, ?) AND status = 'done'",
          [`trip:${id}`, `trace:${id}`]
        );
        removed.push(id);
      }
    });
    result.removed += removed.length;
    for (const id of removed) {
      try {
        await deps.fs?.remove(`${id}.bin.gz`);
      } catch (error) {
        report(error, 'hydrate remove trace');
      }
    }
    if (removed.length > 0) {
      emitDataChanged({ source: 'hydrate' }, (error) => report(error, 'data change listener'));
    }

    // Self-heal: a live drive this device lacks — removed earlier by mistake, or behind the
    // restore cursor when it was missed — is fetched again through the ordinary restore path. A
    // drive this device deleted (tombstoned) is not fetched: the restore path re-sends its delete
    // when the paged restore meets it.
    const tombstones = await readTombstones(db);
    const { rows: localRows } = await db.execute(
      'SELECT client_trip_id, server_id FROM trips'
    );
    await fence.quick();
    const { rows: deleteItems } = await db.execute(
      "SELECT idempotency_key FROM sync_queue WHERE kind = 'delete-trip'"
    );
    await fence.quick();
    const heldServer = new Set(localRows.map((r) => String(r.server_id ?? '').toLowerCase()));
    const heldClient = new Set(localRows.map((r) => String(r.client_trip_id)));
    // A delete this device queued, in any state, is as good as a tombstone here.
    const deletedHere = new Set(
      deleteItems.map((r) => String(r.idempotency_key).replace(/^delete:/, ''))
    );
    const skipUnreadable = await readUnreadable(db);
    await fence.quick();
    const missing = [...live.entries()]
      .filter(([serverId, clientId]) => !heldServer.has(serverId) && !heldClient.has(clientId))
      .filter(([, clientId]) => !tombstones.has(clientId) && !deletedHere.has(clientId))
      .filter(([serverId]) => !skipUnreadable.has(serverId))
      .map(([serverId]) => serverId);
    const before = result.trips;
    for (const group of chunks(missing, pageSize)) {
      const fetchedAt = now();
      const rawTrips = await request(
        'trips',
        supabase
          .from('trips')
          .select(TRIP_COLUMNS)
          .eq('user_id', uid)
          .is('deleted_at', null)
          .in('id', group)
          .order('id')
          .limit(group.length)
      );
      await fence.quick();
      if (rawTrips.length > 0) await applyPage(rawTrips, fetchedAt, uid, fence, result);
    }
    result.refetched += result.trips - before;
    if (result.trips > before) {
      emitDataChanged({ source: 'hydrate' }, (error) => report(error, 'data change listener'));
    }

    // Recorded only now, after the self-heal too (security R2-M1, review N3): a pass cut short
    // anywhere above — a drive starting mid-heal included — is tried again at the next
    // opportunity, not a day later.
    await commit(fence, uid, async (tx) => {
      await tx.execute('INSERT OR REPLACE INTO settings (key, value_json) VALUES (?, ?)', [
        HYDRATE_RECONCILED_AT_KEY,
        JSON.stringify(now()),
      ]);
    });
    return true;
  }

  let build: Promise<string> | null = null;
  const currentBuild = (): Promise<string> => (build ??= (deps.buildId ?? appBuildId)());

  /**
   * The unreadable ids still held for this schema version and this build, each with when it was
   * first seen; entries past `UNREADABLE_TTL_MS` are dropped, so they are fetched again.
   */
  async function readUnreadable(on: Db): Promise<Map<string, number>> {
    const { rows } = await on.execute('SELECT value_json FROM settings WHERE key = ?', [
      HYDRATE_UNREADABLE_KEY,
    ]);
    const held = new Map<string, number>();
    try {
      const value = JSON.parse(String(rows[0]?.value_json ?? 'null')) as {
        version?: unknown;
        build?: unknown;
        ids?: unknown;
      } | null;
      if (value?.version !== UNREADABLE_VERSION || value.build !== (await currentBuild())) {
        return held;
      }
      if (typeof value.ids !== 'object' || value.ids === null || Array.isArray(value.ids)) return held;
      const at = now();
      for (const [id, seen] of Object.entries(value.ids as Record<string, unknown>)) {
        if (typeof seen === 'number' && at - seen < UNREADABLE_TTL_MS && seen <= at) held.set(id, seen);
      }
    } catch {
      // An unreadable record holds nothing back.
    }
    return held;
  }

  async function rememberUnreadable(tx: Db, ids: readonly string[]): Promise<void> {
    const held = await readUnreadable(tx);
    const at = now();
    for (const id of ids) if (!held.has(id)) held.set(id, at);
    await tx.execute('INSERT OR REPLACE INTO settings (key, value_json) VALUES (?, ?)', [
      HYDRATE_UNREADABLE_KEY,
      JSON.stringify({
        version: UNREADABLE_VERSION,
        build: await currentBuild(),
        ids: Object.fromEntries(held),
      }),
    ]);
  }

  /** Reconcile when due; a failure is reported and tried again later, never fails the restore. */
  async function reconcileIfDue(
    full: boolean,
    uid: string,
    fence: Fence,
    result: HydrateResult
  ): Promise<void> {
    const last = await settings.get<unknown>(HYDRATE_RECONCILED_AT_KEY);
    await fence.quick();
    const due =
      full || typeof last !== 'number' || now() - last >= RECONCILE_INTERVAL_MS || now() < last;
    if (!due) return;
    try {
      await reconcile(uid, fence, result);
    } catch (error) {
      if (!(error instanceof Halt)) report(error, 'hydrate reconcile');
    }
  }

  async function execute(full: boolean, of: number): Promise<HydrateResult> {
    const result = emptyResult();
    const startedAt = now();
    let fence: Fence | null = null;
    try {
      const uid = await sessionUid();
      // Only the device's own owner is ever restored into it: a session that is somebody else's
      // is a handover the host has not processed yet, and the rebuild will wipe first.
      if (of !== generation || uid === null || !(await deviceOwnerIs(db, uid))) {
        if (full && of === generation) setHydrationStatus({ state: 'failed', at: now() });
        return result;
      }
      fence = fenceFor(of, uid);
      await fence.thorough();

      if (full) setHydrationStatus({ state: 'restoring', restored: 0 });
      await restoreDaysAndBaseline(full, uid, startedAt, fence, result);
      if (result.days > 0 || result.baseline) {
        emitDataChanged({ source: 'hydrate' }, (error) => report(error, 'data change listener'));
      }
      await restoreTrips(full, uid, fence, result, () => {
        if (full && of === generation) {
          setHydrationStatus({ state: 'restoring', restored: result.trips });
        }
      });
      if (full) {
        // The marker that no full restore is owed any more, fenced like every other write.
        await commit(fence, uid, async (tx) => {
          await tx.execute('INSERT OR REPLACE INTO settings (key, value_json) VALUES (?, ?)', [
            HYDRATE_RESTORED_AT_KEY,
            JSON.stringify(now()),
          ]);
        });
        if (of === generation) setHydrationStatus({ state: 'idle' });
      }
      // After a complete restore run, and at most once a day otherwise.
      await reconcileIfDue(full, uid, fence, result);
      return result;
    } catch (error) {
      result.complete = false;
      if (error instanceof Halt) {
        // Busy: the restore is still owed and resumes at the next foreground. Fenced: this
        // hydrator's lifetime is over and a new one owns the status.
        if (full && of === generation) setHydrationStatus({ state: 'failed', at: now() });
        return result;
      }
      report(error, 'hydrate');
      if (full && of === generation) setHydrationStatus({ state: 'failed', at: now() });
      return result;
    } finally {
      fence?.close();
    }
  }

  return {
    run({ full }): Promise<HydrateResult> {
      // One run at a time: a second request while one is in flight joins it.
      if (inFlight !== null) return inFlight;
      if (stopped) return Promise.resolve(emptyResult());
      const of = generation;
      const running = execute(full, of).finally(() => {
        if (inFlight === running) inFlight = null;
      });
      inFlight = running;
      return running;
    },

    stop(): Promise<void> {
      stopped = true;
      generation += 1;
      // Whatever this lifetime was restoring is no longer anybody's; the next runtime says its own.
      setHydrationStatus({ state: 'idle' });
      const running = inFlight;
      return running === null ? Promise.resolve() : running.then(() => undefined);
    },
  };
}

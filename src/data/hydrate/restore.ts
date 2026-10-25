/**
 * Restoring the user's drives from the server (plan §5): a reinstall, a new device, a device that
 * changed hands, a sign-out that emptied the phone. `list_my_drives` pages newest first; every row
 * the device does not hold becomes a settled local drive (the server's result) with its events,
 * how it started, whether its "Not driving?" ran out and its counted chances to slip with its phone
 * seconds (absent: they are estimated at read, with none), and a drive the device already holds is
 * left as it is. From/to labels and the end note are not restored (they only ever lived on the old
 * device). An event of a type this build does not know is skipped; the drive is kept.
 *
 * A restore runs to the end once per owner: `RESTORED_AT_KEY` records `{ uid, at }` only after the
 * last page, so one cut short (offline, the app closed) starts again at the next try and fills
 * in what is still missing, and a drive recorded before the restore ran never stops it.
 *
 * Every page is written only while the device still belongs to the driver it was started for, and
 * only while `isCurrent` says the run is still wanted: a restore that outlives a sign-out or a
 * handover writes nothing more.
 */
import { clampExposure, watchedMiles, type EventType } from '@scoring';
import { z } from 'zod';

import { createEventsRepo, createSettingsRepo, createTripsRepo, type Db, type NewEvent, type NewTrip, type TripPatch } from '@/data/db';
import { emitDataChanged } from '@/data/events';
import { countEvents } from '@/data/queries/rows';
import { EVENT_TYPES, TIERS } from '@/data/sync/payload';
import { deviceOwnerIs } from '@/data/sync/queue';

export const RESTORE_PAGE = 50;
export const MAX_PAGES = 40;
/** Settings key: `{ uid, at }`, the driver whose restore last ran to the end and when. */
export const RESTORED_AT_KEY = 'restore.completedAt';

/** The restore stopped because the device or the session no longer belongs to its driver. */
export class RestoreAbandonedError extends Error {
  override readonly name = 'RestoreAbandonedError';

  constructor() {
    super('restore abandoned: the device no longer belongs to the driver it was started for');
  }
}

const ServerEvent = z.object({
  id: z.uuid(),
  /** Any string: an event of a type this build does not know is skipped, not the whole drive. */
  type: z.string(),
  tier: z.enum(TIERS),
  startedAt: z.number(),
  durationS: z.number(),
  lat: z.number().nullable().optional(),
  lng: z.number().nullable().optional(),
  measured: z.unknown().optional(),
  status: z.enum(['active', 'removed']).nullable().optional(),
  /** A settled report on this event, when the server sends it. */
  disputeStatus: z.enum(['accepted', 'rejected']).nullable().optional(),
});

/** A drive's counted chances to slip, as the server stores them; absent on an older server. */
const ServerExposure = z.object({
  slowdowns: z.number(),
  speedups: z.number(),
  turns: z.number(),
  limitS: z.number(),
  movingS: z.number(),
  /** Seconds at driving speed watched for phone use; a server before phone tracking sends none (0). */
  phoneS: z.number().nullable().optional(),
});

/** One `list_my_drives` row. Not strict: the server's extra keys (and a transition's legacy ones) are ignored. */
export const ServerDriveSchema = z.object({
  tripId: z.uuid(),
  clientTripId: z.uuid(),
  startedAt: z.number(),
  endedAt: z.number(),
  tz: z.string(),
  localDay: z.string().nullable().optional(),
  miles: z.number(),
  nightMiles: z.number(),
  durationS: z.number(),
  polyline: z.string().nullable(),
  scored: z.boolean(),
  reason: z.string().nullable(),
  notDriving: z.boolean(),
  clean: z.boolean().nullable(),
  /** How the drive started; an older server does not say (a Start tap). */
  origin: z.enum(['auto', 'manual']).default('manual'),
  /** The in-drive "Not driving?" ran out; an older server does not say (it never did). */
  notDrivingExpired: z.boolean().default(false),
  exposure: ServerExposure.nullable().optional(),
  /** The DashPal seconds (moving, and of those watched); absent from a server before 0020. */
  dashcamMovingS: z.number().nullable().optional(),
  dashcamCoveredS: z.number().nullable().optional(),
  result: z.unknown().optional(),
  events: z.array(ServerEvent).default([]),
});
export type ServerDrive = z.infer<typeof ServerDriveSchema>;

export interface RestoreDeps {
  db: Db;
  rpc: (fn: string, args?: Record<string, unknown>) => Promise<unknown>;
  /** The driver this restore is for: the device's owner when it starts. */
  uid: string;
  /**
   * Whether the run is still wanted (the session is still `uid`'s, the runtime still live). Asked
   * before each page is read and again before it is written. Default: always.
   */
  isCurrent?: () => boolean | Promise<boolean>;
  now?: () => number;
  pageSize?: number;
}

export interface RestoreResult {
  /** This driver's restore had already run to the end: nothing was read. */
  skipped: boolean;
  restored: number;
  complete: boolean;
}

interface RestoredAt {
  uid: string;
  at: number;
}

/** Whether `uid`'s restore has already run to the end on this device. */
export async function restoreCompleted(db: Db, uid: string): Promise<boolean> {
  const stored = await createSettingsRepo(db).get<Partial<RestoredAt>>(RESTORED_AT_KEY);
  return stored !== null && typeof stored === 'object' && stored.uid === uid;
}

const isKnownType = (type: string): type is EventType => (EVENT_TYPES as readonly string[]).includes(type);

/** The server's events this build knows. */
const knownEvents = (d: ServerDrive) => d.events.flatMap((e) => (isKnownType(e.type) ? [{ ...e, type: e.type }] : []));

/** The six counter columns of the server's exposure, clamped; null (and no phone seconds) when it sent none. */
function exposureCols(d: ServerDrive): Pick<NewTrip, 'slowdowns' | 'speedups' | 'turns' | 'limit_s' | 'moving_s' | 'phone_s'> {
  if (d.exposure === null || d.exposure === undefined) return { slowdowns: null, speedups: null, turns: null, limit_s: null, moving_s: null, phone_s: 0 };
  const e = clampExposure({ ...d.exposure, phoneS: d.exposure.phoneS ?? 0 });
  return { slowdowns: e.slowdowns, speedups: e.speedups, turns: e.turns, limit_s: e.limitS, moving_s: e.movingS, phone_s: e.phoneS };
}

export function toTripRow(d: ServerDrive): NewTrip {
  const events = knownEvents(d).map((e) => ({ type: e.type, status: e.status ?? 'active' }));
  return {
    client_trip_id: d.clientTripId,
    started_at: d.startedAt,
    ended_at: d.endedAt,
    tz: d.tz,
    local_day: d.localDay ?? null,
    miles: d.miles,
    night_miles: d.nightMiles,
    duration_s: d.durationS,
    polyline: d.polyline,
    status: d.notDriving ? 'not_driving' : d.scored ? 'scored' : 'unscored',
    clean: d.clean === null ? null : d.clean ? 1 : 0,
    counts_json: JSON.stringify(countEvents(events)),
    reason: d.reason,
    result_json: d.result === undefined || d.result === null ? null : JSON.stringify(d.result),
    server_id: d.tripId,
    watched_miles: watchedMiles(d.miles, d.dashcamMovingS ?? 0, d.dashcamCoveredS ?? 0),
    origin: d.origin,
    not_driving_expired: d.notDrivingExpired ? 1 : 0,
    ...exposureCols(d),
  };
}

export function toEventRows(d: ServerDrive): NewEvent[] {
  return knownEvents(d).map((e) => ({
    id: e.id,
    client_trip_id: d.clientTripId,
    type: e.type,
    tier: e.tier,
    started_at: e.startedAt,
    duration_s: e.durationS,
    lat: e.lat ?? null,
    lng: e.lng ?? null,
    measured_json: e.measured === undefined ? null : JSON.stringify(e.measured),
    status: e.status ?? 'active',
    // A removed event was taken off by an accepted report: never offer Report on it again.
    dispute_status: e.disputeStatus ?? (e.status === 'removed' ? 'accepted' : 'none'),
  }));
}

/**
 * The server's copy of one drive, or null when the server does not list it. Read from
 * `list_my_drives` just after the drive's start, so the page holds it near its top.
 */
export async function readServerDrive(
  rpc: RestoreDeps['rpc'],
  clientTripId: string,
  startedAt: number
): Promise<ServerDrive | null> {
  const raw = await rpc('list_my_drives', { p_limit: 10, p_before: new Date(startedAt + 1_000).toISOString() });
  const rows = z.array(z.unknown()).safeParse(raw);
  if (!rows.success) throw new Error('list_my_drives did not answer with a list');
  for (const row of rows.data) {
    const parsed = ServerDriveSchema.safeParse(row);
    if (parsed.success && parsed.data.clientTripId === clientTripId) return parsed.data;
  }
  return null;
}

/**
 * Bring a drive the device holds in line with the server's copy: its status, clean flag, reason and
 * result, whether its "Not driving?" ran out, and each of its events' status (an event the server
 * removed was taken off by an accepted report). Local-only facts (labels, the route as recorded, the
 * end note, how it started) stay, and so do counters this phone counted itself; the server's fill
 * them in only when the phone has none. Runs on a transaction handle; a drive the device does not
 * hold is left alone.
 */
export async function applyServerDrive(tx: Db, d: ServerDrive, now: number): Promise<void> {
  const trips = createTripsRepo(tx);
  const events = createEventsRepo(tx);
  const local = await trips.get(d.clientTripId, tx);
  if (local === null) return;
  const row = toTripRow(d);
  const counted = local.slowdowns !== null && local.speedups !== null && local.turns !== null && local.limit_s !== null && local.moving_s !== null;
  const patch: TripPatch = {
    status: row.status,
    clean: row.clean ?? null,
    reason: row.reason ?? null,
    ...(row.result_json ? { result_json: row.result_json } : {}),
    ...(row.not_driving_expired === 1 ? { not_driving_expired: 1 as const } : {}),
    ...(!counted && row.slowdowns !== null && row.slowdowns !== undefined ? exposureCols(d) : {}),
    server_id: d.tripId,
    sync_error: null,
  };
  await trips.update(d.clientTripId, patch, now, tx);
  const held = new Set((await events.listByTrip(d.clientTripId, tx)).map((e) => e.id));
  for (const e of d.events) {
    if (!held.has(e.id)) continue;
    const removed = e.status === 'removed';
    await events.update(e.id, { status: removed ? 'removed' : 'active', ...(removed ? { dispute_status: 'accepted' as const, dispute_message: null } : {}) }, tx);
  }
  const remaining = await events.listByTrip(d.clientTripId, tx);
  await trips.update(d.clientTripId, { counts_json: JSON.stringify(countEvents(remaining)) }, now, tx);
}

/**
 * Restore every drive of `uid` the device does not hold yet. Idempotent per row (an existing id is
 * kept). Skipped once `uid`'s restore has run to the end; rejects with `RestoreAbandonedError` when
 * the device or session changed hands mid-way (the rows already written stay, and are announced).
 */
export async function restoreDrives(deps: RestoreDeps): Promise<RestoreResult> {
  const { db, uid } = deps;
  const now = deps.now ?? Date.now;
  const trips = createTripsRepo(db);
  const events = createEventsRepo(db);
  if (await restoreCompleted(db, uid)) return { skipped: true, restored: 0, complete: true };
  const isCurrent = deps.isCurrent ?? (() => true);
  const pageSize = deps.pageSize ?? RESTORE_PAGE;
  let before: number | null = null;
  let restored = 0;
  try {
    for (let page = 0; page < MAX_PAGES; page += 1) {
      if (!(await isCurrent())) throw new RestoreAbandonedError();
      const args: Record<string, unknown> = { p_limit: pageSize };
      if (before !== null) args.p_before = new Date(before).toISOString();
      const raw = await deps.rpc('list_my_drives', args);
      const rows = z.array(z.unknown()).safeParse(raw);
      if (!rows.success) throw new Error('list_my_drives did not answer with a list');
      const drives = rows.data.map((r) => ServerDriveSchema.safeParse(r)).flatMap((p) => (p.success ? [p.data] : []));
      // The page was read under whoever holds the session now: it is written only if that is still this driver.
      if (!(await isCurrent())) throw new RestoreAbandonedError();
      const written = await db.transaction(async (tx) => {
        if (!(await deviceOwnerIs(tx, uid))) return null;
        let n = 0;
        for (const d of drives) {
          if ((await trips.get(d.clientTripId, tx)) !== null) continue;
          await trips.insert(toTripRow(d), now(), tx);
          await events.insertMany(toEventRows(d), tx);
          n += 1;
        }
        return n;
      });
      if (written === null) throw new RestoreAbandonedError();
      restored += written;
      if (rows.data.length < pageSize || drives.length === 0) break;
      const oldest = Math.min(...drives.map((d) => d.startedAt));
      if (before !== null && oldest >= before) break;
      before = oldest;
    }
    await db.transaction(async (tx) => {
      if (!(await deviceOwnerIs(tx, uid))) throw new RestoreAbandonedError();
      await createSettingsRepo(tx).set(RESTORED_AT_KEY, { uid, at: now() } satisfies RestoredAt);
    });
  } finally {
    // Whatever was written is shown, also when the run stopped part-way.
    if (restored > 0) emitDataChanged({ source: 'hydrate' });
  }
  return { skipped: false, restored, complete: true };
}

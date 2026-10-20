/**
 * Restoring the user's drives from the server (plan §5): a reinstall, a new device, a device that
 * changed hands, a sign-out that emptied the phone. `list_my_drives` pages newest first; every row
 * the device does not hold becomes a settled local drive (the server's result, no estimate) with
 * its events, and a drive the device already holds is left as it is. From/to labels are not
 * restored (they only ever lived on the old device).
 *
 * A restore runs to the end once per owner: `RESTORED_AT_KEY` records `{ uid, at }` only after the
 * last page, so one cut short (offline, the app closed) starts again at the next try and fills
 * in what is still missing, and a drive recorded before the restore ran never stops it.
 *
 * Every page is written only while the device still belongs to the driver it was started for, and
 * only while `isCurrent` says the run is still wanted: a restore that outlives a sign-out or a
 * handover writes nothing more.
 */
import { z } from 'zod';

import { createEventsRepo, createSettingsRepo, createTripsRepo, type Db, type NewEvent, type NewTrip } from '@/data/db';
import { emitDataChanged } from '@/data/events';
import { countEvents } from '@/data/queries/rows';
import { DriveBreakdownSchema, EVENT_TYPES_V3, TIERS_V3 } from '@/data/sync/payload';
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
  type: z.enum(EVENT_TYPES_V3),
  tier: z.enum(TIERS_V3),
  startedAt: z.number(),
  durationS: z.number(),
  units: z.number().nullable().optional(),
  stoppedInTraffic: z.boolean().nullable().optional(),
  lat: z.number().nullable().optional(),
  lng: z.number().nullable().optional(),
  measured: z.unknown().optional(),
  penalty: z.number().nullable().optional(),
  status: z.enum(['active', 'removed']).nullable().optional(),
  /** A settled report on this event, when the server sends it. */
  disputeStatus: z.enum(['accepted', 'rejected']).nullable().optional(),
});

export const ServerDriveSchema = z.object({
  tripId: z.uuid(),
  clientTripId: z.uuid(),
  startedAt: z.number(),
  endedAt: z.number(),
  tz: z.string(),
  localDay: z.string().nullable().optional(),
  miles: z.number(),
  safeMiles: z.number(),
  nightMiles: z.number(),
  durationS: z.number(),
  polyline: z.string().nullable(),
  scored: z.boolean(),
  reason: z.string().nullable(),
  notDriving: z.boolean(),
  clean: z.boolean().nullable(),
  pointsNet: z.number().nullable(),
  breakdown: DriveBreakdownSchema.nullable().optional(),
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

export function toTripRow(d: ServerDrive): NewTrip {
  const events = d.events.map((e) => ({ type: e.type, durationS: e.durationS, status: e.status ?? 'active' }));
  return {
    client_trip_id: d.clientTripId,
    started_at: d.startedAt,
    ended_at: d.endedAt,
    tz: d.tz,
    local_day: d.localDay ?? null,
    miles: d.miles,
    safe_miles: d.safeMiles,
    night_miles: d.nightMiles,
    duration_s: d.durationS,
    polyline: d.polyline,
    status: d.notDriving ? 'not_driving' : d.scored ? 'scored' : 'unscored',
    points_net: d.pointsNet,
    estimate: 0,
    breakdown_json: d.breakdown ? JSON.stringify(d.breakdown) : null,
    clean: d.clean === null ? null : d.clean ? 1 : 0,
    counts_json: JSON.stringify(countEvents(events)),
    reason: d.reason,
    result_json: d.result === undefined || d.result === null ? null : JSON.stringify(d.result),
    server_id: d.tripId,
  };
}

export function toEventRows(d: ServerDrive): NewEvent[] {
  return d.events.map((e) => ({
    id: e.id,
    client_trip_id: d.clientTripId,
    type: e.type,
    tier: e.tier,
    started_at: e.startedAt,
    duration_s: e.durationS,
    units: e.units ?? null,
    stopped_in_traffic: e.stoppedInTraffic === true ? 1 : 0,
    lat: e.lat ?? null,
    lng: e.lng ?? null,
    measured_json: e.measured === undefined ? null : JSON.stringify(e.measured),
    penalty: e.penalty ?? null,
    status: e.status ?? 'active',
    // A removed event was taken off by an accepted report: never offer Report on it again.
    dispute_status: e.disputeStatus ?? (e.status === 'removed' ? 'accepted' : 'none'),
  }));
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

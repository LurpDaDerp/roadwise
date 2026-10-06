/**
 * Restoring the user's drives from the server when the local database is empty for them (plan
 * §5): a reinstall, a new device, a device that changed hands. `list_my_drives` pages newest
 * first; every row becomes a settled local drive (the server's result, no estimate) with its
 * events. From/to labels are not restored (they only ever lived on the old device).
 */
import { z } from 'zod';

import { createEventsRepo, createTripsRepo, type Db, type NewEvent, type NewTrip } from '@/data/db';
import { emitDataChanged } from '@/data/events';
import { countEvents } from '@/data/queries/rows';
import { DriveBreakdownSchema, EVENT_TYPES_V3, TIERS_V3 } from '@/data/sync/payload';

export const RESTORE_PAGE = 50;
export const MAX_PAGES = 40;
/** Settings key: epoch ms of the last completed restore for `{ uid, at }`. */
export const RESTORED_AT_KEY = 'restore.completedAt';

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
  dmsOn: z.boolean(),
  dmsFaceSeen: z.boolean(),
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
  now?: () => number;
  pageSize?: number;
}

export interface RestoreResult {
  /** The device already held drives: nothing was read. */
  skipped: boolean;
  restored: number;
  complete: boolean;
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
    dms_on: d.dmsOn ? 1 : 0,
    dms_face_seen: d.dmsFaceSeen ? 1 : 0,
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

/** Restore when the device holds no drives at all. Idempotent per row (an existing id is kept). */
export async function restoreDrives(deps: RestoreDeps): Promise<RestoreResult> {
  const { db } = deps;
  const now = deps.now ?? Date.now;
  const trips = createTripsRepo(db);
  const events = createEventsRepo(db);
  if ((await trips.count()) > 0) return { skipped: true, restored: 0, complete: true };
  const pageSize = deps.pageSize ?? RESTORE_PAGE;
  let before: number | null = null;
  let restored = 0;
  for (let page = 0; page < MAX_PAGES; page += 1) {
    const args: Record<string, unknown> = { p_limit: pageSize };
    if (before !== null) args.p_before = new Date(before).toISOString();
    const raw = await deps.rpc('list_my_drives', args);
    const rows = z.array(z.unknown()).safeParse(raw);
    if (!rows.success) throw new Error('list_my_drives did not answer with a list');
    const drives = rows.data.map((r) => ServerDriveSchema.safeParse(r)).flatMap((p) => (p.success ? [p.data] : []));
    for (const d of drives) {
      await db.transaction(async (tx) => {
        if ((await trips.get(d.clientTripId, tx)) !== null) return;
        await trips.insert(toTripRow(d), now(), tx);
        await events.insertMany(toEventRows(d), tx);
        restored += 1;
      });
    }
    if (rows.data.length < pageSize || drives.length === 0) break;
    const oldest = Math.min(...drives.map((d) => d.startedAt));
    if (before !== null && oldest >= before) break;
    before = oldest;
  }
  if (restored > 0) emitDataChanged({ source: 'hydrate' });
  return { skipped: false, restored, complete: true };
}

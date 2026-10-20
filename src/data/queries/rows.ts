/**
 * Row → view bridges for the local drive data (plan §10). Pure, so the numbers a screen shows can
 * be tested without rendering anything.
 */
import type { DriveBreakdown, EventType, StatSums, Tier } from '@scoring';

import type { EventRow, TripEndCause, TripRow, TripStatus } from '@/data/db/types';
import { FinalizeTripResponseV3Schema, type FinalizeTripResponseV3 } from '@/data/sync/payload';

export type DriveStatus = TripStatus;

export interface DriveCounts {
  speeding: number;
  pickups: number;
  handlingS: number;
  hardBrake: number;
  hardAccel: number;
  hardCorner: number;
  /** DashPal events: kept apart from the phone's counts (never in the stats). */
  eyesOff: number;
  drowsy: number;
}

export const EMPTY_COUNTS: DriveCounts = Object.freeze({
  speeding: 0,
  pickups: 0,
  handlingS: 0,
  hardBrake: 0,
  hardAccel: 0,
  hardCorner: 0,
  eyesOff: 0,
  drowsy: 0,
});

export interface LocalDrive {
  clientTripId: string;
  startedAt: number;
  endedAt: number | null;
  miles: number;
  durationS: number;
  nightMiles: number;
  fromLabel: string | null;
  toLabel: string | null;
  /** Already privacy-trimmed. */
  polyline: string | null;
  status: DriveStatus;
  pointsNet: number | null;
  /** The local `scoreDrive` estimate until the server answers. */
  estimate: boolean;
  clean: boolean | null;
  counts: DriveCounts;
  result: FinalizeTripResponseV3 | null;
  reason: string | null;
  mergedInto: string | null;
  /** Why the server last refused an action on this drive (e.g. a "Wasn't driving": `too_old`). */
  syncError: string | null;
  /** What ended it, on the phone that recorded it (null otherwise). */
  endCause: TripEndCause | null;
}

export interface LocalDriveEvent {
  id: string;
  type: EventType;
  tier: Tier;
  startedAt: number;
  durationS: number;
  lat: number | null;
  lng: number | null;
  penalty: number | null;
  disputeStatus: 'none' | 'pending' | 'accepted' | 'rejected';
  disputeMessage: string | null;
  /** Removed by an accepted dispute: shown struck through, excluded from points. */
  removed: boolean;
  measured: { speedMph?: number; limitMph?: number; peakG?: number; mounted?: boolean; source?: 'dashcam' };
  stoppedInTraffic: boolean;
}

/** Counts of ACTIVE events, from a drive's event rows (or any v3 events). */
export function countEvents(
  events: readonly { type: EventType; durationS?: number; duration_s?: number; status?: 'active' | 'removed' }[]
): DriveCounts {
  const c: DriveCounts = { ...EMPTY_COUNTS };
  for (const e of events) {
    if (e.status === 'removed') continue;
    const d = e.durationS ?? e.duration_s ?? 0;
    switch (e.type) {
      case 'speeding':
        c.speeding += 1;
        break;
      case 'phone_pickup':
        c.pickups += 1;
        break;
      case 'phone_handling':
        c.handlingS += d;
        break;
      case 'hard_brake':
        c.hardBrake += 1;
        break;
      case 'hard_accel':
        c.hardAccel += 1;
        break;
      case 'hard_corner':
        c.hardCorner += 1;
        break;
      case 'eyes_off':
        c.eyesOff += 1;
        break;
      case 'drowsy':
        c.drowsy += 1;
        break;
    }
  }
  return c;
}

export function parseCounts(json: string | null): DriveCounts {
  if (json === null) return { ...EMPTY_COUNTS };
  try {
    const raw = JSON.parse(json) as Partial<Record<keyof DriveCounts, unknown>>;
    const out: DriveCounts = { ...EMPTY_COUNTS };
    for (const key of Object.keys(EMPTY_COUNTS) as (keyof DriveCounts)[]) {
      const v = raw[key];
      if (typeof v === 'number' && Number.isFinite(v)) out[key] = v;
    }
    return out;
  } catch {
    return { ...EMPTY_COUNTS };
  }
}

export function parseResult(json: string | null): FinalizeTripResponseV3 | null {
  if (json === null) return null;
  try {
    const parsed = FinalizeTripResponseV3Schema.safeParse(JSON.parse(json));
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}

export function parseBreakdown(json: string | null): DriveBreakdown | null {
  if (json === null) return null;
  try {
    return JSON.parse(json) as DriveBreakdown;
  } catch {
    return null;
  }
}

export function toLocalDrive(row: TripRow): LocalDrive {
  return {
    clientTripId: row.client_trip_id,
    startedAt: row.started_at,
    endedAt: row.ended_at,
    miles: row.miles,
    durationS: row.duration_s,
    nightMiles: row.night_miles,
    fromLabel: row.from_label,
    toLabel: row.to_label,
    polyline: row.polyline,
    status: row.status,
    pointsNet: row.points_net,
    estimate: row.estimate === 1,
    clean: row.clean === null ? null : row.clean === 1,
    counts: parseCounts(row.counts_json),
    result: parseResult(row.result_json),
    reason: row.reason,
    mergedInto: row.merged_into,
    syncError: row.sync_error,
    endCause: row.end_cause,
  };
}

export function toLocalDriveEvent(row: EventRow): LocalDriveEvent {
  let measured: LocalDriveEvent['measured'] = {};
  if (row.measured_json !== null) {
    try {
      measured = JSON.parse(row.measured_json) as LocalDriveEvent['measured'];
    } catch {
      measured = {};
    }
  }
  return {
    id: row.id,
    type: row.type,
    tier: row.tier,
    startedAt: row.started_at,
    durationS: row.duration_s,
    lat: row.lat,
    lng: row.lng,
    penalty: row.penalty,
    disputeStatus: row.dispute_status,
    disputeMessage: row.dispute_message,
    removed: row.status === 'removed',
    measured,
    stoppedInTraffic: row.stopped_in_traffic === 1,
  };
}

/**
 * A drive the lists show: not merged away, not still recording. One that failed to upload is still
 * a drive the user made, and is listed under "Not synced" rather than lost.
 */
export const isListed = (d: Pick<LocalDrive, 'status'>): boolean => d.status !== 'merged' && d.status !== 'recording';

/** A drive that counts toward stats and the first-run count: scored by the server, or a pending estimate. */
export const isScoredDrive = (d: Pick<LocalDrive, 'status' | 'pointsNet'>): boolean =>
  d.status === 'scored' || (d.status === 'pending' && d.pointsNet !== null);

export function matchesHistoryFilter(d: LocalDrive, filter: 'all' | 'clean' | 'negative' | 'passenger'): boolean {
  if (!isListed(d)) return false;
  switch (filter) {
    case 'all':
      return true;
    case 'clean':
      return d.clean === true;
    case 'negative':
      return d.pointsNet !== null && d.pointsNet < 0;
    case 'passenger':
      return d.status === 'not_driving';
  }
}

export const EMPTY_SUMS: StatSums = Object.freeze({
  miles: 0,
  durationS: 0,
  nightMiles: 0,
  drives: 0,
  cleanDrives: 0,
  speeding: 0,
  pickups: 0,
  handlingS: 0,
  hardBrake: 0,
  hardAccel: 0,
  hardCorner: 0,
});

/** `StatSums` over scored, non-not_driving drives started at or after `sinceMs` (null: all time). */
export function sumStats(drives: readonly LocalDrive[], sinceMs: number | null): StatSums {
  const out: StatSums = { ...EMPTY_SUMS };
  for (const d of drives) {
    if (!isScoredDrive(d) || (sinceMs !== null && d.startedAt < sinceMs)) continue;
    out.miles += d.miles;
    out.durationS += d.durationS;
    out.nightMiles += d.nightMiles;
    out.drives += 1;
    if (d.clean === true) out.cleanDrives += 1;
    out.speeding += d.counts.speeding;
    out.pickups += d.counts.pickups;
    out.handlingS += d.counts.handlingS;
    out.hardBrake += d.counts.hardBrake;
    out.hardAccel += d.counts.hardAccel;
    out.hardCorner += d.counts.hardCorner;
  }
  return out;
}

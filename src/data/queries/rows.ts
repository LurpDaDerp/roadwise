/**
 * Row → view bridges for the local drive data (plan §10). Pure, so the numbers a screen shows can
 * be tested without rendering anything.
 */
import { clampExposure, estimateExposure, type EventType, type Exposure, type StatSums, type Tier } from '@scoring';

import { UPLOAD_FAILED_SQL } from '@/data/db/queue';
import { asNumberOrNull } from '@/data/db/row';
import { toTripRow } from '@/data/db/trips';
import type { DriveOrigin, EventRow, StartSource, TripEndCause, TripRow, TripStatus } from '@/data/db/types';
import { FinalizeTripResponseSchema, type FinalizeTripResponse } from '@/data/sync/payload';

export type DriveStatus = TripStatus;

export interface DriveCounts {
  speeding: number;
  hardBrake: number;
  hardAccel: number;
  hardCorner: number;
  /** Phone pickups. */
  pickups: number;
  /** DashPal events: kept apart from the phone's counts (never in the stats). */
  eyesOff: number;
  drowsy: number;
}

export const EMPTY_COUNTS: DriveCounts = Object.freeze({
  speeding: 0,
  hardBrake: 0,
  hardAccel: 0,
  hardCorner: 0,
  pickups: 0,
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
  /** No active event other than DashPal's; null until classified, and on an unscored drive. */
  clean: boolean | null;
  counts: DriveCounts;
  /**
   * The server's answer (v4); null until it answered, for one stored before this build, and in a list
   * read (`toListedDrive`): only a drive's own read needs it, and `reason` carries its verdict everywhere.
   */
  result: FinalizeTripResponse | null;
  reason: string | null;
  /** Why the server last refused an action on this drive (e.g. a "Wasn't driving": `too_old`). */
  syncError: string | null;
  /** What ended it, on the phone that recorded it (null otherwise). */
  endCause: TripEndCause | null;
  /** The miles DashPal watched (the radar's Attention divides by them); 0 without one. */
  watchedMiles: number;
  /** How the drive started: noticed on its own, or a Start tap. */
  origin: DriveOrigin;
  /** The in-drive "Not driving?" ran out, so "Wasn't driving" is never offered for it. */
  notDrivingExpired: boolean;
  /** Where the start came from; null on an older or restored drive. */
  startSource: StartSource | null;
  /**
   * The drive's chances to slip: counted while it recorded, or estimated (`exposureEstimated`).
   * `phoneS` (seconds at driving speed watched for phone use) is 0 on a drive recorded before phone
   * tracking and on an estimated one: Phone use has no score from it.
   */
  exposure: Exposure;
  /** True when the drive was recorded before the counters and `exposure` is estimated from its miles and duration. */
  exposureEstimated: boolean;
  /**
   * Past the detailed history: ended more than 183 days ago and archived (no route, places or labels
   * kept). Counted in every stat, shown in no list, and its recap reads as not found. Absent: false.
   */
  archived?: boolean;
  /**
   * Its upload is still owed and has failed at least once (`UPLOAD_FAILED_SQL`): "Not synced yet".
   * Read with the drive by the lists and the recap. Absent: false.
   */
  uploadFailed?: boolean;
}

/** A trip row as the drive reads select it: the row, and whether its upload has failed (`UPLOAD_FAILED_SQL`, 0 or 1). */
export type TripView = TripRow & { upload_failed?: number | null };

/** A trip's columns and whether its upload has failed, for a select over `trips t`. */
export const TRIP_VIEW = `t.*, ${UPLOAD_FAILED_SQL} AS upload_failed`;

/** A row selected with `TRIP_VIEW`. */
export const toTripView = (row: Record<string, unknown>): TripView => ({ ...toTripRow(row), upload_failed: asNumberOrNull(row, 'upload_failed') });

export interface LocalDriveEvent {
  id: string;
  type: EventType;
  tier: Tier;
  startedAt: number;
  durationS: number;
  lat: number | null;
  lng: number | null;
  disputeStatus: 'none' | 'pending' | 'accepted' | 'rejected';
  disputeMessage: string | null;
  /** Removed by an accepted dispute: shown struck through, counted nowhere. */
  removed: boolean;
  /**
   * What the detector measured; speeding's `overMphS` weighs it in the Speed score. A phone pickup:
   * `speedMph` as it started, `maxSpeedMph` the highest while in hand.
   */
  measured: { speedMph?: number; maxSpeedMph?: number; limitMph?: number; peakG?: number; overMphS?: number; source?: 'dashcam' };
}

/** Counts of ACTIVE events, from a drive's event rows (or any wire events). */
export function countEvents(events: readonly { type: EventType; status?: 'active' | 'removed' }[]): DriveCounts {
  const c: DriveCounts = { ...EMPTY_COUNTS };
  for (const e of events) {
    if (e.status === 'removed') continue;
    switch (e.type) {
      case 'speeding':
        c.speeding += 1;
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
      case 'phone_pickup':
        c.pickups += 1;
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

/** The stored counts; keys this build does not know (an older build's phone counts) are ignored. */
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

/** The stored server answer, when it is a v4 answer; anything else (an older answer, garbage) is null. */
export function parseResult(json: string | null): FinalizeTripResponse | null {
  if (json === null) return null;
  try {
    const parsed = FinalizeTripResponseSchema.safeParse(JSON.parse(json));
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}

/**
 * The drive's opportunity counters: the five stored columns when all are there, with its phone
 * seconds (clamped), else the estimate from its miles and duration (a drive recorded before the
 * counters existed; no phone seconds).
 */
export function exposureOf(row: Pick<TripRow, 'slowdowns' | 'speedups' | 'turns' | 'limit_s' | 'moving_s' | 'phone_s' | 'miles' | 'duration_s'>): {
  exposure: Exposure;
  estimated: boolean;
} {
  const { slowdowns, speedups, turns, limit_s: limitS, moving_s: movingS, phone_s: phoneS } = row;
  if (slowdowns !== null && speedups !== null && turns !== null && limitS !== null && movingS !== null) {
    return { exposure: clampExposure({ slowdowns, speedups, turns, limitS, movingS, phoneS }), estimated: false };
  }
  return { exposure: estimateExposure(row.miles, row.duration_s), estimated: true };
}

export function toLocalDrive(row: TripView): LocalDrive {
  return toDrive(row, parseResult(row.result_json));
}

/**
 * A row as a list reads it: the stored server answer left unread (`result` null), so a list of a
 * whole history spends no schema check per drive on a field it never shows.
 */
export function toListedDrive(row: TripView): LocalDrive {
  return toDrive(row, null);
}

function toDrive(row: TripView, result: FinalizeTripResponse | null): LocalDrive {
  const { exposure, estimated } = exposureOf(row);
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
    clean: row.clean === null ? null : row.clean === 1,
    counts: parseCounts(row.counts_json),
    result,
    reason: row.reason,
    syncError: row.sync_error,
    endCause: row.end_cause,
    watchedMiles: row.watched_miles,
    origin: row.origin,
    notDrivingExpired: row.not_driving_expired === 1,
    startSource: row.start_source,
    exposure,
    exposureEstimated: estimated,
    // Present only on an archived drive, and on one whose upload has failed.
    ...(row.archived_at !== null ? { archived: true } : {}),
    ...(row.upload_failed === 1 ? { uploadFailed: true } : {}),
  };
}

const finiteOrUndefined = (v: unknown): number | undefined => (typeof v === 'number' && Number.isFinite(v) ? v : undefined);

/**
 * The measured block as stored, keeping only the keys this build reads: `maxSpeedMph` on a phone
 * pickup only, and never an older build's `mounted`.
 */
function parseMeasured(json: string | null, type: EventType): LocalDriveEvent['measured'] {
  if (json === null) return {};
  let raw: unknown;
  try {
    raw = JSON.parse(json);
  } catch {
    return {};
  }
  if (typeof raw !== 'object' || raw === null) return {};
  const r = raw as Record<string, unknown>;
  const out: LocalDriveEvent['measured'] = {};
  const speedMph = finiteOrUndefined(r.speedMph);
  const maxSpeedMph = type === 'phone_pickup' ? finiteOrUndefined(r.maxSpeedMph) : undefined;
  const limitMph = finiteOrUndefined(r.limitMph);
  const peakG = finiteOrUndefined(r.peakG);
  const overMphS = finiteOrUndefined(r.overMphS);
  if (speedMph !== undefined) out.speedMph = speedMph;
  if (maxSpeedMph !== undefined) out.maxSpeedMph = maxSpeedMph;
  if (limitMph !== undefined) out.limitMph = limitMph;
  if (peakG !== undefined) out.peakG = peakG;
  if (overMphS !== undefined) out.overMphS = overMphS;
  if (r.source === 'dashcam') out.source = 'dashcam';
  return out;
}

export function toLocalDriveEvent(row: EventRow): LocalDriveEvent {
  return {
    id: row.id,
    type: row.type,
    tier: row.tier,
    startedAt: row.started_at,
    durationS: row.duration_s,
    lat: row.lat,
    lng: row.lng,
    disputeStatus: row.dispute_status,
    disputeMessage: row.dispute_message,
    removed: row.status === 'removed',
    measured: parseMeasured(row.measured_json, row.type),
  };
}

/**
 * A drive the lists show: not still recording, and not archived (past the detailed history). One
 * that failed to upload is still a drive the user made, and is listed under "Not synced" rather than lost.
 */
export const isListed = (d: Pick<LocalDrive, 'status' | 'archived'>): boolean => d.status !== 'recording' && d.archived !== true;

/**
 * A drive that counts toward stats and the first-run count: scored by the server, or pending and
 * long enough to score (a too-short pending drive carries `reason = 'too_short'`). Points play no
 * part.
 */
export const isScoredDrive = (d: Pick<LocalDrive, 'status' | 'reason'>): boolean =>
  d.status === 'scored' || (d.status === 'pending' && d.reason === null);

export function matchesHistoryFilter(d: LocalDrive, filter: 'all' | 'clean' | 'passenger'): boolean {
  if (!isListed(d)) return false;
  switch (filter) {
    case 'all':
      return true;
    case 'clean':
      return d.clean === true;
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
  hardBrake: 0,
  hardAccel: 0,
  hardCorner: 0,
});

/** What `sumStats` reads of a drive. */
export type SummedDrive = Pick<LocalDrive, 'status' | 'reason' | 'startedAt' | 'miles' | 'durationS' | 'nightMiles' | 'clean' | 'counts'>;

/** `StatSums` over scored, non-not_driving drives started at or after `sinceMs` (null: all time). */
export function sumStats(drives: readonly SummedDrive[], sinceMs: number | null): StatSums {
  const out: StatSums = { ...EMPTY_SUMS };
  for (const d of drives) {
    if (!isScoredDrive(d) || (sinceMs !== null && d.startedAt < sinceMs)) continue;
    out.miles += d.miles;
    out.durationS += d.durationS;
    out.nightMiles += d.nightMiles;
    out.drives += 1;
    if (d.clean === true) out.cleanDrives += 1;
    out.speeding += d.counts.speeding;
    out.hardBrake += d.counts.hardBrake;
    out.hardAccel += d.counts.hardAccel;
    out.hardCorner += d.counts.hardCorner;
  }
  return out;
}

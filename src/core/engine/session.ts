// The per-trip accumulators (design §3.1 "rows appended", spec §9.4 trip metrics).
//
// Pure functions over a mutable `TripSession`: the machine decides *whether* a row belongs to the
// trip, this module decides what the trip knows once it does. Nothing here reads a clock.
import { ROW_MS, knownSpeed } from '@/core/detectors/common';
import { haversineMeters } from '@/lib/geo';
import type { Fix, StartEvidence, StartSource, TripRole, TripSession } from './engine.types';
import type { DriveMode, FeatureRow, LimitSample } from './types';

/** The `trips.role_source` a trip is stored with, from its start evidence. */
export function roleSourceFor(evidence: StartEvidence): 'manual' | 'moving_start' | 'auto' {
  if (evidence === 'tap') return 'manual';
  if (evidence === 'movingStart') return 'moving_start';
  return 'auto';
}

/**
 * The start back from a stored `role_source`, for a trip rebuilt after a relaunch: `manual` →
 * `tap`, `moving_start` → `movingStart`, `auto` → `auto`; anything else (null, a value from a
 * later version) → `auto`, the start that claims least about who is driving. Only `recording`
 * rows are ever rebuilt, and nothing but the recorder writes `role_source` on those — the role
 * correction's `manual` lands on finalized trips only.
 */
export function startFromRoleSource(
  roleSource: string | null
): { startSource: StartSource; startEvidence: StartEvidence } {
  if (roleSource === 'manual') return { startSource: 'manual', startEvidence: 'tap' };
  if (roleSource === 'moving_start') return { startSource: 'manual', startEvidence: 'movingStart' };
  return { startSource: 'auto', startEvidence: 'auto' };
}

/** How many seconds of rows stay in memory between checkpoints. */
export const RING_S = 120;
/** Consecutive fixes implying a speed above this are GNSS noise, not distance (§19.1). */
export const GNSS_JUMP_MPS = 200;
/** The rolling-mean window behind `maxSustainedSpeedMps` (§9.4 implausible speed). */
export const SUSTAINED_WINDOW_S = 10;

export interface SessionStart {
  clientTripId: string;
  mode: DriveMode;
  role: TripRole;
  startSource: StartSource;
  /** Defaults from `startSource`: `manual` → `tap`, `auto` → `auto`. */
  startEvidence?: StartEvidence;
  startedAt: number;
  startApproximate?: boolean;
}

export function createSession(start: SessionStart): TripSession {
  return {
    clientTripId: start.clientTripId,
    mode: start.mode,
    role: start.role,
    startSource: start.startSource,
    startEvidence: start.startEvidence ?? (start.startSource === 'manual' ? 'tap' : 'auto'),
    arbiterState: null,
    startedAt: start.startedAt,
    startApproximate: start.startApproximate === true,
    endedAt: null,
    lastRowTs: null,
    rowsCount: 0,
    validGnssRows: 0,
    limitKnownRows: 0,
    rows: [],
    events: [],
    alerts: [],
    distanceM: 0,
    validGnssPct: 0,
    maxSustainedSpeedMps: 0,
    durationS: 0,
    gaps: [],
    checkpoints: [],
    firstFix: null,
    lastFix: null,
  };
}

/**
 * Seconds of the gaps that fall before `endTs`. A gap is clipped to the closing instant: a trip
 * that resumed and then closed without another row ends at its last row, *before* the gap's
 * `toTs`, and must not have that gap taken off a duration it was never part of.
 */
const gapSeconds = (session: TripSession, endTs: number): number =>
  session.gaps.reduce(
    (sum, gap) => sum + Math.max(0, Math.min(gap.toTs, endTs) - Math.min(gap.fromTs, endTs)),
    0
  ) / 1000;

/** Trip seconds through `endTs`, net of the gaps before it. */
const durationThrough = (session: TripSession, endTs: number): number =>
  Math.max(0, (endTs - session.startedAt) / 1000 - gapSeconds(session, endTs));

function addDistance(session: TripSession, row: FeatureRow): void {
  if (!row.gnssValid) return;
  const fix: Fix = { lat: row.lat, lng: row.lng, ts: row.ts };
  const prev = session.lastFix;
  if (prev !== null) {
    const d = haversineMeters(prev, fix);
    const dtS = Math.max(1, (fix.ts - prev.ts) / 1000);
    // A jump faster than any car is a bad fix; skip the segment but still move on from it, so a
    // single spike costs two segments rather than every segment until the track returns.
    if (d <= GNSS_JUMP_MPS * dtS) session.distanceM += d;
  }
  if (session.firstFix === null) session.firstFix = fix;
  session.lastFix = fix;
}

/**
 * The mean over the last `SUSTAINED_WINDOW_S` rows of the ring, once every one of them carries
 * a known speed. One unknown row breaks the window: a sustained speed needs continuous evidence.
 */
function sustainedMean(session: TripSession): number | null {
  const rows = session.rows;
  if (rows.length < SUSTAINED_WINDOW_S) return null;
  let sum = 0;
  for (let i = rows.length - SUSTAINED_WINDOW_S; i < rows.length; i += 1) {
    const speed = knownSpeed(rows[i] as FeatureRow);
    if (speed === null) return null;
    sum += speed;
  }
  return sum / SUSTAINED_WINDOW_S;
}

/** Append one row the machine has accepted. Rows must arrive in `ts` order. */
export function appendRow(session: TripSession, row: FeatureRow, limit: LimitSample): void {
  session.rows.push(row);
  const oldest = row.ts - RING_S * ROW_MS;
  while (session.rows.length > 0 && (session.rows[0] as FeatureRow).ts <= oldest) {
    session.rows.shift();
  }
  session.rowsCount += 1;
  session.lastRowTs = row.ts;
  if (row.gnssValid) session.validGnssRows += 1;
  if (limit.source !== 'unknown' && limit.limitMps !== null) session.limitKnownRows += 1;
  session.validGnssPct = (session.validGnssRows / session.rowsCount) * 100;
  addDistance(session, row);
  const sustained = sustainedMean(session);
  if (sustained !== null && sustained > session.maxSustainedSpeedMps) {
    session.maxSustainedSpeedMps = sustained;
  }
  session.durationS = durationThrough(session, row.ts + ROW_MS);
}

export function noteGap(session: TripSession, fromTs: number, toTs: number): void {
  session.gaps.push({ fromTs, toTs });
}

/** A frozen copy, arrays included, so a callback holding it sees what it was handed. */
export function snapshotSession(session: TripSession): Readonly<TripSession> {
  return Object.freeze({
    ...session,
    rows: Object.freeze(session.rows.slice()) as FeatureRow[],
    events: Object.freeze(session.events.slice()) as TripSession['events'],
    alerts: Object.freeze(session.alerts.slice()) as TripSession['alerts'],
    gaps: Object.freeze(session.gaps.slice()) as TripSession['gaps'],
    checkpoints: Object.freeze(session.checkpoints.slice()) as number[],
  });
}

/** The closed trip as the finalizer receives it. The open session object is left as it was. */
export function closeSession(session: TripSession, endedAt: number): Readonly<TripSession> {
  return snapshotSession({
    ...session,
    endedAt,
    durationS: durationThrough(session, endedAt),
  });
}

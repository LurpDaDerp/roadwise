// The per-drive accumulators: miles, safe miles, night miles, the track, integrity counters.
// Pure functions over a mutable `TripSession`; nothing here reads a clock.
import { PHONE_MIN_MPH } from '@scoring';

import { knownSpeed, MPS_PER_MPH } from '@/core/detectors/common';
import { haversineMeters } from '@/lib/geo';
import { sunIsDown } from '@/lib/time';

import type { EndCause, Fix, TripSession } from './engine.types';
import type { FeatureRow } from './types';

/** Consecutive fixes implying a speed above this are GNSS noise, not distance. */
export const GNSS_JUMP_MPS = 100;
/** Any IMU extreme beyond this (g, or rad/s for yaw) on a moving row is "the IMU saw motion". */
export const IMU_ACTIVE_MIN = 0.03;

export interface SessionStart {
  clientTripId: string;
  startedAt: number;
}

export function createSession(start: SessionStart): TripSession {
  return {
    clientTripId: start.clientTripId,
    startedAt: start.startedAt,
    endedAt: null,
    endCause: null,
    lastRowTs: null,
    rowsCount: 0,
    validGnssRows: 0,
    mockRows: 0,
    movingRows: 0,
    imuActiveRows: 0,
    distanceM: 0,
    safeDistanceM: 0,
    nightDistanceM: 0,
    maxSpeedMps: 0,
    firstFix: null,
    lastFix: null,
    track: [],
    events: [],
    pending: [],
    checkpointTs: null,
  };
}

const imuActive = (row: FeatureRow): boolean =>
  Math.abs(row.aLonMax) > IMU_ACTIVE_MIN ||
  Math.abs(row.aLonMin) > IMU_ACTIVE_MIN ||
  Math.abs(row.aLatMax) > IMU_ACTIVE_MIN ||
  Math.abs(row.aLatMin) > IMU_ACTIVE_MIN ||
  Math.abs(row.yawRateMax) > IMU_ACTIVE_MIN;

/**
 * Append one row the machine has accepted. `unsafe`: a speeding or phone episode is active on this
 * row (its distance is not safe miles).
 */
export function appendRow(session: TripSession, row: FeatureRow, unsafe: boolean): void {
  session.rowsCount += 1;
  session.lastRowTs = row.ts;
  session.pending.push(row);
  if (row.mock === true) session.mockRows += 1;
  const speed = knownSpeed(row);
  if (speed !== null) {
    if (speed > session.maxSpeedMps) session.maxSpeedMps = speed;
    if (speed >= PHONE_MIN_MPH * MPS_PER_MPH) {
      session.movingRows += 1;
      if (imuActive(row)) session.imuActiveRows += 1;
    }
  }
  if (!row.gnssValid || !Number.isFinite(row.lat) || !Number.isFinite(row.lng)) return;
  session.validGnssRows += 1;
  const fix: Fix = { lat: row.lat, lng: row.lng, ts: row.ts };
  const prev = session.lastFix;
  if (prev !== null) {
    const d = haversineMeters(prev, fix);
    const dtS = Math.max(1, (fix.ts - prev.ts) / 1000);
    // A jump faster than any car is a bad fix: skip the segment but still move on from it.
    if (d <= GNSS_JUMP_MPS * dtS) {
      session.distanceM += d;
      if (!unsafe) session.safeDistanceM += d;
      if (sunIsDown(new Date(row.ts), row.lat, row.lng)) session.nightDistanceM += d;
    }
  }
  if (session.firstFix === null) session.firstFix = fix;
  session.lastFix = fix;
  session.track.push({ ...fix, hAcc: row.hAcc });
}

/** A frozen copy, arrays included, so a callback holding it sees what it was handed. */
export function snapshotSession(session: TripSession): Readonly<TripSession> {
  return Object.freeze({
    ...session,
    track: Object.freeze(session.track.slice()) as TripSession['track'],
    events: Object.freeze(session.events.slice()) as TripSession['events'],
    pending: Object.freeze(session.pending.slice()) as TripSession['pending'],
  });
}

/** The closed drive as the finalizer receives it. The open session object is left as it was. */
export function closeSession(session: TripSession, endedAt: number, cause: EndCause): Readonly<TripSession> {
  // The drive ends where driving stopped, never before its own start or last row of driving.
  const end = Math.max(endedAt, session.startedAt + 1000);
  return snapshotSession({ ...session, endedAt: Math.round(end), endCause: cause });
}

export const durationSOf = (session: Pick<TripSession, 'startedAt' | 'endedAt'>): number =>
  Math.max(0, ((session.endedAt ?? session.startedAt) - session.startedAt) / 1000);

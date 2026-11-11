// Hard braking, hard acceleration and hard cornering (product spec event table, "Rules against
// false positives") from the per-second IMU extremes:
// - braking ≥ 0.36 g (severe ≥ 0.55) and acceleration ≥ 0.40 g (severe ≥ 0.60) count only when
//   the GNSS speed changed to match (a drop, or a rise, of at least `GNSS_CONFIRM_G` over a second
//   inside or right after the episode), read only from two fixes whose speed the phone rates at
//   2 m/s or better (`speedTrusted`);
// - until the phone has learned the car's forward axis (no row this drive has had forward
//   extremes), the GNSS speed change itself stands in for them, from two fixes rated at
//   `GNSS_ONLY_ACC_MAX_MPS` or better: a second's mean is never above its peak, so it can only
//   under-read, and a change past `GNSS_ONLY_MAX_G` is a jump in the fix;
// - cornering ≥ 0.48 g (severe ≥ 0.70) sideways, at 10 mph or more, counts only when the car turned
//   with it: the row's gyroscope turned the phone fast enough (speed × yaw rate at least
//   `CORNER_YAW_SHARE` of the peak), the force is not a wobble (both sides past `CORNER_WOBBLE_G` in
//   one second), and the GPS course turned the same way (left-positive lateral force against a
//   clockwise course) at a rate × speed of at least `CORNER_PLAUSIBLE_SHARE` of the peak, read only
//   from two known courses (an unknown one is −1) that did not jump (at 10 mph or more, faster than
//   `COURSE_JUMP_DEG_S` and implying more than `GNSS_ONLY_MAX_G` sideways);
// - on a row with no sideways extremes (the phone has not learned the car's forward axis, or lost
//   it), the gyroscope stands in for them: speed × yaw rate is the sideways force in a turn, whatever
//   way the phone sits. It also turns with the phone in a hand or sliding in a cup holder, so the
//   force is the lesser of it and the force the row's own GPS course turn implies (both must reach
//   the line), and its side is the course's;
// - a phone sliding or dropping — an orientation spike or a lost gravity reference within two
//   seconds — is ignored, whatever the IMU says.
// The lines are the row's own (`hardLines`): a row the host stamped with a slippery road
// (`row.road.g`) is judged at the wet or snow lines, an unstamped row at the ones above. An episode
// keeps the lines of its first row for its tier, and its event names the minor line (`lineG`) when
// it is under the dry one.
// Each kind runs as an episode of consecutive signal rows. It is alerted the first row it is
// confirmed (the GNSS vouched for it, no spike, the car at 5 mph or more: `alerts()`), once. The
// event itself waits: a closed episode is held for two seconds so the row after it can still
// confirm or veto it, then released as at most one event (an alerted episode a later spike vetoes
// is alerted but never charged).
import { hardLines, MOVING_MIN_MPH, type HardLines, type Tier } from '@scoring';

import type { DetectedEvent, Detector, FeatureRow, HarshAlert, HarshKind } from '../engine/types';
import { G_MPS2, knownSpeed, knownSpeedMph, MPS_PER_MPH, round1, round2, rowEligible, speedTrusted } from './common';

const KINDS: readonly HarshKind[] = ['hard_brake', 'hard_accel', 'hard_corner'];

/** The GNSS Δspeed over a second that confirms an IMU extreme (1 Hz averaging halves a peak). */
export const GNSS_CONFIRM_G = 0.1;
/** Before the forward axis is learned, a GNSS Δspeed counts on its own only from fixes rated this well (m/s). */
export const GNSS_ONLY_ACC_MAX_MPS = 1;
/** A GNSS Δspeed past this in a second is a jump in the fix, not the car, and stands in for nothing. */
export const GNSS_ONLY_MAX_G = 1;
/** The course-rate estimate must reach this share of the IMU's lateral peak. */
export const CORNER_PLAUSIBLE_SHARE = 0.5;
/** Cornering is judged only at or above this speed; below it the course is noise. */
export const CORNER_MIN_MPH = 10;
/**
 * A course turning faster than this (°/s) at `CORNER_MIN_MPH` or more is a jump in the fix, not the
 * car, when it also implies more than `GNSS_ONLY_MAX_G` sideways (a tight turn at low speed does not).
 */
export const COURSE_JUMP_DEG_S = 60;
/** The gyroscope must turn the phone enough: speed × yaw rate at least this share of the lateral peak. */
export const CORNER_YAW_SHARE = 0.5;
/** Lateral force past this both ways in one second is the mount wobbling, not a turn. */
export const CORNER_WOBBLE_G = 0.25;
/** Consecutive fixes farther apart than this cannot vouch for the same second. */
const MAX_FIX_GAP_MS = 1500;
/** An orientation change this large (rad) or a gravity reference this unsteady reads as the phone moving. */
export const SPIKE_ORIENTATION_RAD = 0.35;
export const SPIKE_GRAVITY_MAX = 0.5;
const SPIKE_WINDOW_MS = 2000;

interface Episode {
  id: string;
  kind: HarshKind;
  startedAt: number;
  lastTs: number;
  rows: number;
  peakG: number;
  /** Cornering: the sign of the lateral force at the peak (+1 left, −1 right). */
  peakSign: number;
  speedAtPeakMph: number | null;
  maxSpeedMph: number;
  /** The lines of its first row: its tier and the event's `lineG`. */
  lines: HardLines;
  /** The GNSS vouched for it: a matching Δspeed (brake/accel) or a plausible course rate (corner). */
  confirmed: boolean;
  spike: boolean;
  /** Its alert has been told (`alerts()`). */
  alerted: boolean;
}

interface Evidence {
  deltaG: number | null;
  /** The lateral acceleration the course rate × speed implies, g; null without two usable courses. */
  lateralG: number | null;
  /** The signed course change, degrees (positive clockwise: a right turn); null with `lateralG`. */
  turnDeg: number | null;
  /** Both fixes are rated within `GNSS_ONLY_ACC_MAX_MPS`, so `deltaG` may stand in for the IMU. */
  gnssOnly: boolean;
}

/** The forward axis is not learned (yet): the IMU reports no forward extremes at all. */
const axisUnknown = (row: FeatureRow): boolean => row.aLonMax === 0 && row.aLonMin === 0;

const wellRated = (row: FeatureRow): boolean => row.speedAcc >= 0 && row.speedAcc <= GNSS_ONLY_ACC_MAX_MPS;

/** A course the fix knows: degrees clockwise from north; −1 (or anything else out of range) is unknown. */
const courseKnown = (course: number): boolean => course >= 0 && course <= 360;

/** The row reports no sideways extremes (the forward axis is not learned): the gyroscope stands in. */
const lateralUnknown = (row: FeatureRow): boolean => row.aLatMax === 0 && row.aLatMin === 0;

/** The row's lateral force at its larger extreme, signed (left-positive). */
const lateralPeak = (row: FeatureRow): number => (Math.abs(row.aLatMax) >= Math.abs(row.aLatMin) ? row.aLatMax : row.aLatMin);

/**
 * The side of the row's cornering force (+1 left, −1 right): its sideways extremes', else the
 * course's (a clockwise turn is a right turn).
 */
const cornerSide = (row: FeatureRow, ev: Evidence): number => (lateralUnknown(row) ? -Math.sign(ev.turnDeg ?? 0) : Math.sign(lateralPeak(row)));

/**
 * The row's cornering signal at or past `minG`, g, or null. With sideways extremes: the force, not a
 * wobble, and the gyroscope turned the phone with it (speed × yaw rate ≥ `CORNER_YAW_SHARE` of the
 * force). With none (the forward axis not learned): the lesser of speed × yaw rate and the force the
 * row's GPS course turn implies.
 */
function cornerPeak(row: FeatureRow, minG: number, ev: Evidence): number | null {
  const v = knownSpeed(row);
  if (v === null || !Number.isFinite(row.yawRateMax)) return null;
  const turning = (v * row.yawRateMax) / G_MPS2;
  if (lateralUnknown(row)) {
    if (ev.lateralG === null || ev.turnDeg === null || ev.turnDeg === 0) return null;
    const bounded = Math.min(turning, ev.lateralG);
    return bounded >= minG ? bounded : null;
  }
  const lateral = Math.abs(lateralPeak(row));
  if (!(lateral >= minG)) return null;
  if (row.aLatMax >= CORNER_WOBBLE_G && row.aLatMin <= -CORNER_WOBBLE_G) return null;
  return turning >= CORNER_YAW_SHARE * lateral ? lateral : null;
}

/**
 * `gnss`: the GNSS Δspeed (g) standing in for the forward IMU, or null; `minG`: the row's minor line;
 * `ev`: the row's GNSS evidence.
 */
function peakOf(kind: HarshKind, row: FeatureRow, gnss: number | null, minG: number, ev: Evidence): number | null {
  switch (kind) {
    case 'hard_brake':
      if (-row.aLonMin >= minG) return -row.aLonMin;
      return gnss !== null && -gnss >= minG ? -gnss : null;
    case 'hard_accel':
      if (row.aLonMax >= minG) return row.aLonMax;
      return gnss !== null && gnss >= minG ? gnss : null;
    case 'hard_corner':
      return cornerPeak(row, minG, ev);
  }
}

/** Signed difference of two headings, degrees in (-180, 180]. */
const courseDelta = (a: number, b: number): number => {
  let d = b - a;
  while (d > 180) d -= 360;
  while (d <= -180) d += 360;
  return d;
};

const tierOf = (ep: Episode): Tier => (ep.peakG >= ep.lines.severe ? 'severe' : 'minor');

/** Hard events, plus their alerts as each episode is confirmed. */
export interface HarshDetector extends Detector {
  /** The episodes first confirmed on the latest row (each told once): alert them now. */
  alerts(): HarshAlert[];
}

export function createHarshDetector(newId: () => string): HarshDetector {
  let prev: FeatureRow | null = null;
  const open: Record<HarshKind, Episode | null> = { hard_brake: null, hard_accel: null, hard_corner: null };
  let pending: Episode[] = [];
  let lastSpikeTs: number | null = null;
  /** A row this drive has had forward extremes: the axis is learned, and the GNSS no longer stands in. */
  let axisSeen = false;
  let told: HarshAlert[] = [];

  /**
   * Evidence this row carries about the second it covers: needs the previous valid fix, and both
   * speeds trusted (an untrusted speed confirms nothing); the course rate also two known courses
   * that did not jump.
   */
  function evidence(row: FeatureRow): Evidence {
    const none: Evidence = { deltaG: null, lateralG: null, turnDeg: null, gnssOnly: false };
    const speed = knownSpeed(row);
    const before = prev === null ? null : knownSpeed(prev);
    if (prev === null || speed === null || before === null) return none;
    if (!speedTrusted(row) || !speedTrusted(prev)) return none;
    const dtMs = row.ts - prev.ts;
    if (dtMs <= 0 || dtMs > MAX_FIX_GAP_MS) return none;
    const dtS = dtMs / 1000;
    const deltaG = (speed - before) / dtS / G_MPS2;
    const gnssOnly = wellRated(row) && wellRated(prev);
    if (!courseKnown(row.course) || !courseKnown(prev.course)) return { deltaG, lateralG: null, turnDeg: null, gnssOnly };
    // Lateral acceleration from the turn: v × ω, with ω the course rate.
    const turnDeg = courseDelta(prev.course, row.course);
    const rateDegS = Math.abs(turnDeg) / dtS;
    const meanMps = (speed + before) / 2;
    const lateralG = (meanMps * ((rateDegS * Math.PI) / 180)) / G_MPS2;
    if (rateDegS > COURSE_JUMP_DEG_S && lateralG > GNSS_ONLY_MAX_G && meanMps >= CORNER_MIN_MPH * MPS_PER_MPH) return { deltaG, lateralG: null, turnDeg: null, gnssOnly };
    return { deltaG, lateralG, turnDeg, gnssOnly };
  }

  function confirms(ep: Episode, ev: Evidence): boolean {
    switch (ep.kind) {
      case 'hard_brake':
        return ev.deltaG !== null && -ev.deltaG >= GNSS_CONFIRM_G;
      case 'hard_accel':
        return ev.deltaG !== null && ev.deltaG >= GNSS_CONFIRM_G;
      case 'hard_corner':
        // A force to the left (positive) is a left turn: the clockwise course falls (negative).
        return ev.lateralG !== null && ev.turnDeg !== null && ev.turnDeg !== 0 && Math.sign(ev.turnDeg) === -ep.peakSign && ev.lateralG >= CORNER_PLAUSIBLE_SHARE * ep.peakG;
    }
  }

  function toEvent(ep: Episode): DetectedEvent {
    const measured: DetectedEvent['measured'] = { peakG: round2(ep.peakG) };
    if (ep.speedAtPeakMph !== null) measured.speedMph = round1(ep.speedAtPeakMph);
    if (ep.lines.minor < hardLines(ep.kind).minor) measured.lineG = ep.lines.minor;
    return { id: ep.id, type: ep.kind, tier: tierOf(ep), startedAt: ep.startedAt, durationS: ep.rows, measured };
  }

  /** Confirmed, not vetoed, and the car at 5 mph or more: an event if nothing vetoes it later. */
  const counts = (ep: Episode): boolean => ep.confirmed && !ep.spike && ep.maxSpeedMph >= MOVING_MIN_MPH;

  return {
    push(row, _limit, ctx) {
      const spike = row.orientationDelta > SPIKE_ORIENTATION_RAD || row.gravityStability < SPIKE_GRAVITY_MAX;
      if (spike) lastSpikeTs = row.ts;
      const ev = evidence(row);
      const speedMph = knownSpeedMph(row);
      const eligible = rowEligible(row, ctx);
      if (!axisUnknown(row)) axisSeen = true;
      const gnss = !axisSeen && ev.gnssOnly && ev.deltaG !== null && Math.abs(ev.deltaG) <= GNSS_ONLY_MAX_G ? ev.deltaG : null;

      for (const kind of KINDS) {
        const lines = hardLines(kind, row.road?.g);
        const peak = eligible ? peakOf(kind, row, gnss, lines.minor, ev) : null;
        const cornerTooSlow = kind === 'hard_corner' && (speedMph === null || speedMph < CORNER_MIN_MPH);
        const signal = peak !== null && !cornerTooSlow;
        const ep = open[kind];
        if (signal && ep !== null) {
          ep.rows += 1;
          ep.lastTs = row.ts;
          if (peak > ep.peakG) {
            ep.peakG = peak;
            ep.peakSign = cornerSide(row, ev);
            ep.speedAtPeakMph = speedMph;
          }
          ep.maxSpeedMph = Math.max(ep.maxSpeedMph, speedMph ?? 0);
          ep.confirmed = ep.confirmed || confirms(ep, ev);
          ep.spike = ep.spike || spike;
        } else if (signal) {
          const fresh: Episode = {
            id: newId(),
            kind,
            startedAt: row.ts,
            lastTs: row.ts,
            rows: 1,
            peakG: peak,
            peakSign: cornerSide(row, ev),
            speedAtPeakMph: speedMph,
            maxSpeedMph: Math.max(speedMph ?? 0, prev === null ? 0 : (knownSpeedMph(prev) ?? 0)),
            lines,
            confirmed: false,
            spike: spike || (lastSpikeTs !== null && row.ts - lastSpikeTs <= SPIKE_WINDOW_MS),
            alerted: false,
          };
          fresh.confirmed = confirms(fresh, ev);
          open[kind] = fresh;
        } else if (ep !== null) {
          pending.push(ep);
          open[kind] = null;
        }
      }

      // The row after an episode still speaks for it: the GNSS lags the IMU by up to a second, and
      // a phone that falls a moment later vetoes it.
      for (const ep of pending) {
        if (row.ts <= ep.lastTs + MAX_FIX_GAP_MS) {
          ep.confirmed = ep.confirmed || confirms(ep, ev);
          ep.maxSpeedMph = Math.max(ep.maxSpeedMph, speedMph ?? 0);
        }
        if (spike && row.ts <= ep.lastTs + SPIKE_WINDOW_MS) ep.spike = true;
      }
      // Told the first row it counts, open or held: the driver hears it now, not after the hold.
      told = [];
      for (const ep of [...KINDS.map((k) => open[k]), ...pending]) {
        if (ep === null || ep.alerted || !counts(ep)) continue;
        ep.alerted = true;
        told.push({ id: ep.id, type: ep.kind, tier: tierOf(ep) });
      }
      const released = pending.filter((ep) => row.ts > ep.lastTs + SPIKE_WINDOW_MS);
      pending = pending.filter((ep) => row.ts <= ep.lastTs + SPIKE_WINDOW_MS);
      prev = row;
      return released.filter(counts).map(toEvent);
    },
    flush() {
      told = [];
      const closing = [...pending];
      pending = [];
      for (const kind of KINDS) {
        const ep = open[kind];
        if (ep !== null) closing.push(ep);
        open[kind] = null;
      }
      return closing.filter(counts).map(toEvent);
    },
    alerts: () => told,
  };
}

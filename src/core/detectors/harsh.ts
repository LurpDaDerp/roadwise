// Hard braking, hard acceleration and hard cornering (product spec v3 event table, "Rules against
// false positives") from the per-second IMU extremes:
// - braking ≥ 0.30 g (severe ≥ 0.45) and acceleration ≥ 0.28 g (severe ≥ 0.40) count only when
//   the GNSS speed changed to match (a drop, or a rise, of at least `GNSS_CONFIRM_G` over a second
//   inside or right after the episode), read only from two fixes whose speed the phone rates at
//   2 m/s or better (`speedTrusted`);
// - until the phone has learned the car's forward axis (no row this drive has had forward
//   extremes), the GNSS speed change itself stands in for them, from two fixes rated at
//   `GNSS_ONLY_ACC_MAX_MPS` or better: a second's mean is never above its peak, so it can only
//   under-read, and a change past `GNSS_ONLY_MAX_G` is a jump in the fix;
// - cornering ≥ 0.40 g (severe ≥ 0.55) counts only when the GNSS course rate × speed makes that
//   much lateral acceleration plausible;
// - a phone sliding or dropping — an orientation spike or a lost gravity reference within two
//   seconds — is ignored, whatever the IMU says.
// Each kind runs as an episode of consecutive signal rows; a closed episode is held for two seconds
// so the row after it can still confirm or veto it, then released as at most one event.
import { HARD_ACCEL_G, HARD_BRAKE_G, HARD_CORNER_G, PHONE_MIN_MPH, type Tier } from '@scoring';

import type { DetectedEvent, Detector, FeatureRow } from '../engine/types';
import { G_MPS2, knownSpeed, knownSpeedMph, round1, round2, rowEligible, speedTrusted } from './common';

type Kind = 'hard_brake' | 'hard_accel' | 'hard_corner';
const KINDS: readonly Kind[] = ['hard_brake', 'hard_accel', 'hard_corner'];

/** The GNSS Δspeed over a second that confirms an IMU extreme (1 Hz averaging halves a peak). */
export const GNSS_CONFIRM_G = 0.1;
/** Before the forward axis is learned, a GNSS Δspeed counts on its own only from fixes rated this well (m/s). */
export const GNSS_ONLY_ACC_MAX_MPS = 1;
/** A GNSS Δspeed past this in a second is a jump in the fix, not the car, and stands in for nothing. */
export const GNSS_ONLY_MAX_G = 1;
/** The course-rate estimate must reach this share of the IMU's lateral peak. */
export const CORNER_PLAUSIBLE_SHARE = 0.4;
/** Cornering is judged only at or above this speed; below it the course is noise. */
export const CORNER_MIN_MPH = 10;
/** Consecutive fixes farther apart than this cannot vouch for the same second. */
const MAX_FIX_GAP_MS = 1500;
/** An orientation change this large (rad) or a gravity reference this unsteady reads as the phone moving. */
export const SPIKE_ORIENTATION_RAD = 0.35;
export const SPIKE_GRAVITY_MAX = 0.5;
const SPIKE_WINDOW_MS = 2000;

interface Episode {
  id: string;
  kind: Kind;
  startedAt: number;
  lastTs: number;
  rows: number;
  peakG: number;
  speedAtPeakMph: number | null;
  maxSpeedMph: number;
  /** The GNSS vouched for it: a matching Δspeed (brake/accel) or a plausible course rate (corner). */
  confirmed: boolean;
  spike: boolean;
}

const THRESHOLDS: Record<Kind, { minor: number; severe: number }> = {
  hard_brake: HARD_BRAKE_G,
  hard_accel: HARD_ACCEL_G,
  hard_corner: HARD_CORNER_G,
};

interface Evidence {
  deltaG: number | null;
  lateralG: number | null;
  /** Both fixes are rated within `GNSS_ONLY_ACC_MAX_MPS`, so `deltaG` may stand in for the IMU. */
  gnssOnly: boolean;
}

/** The forward axis is not learned (yet): the IMU reports no forward extremes at all. */
const axisUnknown = (row: FeatureRow): boolean => row.aLonMax === 0 && row.aLonMin === 0;

const wellRated = (row: FeatureRow): boolean => row.speedAcc >= 0 && row.speedAcc <= GNSS_ONLY_ACC_MAX_MPS;

/** `gnss`: the GNSS Δspeed (g) standing in for the forward IMU, or null. */
function peakOf(kind: Kind, row: FeatureRow, gnss: number | null): number | null {
  switch (kind) {
    case 'hard_brake':
      if (-row.aLonMin >= HARD_BRAKE_G.minor) return -row.aLonMin;
      return gnss !== null && -gnss >= HARD_BRAKE_G.minor ? -gnss : null;
    case 'hard_accel':
      if (row.aLonMax >= HARD_ACCEL_G.minor) return row.aLonMax;
      return gnss !== null && gnss >= HARD_ACCEL_G.minor ? gnss : null;
    case 'hard_corner': {
      const lateral = Math.max(Math.abs(row.aLatMax), Math.abs(row.aLatMin));
      return lateral >= HARD_CORNER_G.minor ? lateral : null;
    }
  }
}

/** Signed difference of two headings, degrees in (-180, 180]. */
const courseDelta = (a: number, b: number): number => {
  let d = b - a;
  while (d > 180) d -= 360;
  while (d <= -180) d += 360;
  return d;
};

export function createHarshDetector(newId: () => string): Detector {
  let prev: FeatureRow | null = null;
  const open: Record<Kind, Episode | null> = { hard_brake: null, hard_accel: null, hard_corner: null };
  let pending: Episode[] = [];
  let lastSpikeTs: number | null = null;
  /** A row this drive has had forward extremes: the axis is learned, and the GNSS no longer stands in. */
  let axisSeen = false;

  /**
   * Evidence this row carries about the second it covers: needs the previous valid fix, and both
   * speeds trusted (an untrusted speed confirms nothing).
   */
  function evidence(row: FeatureRow): Evidence {
    const none: Evidence = { deltaG: null, lateralG: null, gnssOnly: false };
    const speed = knownSpeed(row);
    const before = prev === null ? null : knownSpeed(prev);
    if (prev === null || speed === null || before === null) return none;
    if (!speedTrusted(row) || !speedTrusted(prev)) return none;
    const dtMs = row.ts - prev.ts;
    if (dtMs <= 0 || dtMs > MAX_FIX_GAP_MS) return none;
    const dtS = dtMs / 1000;
    const deltaG = (speed - before) / dtS / G_MPS2;
    // Lateral acceleration from the turn: v × ω, with ω the course rate.
    const omega = (Math.abs(courseDelta(prev.course, row.course)) * Math.PI) / 180 / dtS;
    const lateralG = ((speed + before) / 2) * omega / G_MPS2;
    return { deltaG, lateralG, gnssOnly: wellRated(row) && wellRated(prev) };
  }

  function confirms(ep: Episode, ev: Evidence): boolean {
    switch (ep.kind) {
      case 'hard_brake':
        return ev.deltaG !== null && -ev.deltaG >= GNSS_CONFIRM_G;
      case 'hard_accel':
        return ev.deltaG !== null && ev.deltaG >= GNSS_CONFIRM_G;
      case 'hard_corner':
        return ev.lateralG !== null && ev.lateralG >= CORNER_PLAUSIBLE_SHARE * ep.peakG;
    }
  }

  function toEvent(ep: Episode): DetectedEvent {
    const tier: Tier = ep.peakG >= THRESHOLDS[ep.kind].severe ? 'severe' : 'minor';
    const measured: DetectedEvent['measured'] = { peakG: round2(ep.peakG) };
    if (ep.speedAtPeakMph !== null) measured.speedMph = round1(ep.speedAtPeakMph);
    return { id: ep.id, type: ep.kind, tier, startedAt: ep.startedAt, durationS: ep.rows, measured };
  }

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
        const peak = eligible ? peakOf(kind, row, gnss) : null;
        const cornerTooSlow = kind === 'hard_corner' && (speedMph === null || speedMph < CORNER_MIN_MPH);
        const signal = peak !== null && !cornerTooSlow;
        const ep = open[kind];
        if (signal && ep !== null) {
          ep.rows += 1;
          ep.lastTs = row.ts;
          if (peak > ep.peakG) {
            ep.peakG = peak;
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
            speedAtPeakMph: speedMph,
            maxSpeedMph: Math.max(speedMph ?? 0, prev === null ? 0 : (knownSpeedMph(prev) ?? 0)),
            confirmed: false,
            spike: spike || (lastSpikeTs !== null && row.ts - lastSpikeTs <= SPIKE_WINDOW_MS),
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
      const released = pending.filter((ep) => row.ts > ep.lastTs + SPIKE_WINDOW_MS);
      pending = pending.filter((ep) => row.ts <= ep.lastTs + SPIKE_WINDOW_MS);
      prev = row;
      return released.filter((ep) => ep.confirmed && !ep.spike && ep.maxSpeedMph >= PHONE_MIN_MPH).map(toEvent);
    },
    flush() {
      const closing = [...pending];
      pending = [];
      for (const kind of KINDS) {
        const ep = open[kind];
        if (ep !== null) closing.push(ep);
        open[kind] = null;
      }
      return closing.filter((ep) => ep.confirmed && !ep.spike && ep.maxSpeedMph >= PHONE_MIN_MPH).map(toEvent);
    },
  };
}

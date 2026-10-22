// The direction the driving screen's compass shows (round 8 decision 7). Display only: nothing
// scores, ends a drive or looks up a limit on it.
//
// The bearing comes from where the car went, never from where the phone points, so a phone tilted
// or turned in its mount changes nothing:
// B1, the track: the newest fix against the most recent earlier fix of the last `BEARING_WINDOW_MS`
//   that lies far enough back to say which way the car went: at least the two fixes' accuracy
//   together, never under `BEARING_MIN_M` nor asked for over `BEARING_MAX_M`. A fix only counts on a
//   valid position no worse than `BEARING_MAX_HACC_M`, and a pair faster than `BEARING_MAX_MPS`
//   (a position jump) is passed over. A crawl in heavy traffic (2 m/s) gives its first bearing
//   after about 8 s; 10 m/s after about 2 s.
// B2, the GPS course: on a row moving at 5 mph or more with a course, it stands in when there is no
//   track pair, and it wins when the track disagrees by more than `COURSE_DISAGREE_DEG` (the track
//   lags through a turn by up to its pair's length).
// B3, held: a row under `BEARING_MOVING_MPS` (stopped, or the speed unknown), a lost or poor fix, or
//   a moving row with neither a pair nor a course keeps the last bearing as it is, so GPS jitter at
//   a light never turns the compass. Before the drive's first bearing it is null (the screen falls
//   back to the phone's own heading). A new drive starts from `NO_BEARING`.
import { knownSpeed, MPS_PER_MPH } from '@/core/detectors/common';
import { angleDiffDeg, normalizeDeg } from '@/core/speedLimits/geometry';

import type { FeatureRow } from './types';

/** B1: fixes older than this (row clock) are never paired. */
export const BEARING_WINDOW_MS = 15_000;
/** B1: a fix worse than this (m) is not paired; it holds the bearing. */
export const BEARING_MAX_HACC_M = 30;
/** B1: a pair is at least this far apart (m)… */
export const BEARING_MIN_M = 15;
/** …and at least the two fixes' accuracy together, which is never asked for beyond this (m). */
export const BEARING_MAX_M = 40;
/** B1: a pair implying more than this (m/s, about 155 mph) is a position jump, not travel. */
export const BEARING_MAX_MPS = 70;
/** B3: under this known speed (3 mph) the car is stopped or crawling and the bearing holds. */
export const BEARING_MOVING_MPS = 3 * MPS_PER_MPH;
/** B2: the GPS course is used only at this speed or faster (5 mph): slower it is noise. */
export const BEARING_COURSE_MIN_MPS = 5 * MPS_PER_MPH;
/** B2: the course wins over a track bearing that differs from it by more than this. */
export const COURSE_DISAGREE_DEG = 45;
/** The window holds at most this many fixes (15 s at 1 Hz is 15). */
const MAX_FIXES = 32;

const M_PER_DEG = (6_371_008.8 * Math.PI) / 180;
const RAD = Math.PI / 180;

/** One fix in the window (row clock). */
export interface BearingFix {
  ts: number;
  lat: number;
  lng: number;
  hAcc: number;
}

export type DisplayBearing = Readonly<{
  /** Degrees clockwise from true north, [0, 360), or null before the drive's first. */
  deg: number | null;
  /** The row the bearing was last set on, or null before the first. */
  at: number | null;
  /** The usable fixes of the last `BEARING_WINDOW_MS`, oldest first. */
  fixes: readonly BearingFix[];
}>;

export const NO_BEARING: DisplayBearing = Object.freeze({ deg: null, at: null, fixes: Object.freeze([]) as readonly BearingFix[] });

/** The local metres east and north from `a` to `b` (equirectangular: exact enough at these distances). */
function offsetM(a: BearingFix, b: BearingFix): { east: number; north: number } {
  const midLat = ((a.lat + b.lat) / 2) * RAD;
  return { east: (b.lng - a.lng) * Math.cos(midLat) * M_PER_DEG, north: (b.lat - a.lat) * M_PER_DEG };
}

/** B1: the bearing from the most recent fix far enough behind `now`, or null when none is. */
function trackBearing(fixes: readonly BearingFix[], now: BearingFix): number | null {
  for (let i = fixes.length - 1; i >= 0; i -= 1) {
    const then = fixes[i] as BearingFix;
    const { east, north } = offsetM(then, now);
    const d = Math.hypot(east, north);
    const need = Math.min(BEARING_MAX_M, Math.max(BEARING_MIN_M, then.hAcc + now.hAcc));
    if (d < need) continue;
    const dt = (now.ts - then.ts) / 1000;
    if (!(dt > 0) || d / dt > BEARING_MAX_MPS) continue;
    return normalizeDeg(Math.atan2(east, north) / RAD);
  }
  return null;
}

/** B2: the row's GPS course when it may be used, else null. */
function courseOf(row: FeatureRow, speed: number | null): number | null {
  if (speed === null || speed < BEARING_COURSE_MIN_MPS) return null;
  if (!Number.isFinite(row.course) || row.course < 0 || row.course > 360) return null;
  return normalizeDeg(row.course);
}

/** The bearing after `row` (one engine row, live or replayed). Pure; `prev` is never changed. */
export function nextBearing(prev: DisplayBearing, row: FeatureRow): DisplayBearing {
  if (!row.gnssValid || !Number.isFinite(row.lat) || !Number.isFinite(row.lng) || !Number.isFinite(row.ts)) return prev;
  const newest = prev.fixes[prev.fixes.length - 1];
  // A row no newer than the window's newest fix adds nothing (the engine never sends one).
  if (newest !== undefined && row.ts <= newest.ts) return prev;
  const kept = prev.fixes.filter((f) => f.ts >= row.ts - BEARING_WINDOW_MS);
  const usable = row.hAcc >= 0 && row.hAcc <= BEARING_MAX_HACC_M;
  const now: BearingFix | null = usable ? { ts: row.ts, lat: row.lat, lng: row.lng, hAcc: row.hAcc } : null;
  const fixes = now === null ? kept : [...kept, now].slice(-MAX_FIXES);

  const speed = knownSpeed(row);
  let deg: number | null = null;
  if (speed !== null && speed >= BEARING_MOVING_MPS) {
    const track = now === null ? null : trackBearing(kept, now);
    const course = courseOf(row, speed);
    if (track !== null && course !== null && angleDiffDeg(track, course) > COURSE_DISAGREE_DEG) deg = course;
    else deg = track ?? course;
  }
  if (deg === null) return Object.freeze({ deg: prev.deg, at: prev.at, fixes: Object.freeze(fixes) });
  return Object.freeze({ deg, at: row.ts, fixes: Object.freeze(fixes) });
}

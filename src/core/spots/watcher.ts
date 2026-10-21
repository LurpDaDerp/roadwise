/**
 * The driving screen's spot nudge (spots.md §7.2): fed every row of a recording drive, it says when
 * an active spot lies just ahead in the direction of travel, so the screen can show one silent
 * line for a few seconds. Pure: the host owns the clock (the row's ts) and the foreground state.
 *
 * Per row, in order: nothing unless a drive records with RoadWise in front (nothing is used up
 * meanwhile); nothing without a good fix at 10 mph or more with a course; at most 3 per drive, 60 s
 * apart; the spot must lie 40 m to 12 s ahead (120..400 m), heading its way, ahead of the car and
 * not off to the side; the nearest wins. A busy screen (an alert showing) waits for a later row
 * without using the spot up. A speeding spot while already over the line is used up silently.
 */
import { angleDiffDeg } from '@/core/speedLimits/geometry';
import { bearingDeg } from '@/lib/geo';

import {
  MPH_TO_MPS,
  NUDGE_AHEAD_TOL_DEG,
  NUDGE_GAP_MS,
  NUDGE_HEADING_TOL_DEG,
  NUDGE_INSIDE_M,
  NUDGE_LATERAL_M,
  NUDGE_LEAD_MAX_M,
  NUDGE_LEAD_MIN_M,
  NUDGE_LEAD_S,
  NUDGE_MAX_H_ACC_M,
  NUDGE_MAX_PER_DRIVE,
  NUDGE_MIN_MPH,
  NUDGE_PREFILTER_M,
} from './constants';
import type { SpotNudge, SpotWatcher, WatchInput, WatchSpot } from './types';

export type { SpotNudge, SpotWatcher, WatchInput, WatchSpot } from './types';

/** Metres per degree of latitude. */
const M_PER_DEG = (Math.PI / 180) * 6371008.8;

/** How far ahead a nudge shows at `speedMps`: 12 s of road, held between 120 and 400 m. */
export function nudgeLeadM(speedMps: number): number {
  return Math.min(NUDGE_LEAD_MAX_M, Math.max(NUDGE_LEAD_MIN_M, speedMps * NUDGE_LEAD_S));
}

/** Equirectangular distance in metres (plenty within a kilometre). */
function distM(a: { lat: number; lng: number }, b: { lat: number; lng: number }): number {
  const k = Math.cos((((a.lat + b.lat) / 2) * Math.PI) / 180);
  return Math.hypot(b.lat - a.lat, (b.lng - a.lng) * k) * M_PER_DEG;
}

/** A watcher over one drive's spots; it remembers which it already showed. */
export function createSpotWatcher(spots: readonly WatchSpot[]): SpotWatcher {
  const list = [...spots].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  const done = new Set<string>();
  let shown = 0;
  let lastAt: number | null = null;

  return {
    push(input: WatchInput): SpotNudge | null {
      if (!input.recording || !input.foreground) return null;
      const course = input.courseDeg;
      if (!input.gnssValid || !(input.hAcc >= 0 && input.hAcc <= NUDGE_MAX_H_ACC_M) || !(input.speedMps >= NUDGE_MIN_MPH * MPH_TO_MPS) || course === null || !Number.isFinite(course)) return null;
      if (shown >= NUDGE_MAX_PER_DRIVE || (lastAt !== null && input.ts - lastAt < NUDGE_GAP_MS)) return null;

      const lead = nudgeLeadM(input.speedMps);
      const car = { lat: input.lat, lng: input.lng };
      let best: WatchSpot | null = null;
      let bestD = Infinity;
      for (const s of list) {
        if (done.has(s.id)) continue;
        const d = distM(car, s);
        if (d > NUDGE_PREFILTER_M || !(d > NUDGE_INSIDE_M && d <= lead)) continue;
        if (angleDiffDeg(course, s.headingDeg) > NUDGE_HEADING_TOL_DEG) continue;
        const off = angleDiffDeg(course, bearingDeg(car, s));
        if (off > NUDGE_AHEAD_TOL_DEG || d * Math.sin((off * Math.PI) / 180) > NUDGE_LATERAL_M) continue;
        if (d < bestD) {
          best = s;
          bestD = d;
        }
      }
      if (best === null || input.busy) return null;
      done.add(best.id);
      // The speeding alert already speaks: the spot is spent without a word or a count.
      if (best.kind === 'speeding' && input.speedingOver) return null;
      shown += 1;
      lastAt = input.ts;
      return { key: `${best.id}@${input.ts}`, spotId: best.id, kind: best.kind, at: input.ts };
    },
  };
}

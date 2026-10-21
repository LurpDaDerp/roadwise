// Speeding episodes (product spec "Speeding"): a usable row (an actionable limit, a speed the phone
// rates at 2 m/s or better, a good fix, past the warm-up) whose speed is beyond the points line
// L + T(L) is an over row. The first over row opens an episode (the driving screen alerts on it);
// the episode ends after `SPEEDING_END_S` rows in a row back under L + T − 2 mph or without a usable
// row (hovering in that 2-mph buffer neither extends nor ends it, so hovering at the line is one
// episode, alerted once). An episode is an event only once it has MORE than `SPEEDING_GRACE_S` over
// rows (the 6th one), whatever its tier: the driver gets the grace to react to the alert. An episode
// that never gets there is never an event, costs nothing and takes no safe miles.
//
// The event: `startedAt` the first over row, `durationS` every over row (the grace's included),
// the tier by its peak, `measured.overMphS` the mph past the line summed over the over rows after
// the grace (what the cost reads, `speedingCost`), and the peak speed with the limit there.
import { speedTier, speedTolerance, SPEEDING_END_BUFFER_MPH, SPEEDING_END_S, SPEEDING_GRACE_S, type Tier } from '@scoring';

import type { DetectedEvent, Detector, OpenEpisode, SpeedingEpisode, SpeedingReading } from '../engine/types';
import { knownSpeedMph, limitMphFor, round1, rowEligible, speedTrusted } from './common';

const RANK: Record<Tier, number> = { minor: 0, moderate: 1, severe: 2 };
const worse = (a: Tier, b: Tier): Tier => (RANK[a] >= RANK[b] ? a : b);

interface Episode {
  id: string;
  startedAt: number;
  /** Over rows so far: the event's `durationS`. */
  overRows: number;
  /** Σ (speed − (L + T)) over the over rows after the first `SPEEDING_GRACE_S`, mph (unrounded). */
  overMphS: number;
  /** Consecutive rows back under L + T − 2 (or without a usable row). */
  belowRows: number;
  peak: Tier;
  peakSpeedMph: number;
  limitAtPeak: number;
  /** The current row is beyond the line, at this tier. */
  current: Tier | null;
}

/** The episode is an event: it has more over rows than the grace. */
const confirmed = (e: Episode): boolean => e.overRows > SPEEDING_GRACE_S;

export interface SpeedingDetector extends Detector {
  /** The episode in progress while the current row is beyond the line, else null. */
  open(): OpenEpisode | null;
  /** The episode in progress (its end window included), whatever the current row, or null. */
  episode(): SpeedingEpisode | null;
  /** An episode past its grace is open (its end window included): the row's distance is not safe miles. */
  active(): boolean;
  /** The latest row's reading, or null when the row was not usable. */
  reading(): SpeedingReading | null;
}

export function createSpeedingDetector(newId: () => string): SpeedingDetector {
  let ep: Episode | null = null;
  let now: SpeedingReading | null = null;

  const close = (): DetectedEvent[] => {
    const e = ep;
    ep = null;
    if (e === null || !confirmed(e)) return [];
    return [
      {
        id: e.id,
        type: 'speeding',
        tier: e.peak,
        startedAt: e.startedAt,
        durationS: e.overRows,
        measured: { speedMph: round1(e.peakSpeedMph), limitMph: e.limitAtPeak, overMphS: round1(e.overMphS) },
      },
    ];
  };

  return {
    push(row, limit, ctx) {
      const limitMph = limitMphFor(row, limit);
      const speedMph = knownSpeedMph(row);
      const usable = limitMph !== null && speedMph !== null && speedTrusted(row) && rowEligible(row, ctx);
      const line = usable ? limitMph + speedTolerance(limitMph) : null;
      now = usable && line !== null ? { ratio: speedMph / limitMph, overMph: speedMph - line } : null;
      const tier = usable ? speedTier(speedMph, limitMph) : null;

      if (tier !== null && usable && line !== null) {
        if (ep === null) {
          ep = { id: newId(), startedAt: row.ts, overRows: 0, overMphS: 0, belowRows: 0, peak: tier, peakSpeedMph: speedMph, limitAtPeak: limitMph, current: tier };
        }
        ep.overRows += 1;
        if (ep.overRows > SPEEDING_GRACE_S) ep.overMphS += Math.max(0, speedMph - line);
        ep.belowRows = 0;
        ep.current = tier;
        if (RANK[tier] > RANK[ep.peak] || (tier === ep.peak && speedMph > ep.peakSpeedMph)) {
          ep.peak = worse(tier, ep.peak);
          ep.peakSpeedMph = speedMph;
          ep.limitAtPeak = limitMph;
        }
        return [];
      }

      if (ep === null) return [];
      ep.current = null;
      // Hovering between L + T − 2 and L + T neither extends the episode nor ends it; a row that is
      // not usable cannot vouch for the speed, so it counts toward the end.
      const under = !usable || line === null || speedMph < line - SPEEDING_END_BUFFER_MPH;
      ep.belowRows = under ? ep.belowRows + 1 : 0;
      return ep.belowRows >= SPEEDING_END_S ? close() : [];
    },
    flush: close,
    open() {
      if (ep === null || ep.current === null) return null;
      return { id: ep.id, type: 'speeding', tier: ep.current, startedAt: ep.startedAt, confirmed: confirmed(ep) };
    },
    episode() {
      if (ep === null) return null;
      return { id: ep.id, startedAt: ep.startedAt, overRows: ep.overRows, overMphS: ep.overMphS, confirmed: confirmed(ep), over: ep.current !== null };
    },
    active: () => ep !== null && confirmed(ep),
    reading: () => now,
  };
}

// Speeding episodes (product spec v3 "Speeding threshold"): speed beyond L + T(L) on a usable fix
// with an actionable limit, continuously for 5 s (3 s once severe) before it counts as an incident.
// A speed the phone rates worse than 2 m/s (`speedTrusted`) is no usable row, like a poor fix.
// Before that confirmation any row back under L + T drops the episode — five scattered blips are
// not an incident. Once confirmed, one continuous episode is one incident, tiered by its peak; it
// ends after 5 s back under L + T − 2 mph (hovering in that 2-mph buffer neither extends nor ends
// it). Only a confirmed episode takes miles out of the safe miles.
import { speedTier, speedTolerance, SPEEDING_END_BUFFER_MPH, SPEEDING_END_S, SPEEDING_MIN_S, type Tier } from '@scoring';

import type { DetectedEvent, Detector, OpenEpisode, SpeedingReading } from '../engine/types';
import { knownSpeedMph, limitMphFor, round1, rowEligible, speedTrusted } from './common';

const RANK: Record<Tier, number> = { minor: 0, moderate: 1, severe: 2 };
const worse = (a: Tier, b: Tier): Tier => (RANK[a] >= RANK[b] ? a : b);

interface Episode {
  id: string;
  startedAt: number;
  /** Rows beyond the threshold so far — the event's `durationS`. */
  overRows: number;
  /** Consecutive rows back under L + T − 2 (or without a usable limit), after confirmation. */
  belowRows: number;
  peak: Tier;
  peakSpeedMph: number;
  limitAtPeak: number;
  /** The current row is beyond the threshold, at this tier. */
  current: Tier | null;
  confirmed: boolean;
}

export interface SpeedingDetector extends Detector {
  /** The episode in progress while the current row is beyond the threshold, else null. */
  open(): OpenEpisode | null;
  /** A confirmed episode is open (its end window included): the row's distance is not safe miles. */
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
    if (e === null || !e.confirmed) return [];
    return [
      {
        id: e.id,
        type: 'speeding',
        tier: e.peak,
        startedAt: e.startedAt,
        durationS: e.overRows,
        measured: { speedMph: round1(e.peakSpeedMph), limitMph: e.limitAtPeak },
      },
    ];
  };

  return {
    push(row, limit, ctx) {
      const limitMph = limitMphFor(row, limit);
      const speedMph = knownSpeedMph(row);
      const usable = limitMph !== null && speedMph !== null && speedTrusted(row) && rowEligible(row, ctx);
      const tier = usable ? speedTier(speedMph, limitMph) : null;
      now = usable ? { ratio: speedMph / limitMph, overMph: speedMph - (limitMph + speedTolerance(limitMph)) } : null;

      if (tier !== null && usable) {
        if (ep === null) {
          ep = {
            id: newId(),
            startedAt: row.ts,
            overRows: 0,
            belowRows: 0,
            peak: tier,
            peakSpeedMph: speedMph,
            limitAtPeak: limitMph,
            current: tier,
            confirmed: false,
          };
        }
        ep.overRows += 1;
        ep.belowRows = 0;
        ep.current = tier;
        if (RANK[tier] > RANK[ep.peak] || (tier === ep.peak && speedMph > ep.peakSpeedMph)) {
          ep.peak = worse(tier, ep.peak);
          ep.peakSpeedMph = speedMph;
          ep.limitAtPeak = limitMph;
        }
        const minRows = ep.peak === 'severe' ? SPEEDING_MIN_S.severe : SPEEDING_MIN_S.default;
        if (ep.overRows >= minRows) ep.confirmed = true;
        return [];
      }

      if (ep === null) return [];
      // Not continuously over: an unconfirmed episode is dropped on the spot.
      if (!ep.confirmed) {
        ep = null;
        return [];
      }
      ep.current = null;
      // Hovering between L + T − 2 and L + T neither extends the episode nor ends it; a row with no
      // usable limit cannot vouch for the speed, so it counts toward the end.
      const under = !usable || speedMph < limitMph + speedTolerance(limitMph) - SPEEDING_END_BUFFER_MPH;
      ep.belowRows = under ? ep.belowRows + 1 : 0;
      return ep.belowRows >= SPEEDING_END_S ? close() : [];
    },
    flush: close,
    open() {
      if (ep === null || ep.current === null) return null;
      return { id: ep.id, type: 'speeding', tier: ep.current, startedAt: ep.startedAt, confirmed: ep.confirmed };
    },
    active: () => ep !== null && ep.confirmed,
    reading: () => now,
  };
}

// Speeding episodes (product spec "Speeding"): a usable row (an actionable limit, a speed the phone
// rates at 2 m/s or better, a good fix; from the drive's first row, with no warm-up) whose speed is
// beyond the speeding line A(L) = 1.16 L − 0.8 mph (`speedingLine`, at least L + 1) is an over row.
// The first over row opens an episode (the driving screen alerts on it, "Slow down"); the episode
// ends after `SPEEDING_END_S` rows in a row back under A − 2 mph or without a usable row (hovering
// in that 2-mph buffer neither extends nor ends it, so hovering at the line is one episode, alerted
// once). Every episode is an event from its first
// over row, however short: there is no grace, and every second over the line weighs on Speed.
//
// A row the host stamped with a road state (`row.road`: wet, snow, ice, low visibility) is judged
// against the tightened limit (`judgedLimitMph`): the line and the tier run on it, the posted limit
// stays the one the event names. An unstamped row is judged against the posted limit itself.
//
// The event: `startedAt` the first over row, `durationS` every over row, the tier by its peak,
// `measured.overMphS` the mph past each row's own line summed over every over row (what the Speed
// weight reads), and the peak speed with the posted limit there, plus `lineMph`, the line at the
// peak (1 dp), when the road state tightened that row.
import { judgedLimitMph, speedingLine, speedTier, SPEEDING_END_BUFFER_MPH, SPEEDING_END_S, type Tier } from '@scoring';

import type { DetectedEvent, Detector, OpenEpisode, SpeedingEpisode, SpeedingReading } from '../engine/types';
import { gnssPoor, knownSpeedMph, limitMphFor, round1, speedTrusted } from './common';

const RANK: Record<Tier, number> = { minor: 0, moderate: 1, severe: 2 };
const worse = (a: Tier, b: Tier): Tier => (RANK[a] >= RANK[b] ? a : b);

interface Episode {
  id: string;
  startedAt: number;
  /** Over rows so far: the event's `durationS`. */
  overRows: number;
  /** Σ (speed − A) over every over row, mph (unrounded). */
  overMphS: number;
  /** Consecutive rows back under A − 2 (or without a usable row). */
  belowRows: number;
  peak: Tier;
  peakSpeedMph: number;
  limitAtPeak: number;
  /** The line at the peak when the road state tightened that row's limit, else null. */
  lineAtPeak: number | null;
  /** The current row is beyond the line, at this tier. */
  current: Tier | null;
}

export interface SpeedingDetector extends Detector {
  /** The episode in progress while the current row is beyond the line, else null. */
  open(): OpenEpisode | null;
  /** The episode in progress (its end window included), whatever the current row, or null. */
  episode(): SpeedingEpisode | null;
  /** An episode is open (its end window included): the row's distance is not safe miles. */
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
    if (e === null) return [];
    return [
      {
        id: e.id,
        type: 'speeding',
        tier: e.peak,
        startedAt: e.startedAt,
        durationS: e.overRows,
        measured: {
          speedMph: round1(e.peakSpeedMph),
          limitMph: e.limitAtPeak,
          overMphS: round1(e.overMphS),
          ...(e.lineAtPeak === null ? {} : { lineMph: round1(e.lineAtPeak) }),
        },
      },
    ];
  };

  return {
    push(row, limit) {
      const limitMph = limitMphFor(row, limit);
      const speedMph = knownSpeedMph(row);
      // No warm-up: speeding is read off the GPS speed and the limit alone, from the first row.
      const usable = limitMph !== null && speedMph !== null && speedTrusted(row) && !gnssPoor(row);
      // The limit the row is judged against: the posted one, tightened by the road state it carries.
      const judged = limitMph === null ? null : judgedLimitMph(limitMph, row.road);
      const line = usable && judged !== null ? speedingLine(judged) : null;
      now = usable && line !== null ? { ratio: speedMph / limitMph, overMph: speedMph - line } : null;
      const tier = usable && judged !== null ? speedTier(speedMph, judged) : null;
      const tightened = judged !== limitMph;

      if (tier !== null && usable && line !== null) {
        if (ep === null) {
          ep = {
            id: newId(),
            startedAt: row.ts,
            overRows: 0,
            overMphS: 0,
            belowRows: 0,
            peak: tier,
            peakSpeedMph: speedMph,
            limitAtPeak: limitMph,
            lineAtPeak: tightened ? line : null,
            current: tier,
          };
        }
        ep.overRows += 1;
        ep.overMphS += Math.max(0, speedMph - line);
        ep.belowRows = 0;
        ep.current = tier;
        if (RANK[tier] > RANK[ep.peak] || (tier === ep.peak && speedMph > ep.peakSpeedMph)) {
          ep.peak = worse(tier, ep.peak);
          ep.peakSpeedMph = speedMph;
          ep.limitAtPeak = limitMph;
          ep.lineAtPeak = tightened ? line : null;
        }
        return [];
      }

      if (ep === null) return [];
      ep.current = null;
      // Hovering between A − 2 and A neither extends the episode nor ends it; a row that is
      // not usable cannot vouch for the speed, so it counts toward the end.
      const under = !usable || line === null || speedMph < line - SPEEDING_END_BUFFER_MPH;
      ep.belowRows = under ? ep.belowRows + 1 : 0;
      return ep.belowRows >= SPEEDING_END_S ? close() : [];
    },
    flush: close,
    open() {
      if (ep === null || ep.current === null) return null;
      return { id: ep.id, type: 'speeding', tier: ep.current, startedAt: ep.startedAt };
    },
    episode() {
      if (ep === null) return null;
      return { id: ep.id, startedAt: ep.startedAt, overRows: ep.overRows, overMphS: ep.overMphS, over: ep.current !== null };
    },
    active: () => ep !== null,
    reading: () => now,
  };
}

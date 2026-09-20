// Speeding episodes (§9.3): speed above limit + tolerance for at least SPEEDING_MIN_S rows, on a
// valid fix with a known limit. Confidence comes from the limit source and the GNSS quality (§9.5).
import { CONSTANTS } from '@scoring';
import type { DetectedEvent, Detector, LimitSample } from '../engine/types';
import { ROW_MS, alertableFor, contextOf, statusFor } from './common';

/** Speed-limit source confidence (§9.5). */
const LIMIT_Q = { posted: 0.9, cached: 0.8, statutory: 0.7 } as const;
/** Parallel roads or a weak map match: the limit may belong to the road next door. */
const LIMIT_Q_AMBIGUOUS = 0.6;
const MATCH_CONFIDENCE_MIN = 0.7;
/** GNSS quality beyond which the whole episode is capped at `GNSS_CAP_Q` — unscored (§9.5). */
const H_ACC_MAX_M = 20;
const SPEED_ACC_MAX_MPS = 2;
const GNSS_CAP_Q = 0.4;

interface OpenEpisode {
  id: string;
  startedAt: number;
  lastTs: number;
  rows: number;
  maxOver: number;
  limitAtMax: number;
  speedAtMax: number;
  limitQ: number;
  gnssCapped: boolean;
  alertedAt: number | null;
  context: DetectedEvent['context'];
}

export interface SpeedingDetector extends Detector {
  /** The alert layer told the driver about episode `id` at `ts`; sets up the correction credit. */
  markAlerted(id: string, ts: number): void;
  /** Id of the open episode once it is long enough to become an event, else null. */
  openEpisodeId(): string | null;
}

function limitConfidence(limit: LimitSample): number | null {
  if (limit.source === 'unknown' || limit.limitMps === null) return null;
  const base = LIMIT_Q[limit.source];
  const ambiguous = limit.parallelRoads || limit.matchConfidence < MATCH_CONFIDENCE_MIN;
  return ambiguous ? Math.min(base, LIMIT_Q_AMBIGUOUS) : base;
}

export function createSpeedingDetector(newId: () => string): SpeedingDetector {
  let open: OpenEpisode | null = null;

  const close = (): DetectedEvent[] => {
    const ep = open;
    open = null;
    if (!ep || ep.rows < CONSTANTS.SPEEDING_MIN_S) return [];
    const endedAt = ep.lastTs + ROW_MS;
    const q = ep.gnssCapped ? Math.min(ep.limitQ, GNSS_CAP_Q) : ep.limitQ;
    const status = statusFor(q);
    const corrected =
      ep.alertedAt !== null &&
      endedAt >= ep.alertedAt &&
      endedAt - ep.alertedAt <= CONSTANTS.SPEEDING_GRACE_S * 1000;
    return [
      {
        id: ep.id,
        category: 'speeding',
        startedAt: ep.startedAt,
        durationS: ep.rows,
        q,
        corrected,
        status,
        measured: { speedMps: ep.speedAtMax, limitMps: ep.limitAtMax, overMps: ep.maxOver },
        context: ep.context,
        alertable: alertableFor(status, q),
        source: 'gnss',
      },
    ];
  };

  return {
    push(row, limit, ctx) {
      const limitQ = limitConfidence(limit);
      const limitMps = limit.limitMps;
      const usable = limitQ !== null && limitMps !== null && row.gnssValid && row.speed >= 0;
      const over = usable ? row.speed - (limitMps + CONSTANTS.SPEEDING_TOLERANCE_MPS) : 0;
      if (limitQ === null || limitMps === null || over <= 0) return close();

      if (!open) {
        open = {
          id: newId(),
          startedAt: row.ts,
          lastTs: row.ts,
          rows: 0,
          maxOver: -Infinity,
          limitAtMax: limitMps,
          speedAtMax: row.speed,
          limitQ,
          gnssCapped: false,
          alertedAt: null,
          context: contextOf(ctx),
        };
      }
      open.rows += 1;
      open.lastTs = row.ts;
      if (over > open.maxOver) {
        open.maxOver = over;
        open.limitAtMax = limitMps;
        open.speedAtMax = row.speed;
      }
      open.limitQ = Math.min(open.limitQ, limitQ);
      if (row.hAcc > H_ACC_MAX_M || row.speedAcc > SPEED_ACC_MAX_MPS) open.gnssCapped = true;
      return [];
    },
    flush: close,
    markAlerted(id, ts) {
      // The latest alert is the one the grace window is measured from.
      if (open && open.id === id) open.alertedAt = ts;
    },
    openEpisodeId() {
      return open && open.rows >= CONSTANTS.SPEEDING_MIN_S ? open.id : null;
    },
  };
}

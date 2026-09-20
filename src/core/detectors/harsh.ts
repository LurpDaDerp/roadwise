// Hard braking, rapid acceleration and sharp cornering (§9.3) from the per-second IMU extremes,
// cross-checked against the GNSS Δspeed and gated on phone movement (§9.5, §19.1).
//
// Each kind runs as an episode of consecutive signal rows. A closed episode is held for the two
// seconds after it so an orientation spike in that window can still downgrade it, then released.
import { CONSTANTS } from '@scoring';
import type {
  DetectedEvent,
  Detector,
  DetectorContext,
  EventSource,
  FeatureRow,
} from '../engine/types';
import { G_MPS2, alertableFor, contextOf, knownSpeed, statusFor } from './common';

type HarshKind = 'braking' | 'accel' | 'cornering';
const KINDS: readonly HarshKind[] = ['braking', 'accel', 'cornering'];

/** Harsh-event confidence (§9.5); `agreedStableMount` is `agreed` + 0.1, which never reaches the cap of 1. */
const Q = { agreed: 0.85, agreedStableMount: 0.95, disagreed: 0.4, orientation: 0.3 } as const;
/** The GNSS Δspeed between consecutive fixes must show at least this much for the IMU extreme to count as confirmed. */
const GNSS_AGREE_G = 0.2;
/** Consecutive fixes farther apart than this are not "the same second" and cannot vouch for it. */
const MAX_FIX_GAP_MS = 1500;
const GRAVITY_STABLE_MIN = 0.9;
/** An orientation change this large within ±`ORIENTATION_WINDOW_MS` reads as the phone sliding or falling. */
const ORIENTATION_SPIKE_RAD = 0.35;
const ORIENTATION_WINDOW_MS = 2000;

interface Signal {
  peakG: number;
  /** GNSS agreement; null when the kind has no GNSS cross-check */
  agreed: boolean | null;
}

interface Episode {
  id: string;
  kind: HarshKind;
  startedAt: number;
  lastTs: number;
  rows: number;
  peakG: number;
  speedAtPeak: number | null;
  agreed: boolean | null;
  stableMount: boolean;
  orientationSpike: boolean;
  context: DetectedEvent['context'];
}

function signalFor(
  kind: HarshKind,
  row: FeatureRow,
  speed: number | null,
  gnssDeltaG: number | null
): Signal | null {
  // Never scored below the lockout speed; an unknown speed cannot prove we were above it, but the
  // IMU evidence is still logged (its GNSS disagreement keeps it unscored).
  const belowLockout = speed !== null && speed < CONSTANTS.LOCKOUT_SPEED_MPS;
  switch (kind) {
    case 'braking':
      if (belowLockout || row.aLonMin > -CONSTANTS.HARSH_BRAKE_G) return null;
      return { peakG: -row.aLonMin, agreed: gnssDeltaG !== null && -gnssDeltaG >= GNSS_AGREE_G };
    case 'accel':
      if (belowLockout || row.aLonMax < CONSTANTS.HARSH_ACCEL_G) return null;
      return { peakG: row.aLonMax, agreed: gnssDeltaG !== null && gnssDeltaG >= GNSS_AGREE_G };
    case 'cornering': {
      const lateral = Math.max(Math.abs(row.aLatMax), Math.abs(row.aLatMin));
      if (speed === null || speed < CONSTANTS.CORNER_MIN_SPEED_MPS) return null;
      if (lateral < CONSTANTS.HARSH_CORNER_G) return null;
      return { peakG: lateral, agreed: null };
    }
  }
}

const stableMount = (row: FeatureRow, ctx: DetectorContext): boolean =>
  ctx.mode === 'mounted' && row.gravityStability >= GRAVITY_STABLE_MIN;

function toEvent(ep: Episode): DetectedEvent {
  let q: number;
  let source: EventSource;
  if (ep.orientationSpike) {
    q = Q.orientation;
    source = ep.agreed ? 'both' : 'imu';
  } else if (ep.agreed === false) {
    q = Q.disagreed;
    source = 'imu';
  } else {
    q = ep.stableMount ? Q.agreedStableMount : Q.agreed;
    source = ep.agreed ? 'both' : 'imu';
  }
  const status = statusFor(q);
  const measured: DetectedEvent['measured'] =
    ep.kind === 'cornering' ? { lateralG: ep.peakG } : { peakG: ep.peakG };
  if (ep.speedAtPeak !== null) measured.speedMps = ep.speedAtPeak;
  return {
    id: ep.id,
    category: ep.kind,
    startedAt: ep.startedAt,
    durationS: ep.rows,
    q,
    corrected: false,
    status,
    measured,
    context: ep.context,
    alertable: alertableFor(status, q),
    source,
  };
}

export function createHarshDetector(newId: () => string): Detector {
  let prev: FeatureRow | null = null;
  const open: Record<HarshKind, Episode | null> = { braking: null, accel: null, cornering: null };
  let pending: Episode[] = [];
  /** Timestamps of recent orientation spikes, kept for the window before an episode opens. */
  let recentSpikes: number[] = [];

  /** GNSS acceleration between the previous fix and this one, in g (positive = speeding up). */
  const gnssDeltaG = (row: FeatureRow): number | null => {
    if (!prev) return null;
    const before = knownSpeed(prev);
    const after = knownSpeed(row);
    const dtMs = row.ts - prev.ts;
    if (before === null || after === null || dtMs <= 0 || dtMs > MAX_FIX_GAP_MS) return null;
    return (after - before) / (dtMs / 1000) / G_MPS2;
  };

  return {
    push(row, _limit, ctx) {
      const speed = knownSpeed(row);
      const deltaG = gnssDeltaG(row);
      const spike = row.orientationDelta > ORIENTATION_SPIKE_RAD;
      if (spike) recentSpikes.push(row.ts);

      for (const kind of KINDS) {
        const signal = signalFor(kind, row, speed, deltaG);
        const ep = open[kind];
        if (signal && ep) {
          ep.rows += 1;
          ep.lastTs = row.ts;
          if (signal.peakG > ep.peakG) {
            ep.peakG = signal.peakG;
            ep.speedAtPeak = speed;
          }
          if (ep.agreed !== null) ep.agreed = ep.agreed || signal.agreed === true;
          ep.stableMount = ep.stableMount && stableMount(row, ctx);
          ep.orientationSpike = ep.orientationSpike || spike;
        } else if (signal) {
          open[kind] = {
            id: newId(),
            kind,
            startedAt: row.ts,
            lastTs: row.ts,
            rows: 1,
            peakG: signal.peakG,
            speedAtPeak: speed,
            agreed: signal.agreed,
            stableMount: stableMount(row, ctx),
            orientationSpike: recentSpikes.some((t) => t >= row.ts - ORIENTATION_WINDOW_MS),
            context: contextOf(ctx),
          };
        } else if (ep) {
          pending.push(ep);
          open[kind] = null;
        }
      }

      if (spike) {
        for (const ep of pending) {
          if (row.ts <= ep.lastTs + ORIENTATION_WINDOW_MS) ep.orientationSpike = true;
        }
      }
      const released = pending.filter((ep) => row.ts >= ep.lastTs + ORIENTATION_WINDOW_MS);
      pending = pending.filter((ep) => row.ts < ep.lastTs + ORIENTATION_WINDOW_MS);
      recentSpikes = recentSpikes.filter((t) => t >= row.ts - ORIENTATION_WINDOW_MS);
      prev = row;
      return released.map(toEvent);
    },
    flush() {
      const closing = [...pending];
      pending = [];
      for (const kind of KINDS) {
        const ep = open[kind];
        if (ep) closing.push(ep);
        open[kind] = null;
      }
      return closing.map(toEvent);
    },
  };
}

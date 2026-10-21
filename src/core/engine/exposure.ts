// A drive's opportunity counters (scoring `Exposure`): slowdowns, speed-ups, turns and the seconds
// with a usable speed limit, counted row by row at 1 Hz. A pure reducer, so a live drive, a drive
// cut back to its last movement and a drive rebuilt from its stored rows all agree. Speeds are the
// row's GNSS speed in mph, read only when trusted; an unknown or untrusted speed changes nothing.
import { clampExposure, type Exposure } from '@scoring';

import { knownSpeedMph, speedTrusted } from '../detectors/common';
import { CORNER_MIN_MPH } from '../detectors/harsh';
import type { FeatureRow } from './types';

/** A peak-to-trough drop (or trough-to-peak rise) this big is a slowdown (speed-up): the gap between 15 and 3 mph. */
export const SWING_MIN_MPH = 12;
/** The speed must come back this far from a peak (trough) before the peak (trough) stands. GPS jitter is ~1 mph. */
export const SWING_HYSTERESIS_MPH = 3;
/** A turn: this much net heading change… */
export const TURN_MIN_DEG = 60;
/** …within this long… */
export const TURN_WINDOW_MS = 20_000;
/** …at this speed or more (the course is noise below it; the corner detector's line). */
export const TURN_MIN_MPH = CORNER_MIN_MPH;
/** A turn is over once this many consecutive qualifying rows change the heading by under TURN_SETTLE_DEG. */
export const TURN_SETTLE_ROWS = 3;
export const TURN_SETTLE_DEG = 5;
/** Limit time counts at this speed or more (driving speed). */
export const LIMIT_MIN_MPH = 10;

export interface ExposureState {
  readonly slowdowns: number;
  readonly speedups: number;
  readonly turns: number;
  readonly limitS: number;
  /** Speed swings: the phase and its running extremes (mph); `peak`/`trough` null before the first trusted speed. */
  readonly phase: 'rising' | 'falling';
  readonly peak: number | null;
  readonly trough: number | null;
  /** Heading: unwrapped degrees (continuous across 359→0), the last qualifying course, the 20 s trail, and the hold. */
  readonly heading: number;
  readonly lastCourse: number | null;
  readonly trail: readonly { readonly ts: number; readonly heading: number }[];
  readonly turning: boolean;
  readonly calmRows: number;
}

export const EMPTY_EXPOSURE_STATE: Readonly<ExposureState> = Object.freeze({
  slowdowns: 0,
  speedups: 0,
  turns: 0,
  limitS: 0,
  phase: 'rising',
  peak: null,
  trough: null,
  heading: 0,
  lastCourse: null,
  trail: Object.freeze([]),
  turning: false,
  calmRows: 0,
} as ExposureState);

/** Signed difference of two headings, degrees in (−180, 180]. */
function courseDelta(a: number, b: number): number {
  let d = b - a;
  while (d > 180) d -= 360;
  while (d <= -180) d += 360;
  return d;
}

type Swing = Pick<ExposureState, 'slowdowns' | 'speedups' | 'phase' | 'peak' | 'trough'>;

/** One trusted speed through the slowdown / speed-up state machine. */
function swing(s: Swing, v: number): Swing {
  if (s.peak === null || s.trough === null) return { ...s, phase: 'rising', peak: v, trough: v };
  const { peak, trough } = s;
  if (s.phase === 'rising') {
    if (v > peak) return { ...s, peak: v };
    if (v <= peak - SWING_HYSTERESIS_MPH) {
      // The peak stands: the rise from the trough was a speed-up if it was big enough.
      return { ...s, speedups: s.speedups + (peak - trough >= SWING_MIN_MPH ? 1 : 0), phase: 'falling', trough: v };
    }
    return s;
  }
  if (v < trough) return { ...s, trough: v };
  if (v >= trough + SWING_HYSTERESIS_MPH) {
    // The trough stands: the drop from the peak was a slowdown if it was big enough.
    return { ...s, slowdowns: s.slowdowns + (peak - trough >= SWING_MIN_MPH ? 1 : 0), phase: 'rising', peak: v };
  }
  return s;
}

type Turn = Pick<ExposureState, 'turns' | 'heading' | 'lastCourse' | 'trail' | 'turning' | 'calmRows'>;

/** One qualifying row (valid course at ≥ TURN_MIN_MPH) through the turn counter. */
function turn(s: Turn, ts: number, course: number): Turn {
  const delta = courseDelta(s.lastCourse ?? course, course);
  const heading = s.heading + delta;
  const aged = s.trail.filter((e) => e.ts >= ts - TURN_WINDOW_MS);
  if (s.turning) {
    const calmRows = Math.abs(delta) < TURN_SETTLE_DEG ? s.calmRows + 1 : 0;
    if (calmRows >= TURN_SETTLE_ROWS) {
      return { turns: s.turns, heading, lastCourse: course, trail: Object.freeze([{ ts, heading }]), turning: false, calmRows: 0 };
    }
    return { turns: s.turns, heading, lastCourse: course, trail: Object.freeze(aged), turning: true, calmRows };
  }
  const trail = [...aged, { ts, heading }];
  if (trail.some((e) => Math.abs(heading - e.heading) >= TURN_MIN_DEG)) {
    return { turns: s.turns + 1, heading, lastCourse: course, trail: Object.freeze([]), turning: true, calmRows: 0 };
  }
  return { turns: s.turns, heading, lastCourse: course, trail: Object.freeze(trail), turning: false, calmRows: s.calmRows };
}

/**
 * One row. `limitUsable`: the speeding detector could use the row (an actionable posted limit,
 * trusted speed, a good fix, past the warm-up). Returns a new frozen state; the input is untouched.
 */
export function noteExposure(state: Readonly<ExposureState>, row: FeatureRow, limitUsable: boolean): Readonly<ExposureState> {
  const v = speedTrusted(row) ? knownSpeedMph(row) : null;
  if (v === null) return state;
  const swung = swing(state, v);
  const qualifies = row.gnssValid && row.course >= 0 && row.course <= 360 && v >= TURN_MIN_MPH;
  const turned = qualifies ? turn(state, row.ts, row.course) : state;
  const limitS = state.limitS + (limitUsable && v >= LIMIT_MIN_MPH ? 1 : 0);
  return Object.freeze({
    slowdowns: swung.slowdowns,
    speedups: swung.speedups,
    phase: swung.phase,
    peak: swung.peak,
    trough: swung.trough,
    turns: turned.turns,
    heading: turned.heading,
    lastCourse: turned.lastCourse,
    trail: turned.trail,
    turning: turned.turning,
    calmRows: turned.calmRows,
    limitS,
  });
}

/**
 * The counters at drive end: the open swing settled (a final slowdown to the stop counts; a drive
 * cut mid-acceleration counts its speed-up), clamped. `movingS` comes from the caller
 * (`session.movingRows`).
 */
export function closeExposure(state: Readonly<ExposureState>, movingS: number): Exposure {
  let { slowdowns, speedups } = state;
  if (state.peak !== null && state.trough !== null && state.peak - state.trough >= SWING_MIN_MPH) {
    if (state.phase === 'falling') slowdowns += 1;
    else speedups += 1;
  }
  return clampExposure({ slowdowns, speedups, turns: state.turns, limitS: state.limitS, movingS });
}

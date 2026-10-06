// Eyes off road and drowsiness (product spec v3 event table "Eyes off road (DMS)", "Drowsiness (DMS)";
// "Rules against false positives", DMS): the camera pipeline (src/core/dms) closes its own episodes and hands
// them over as `DmsFocusSample`s; this turns them into the two v3 events:
// - `eyes_off`: a non-driving glance (never a mirror, the cluster or a shoulder check: the DMS classifies those
//   as safe) of at least EYES_OFF_S.minor (2 s), severe at EYES_OFF_S.severe (4 s), with the car at or above
//   EYES_OFF_MIN_MPH (10 mph) throughout. Suppressed while a turn is detected (the GNSS course rate: no
//   turn-signal access on a phone), and for a wide head turn (the far-lateral zone) below WIDE_TURN_MAX_MPH.
// - `drowsy` (severe): sustained eye-closure signs — the DMS's closure episodes, nod-offs and drowsy fatigue
//   minutes — adding up to DROWSY_S (60 s) within DROWSY_WINDOW_S, at most one per DROWSY_COOLDOWN_S. Signs
//   measured in low light are ignored (no IR on phone cameras).
// Both only at camera confidence ≥ DMS_MIN_CONFIDENCE (0.85), and never in the first 30 s or on a poor fix,
// like every other detector. The sample arrives on the row its episode ended, so the event starts
// `glanceS` earlier. The alert ("Eyes up" / "Take a break") is the drive engine's, raised as the event closes.
import { DMS_MIN_CONFIDENCE, DROWSY_S, EYES_OFF_MIN_MPH, EYES_OFF_S, type Tier } from '@scoring';

import type { DmsFocusSample } from '@/core/dms';

import type { DetectedEvent, Detector, DetectorContext, FeatureRow } from '../engine/types';
import { knownSpeedMph, round1, rowEligible } from './common';

/** A far-lateral glance (a wide head turn) below this speed is a head check at a junction or in a lot, not eyes off. */
export const WIDE_TURN_MAX_MPH = 15;
/** A GNSS course rate at or above this (°/s) during the glance is a turn… */
export const TURN_RATE_DEG_S = 8;
/** …and so is a heading change of at least this (°) over the glance. */
export const TURN_TOTAL_DEG = 25;
/** Drowsiness signs add up within this window (s)… */
export const DROWSY_WINDOW_S = 120;
/** …and raise at most one event per this (s). */
export const DROWSY_COOLDOWN_S = 600;
/** Rows kept for the glance window (a glance is seconds; the DMS caps its own episodes). */
const HISTORY_ROWS = 20;

interface Seen {
  ts: number;
  speedMph: number | null;
  /** the GNSS course on a valid fix, else null */
  course: number | null;
}

/** Signed difference of two headings, degrees in (-180, 180]. */
const courseDelta = (a: number, b: number): number => {
  let d = b - a;
  while (d > 180) d -= 360;
  while (d <= -180) d += 360;
  return d;
};

/** The rows a glance covered (from its start to its end, one row of slack each side), oldest first. */
function rowsIn(history: readonly Seen[], fromTs: number, toTs: number): Seen[] {
  const w = history.filter((s) => s.ts >= fromTs - 1000 && s.ts <= toTs + 1000);
  return w.length > 0 ? w : history.slice(-1);
}

/** A turn during the window: the peak course rate, or the total heading change, over consecutive valid fixes. */
export function turning(window: readonly Seen[]): boolean {
  const fixes = window.filter((s) => s.course !== null);
  if (fixes.length < 2) return false;
  let total = 0;
  for (let i = 1; i < fixes.length; i++) {
    const a = fixes[i - 1]!;
    const b = fixes[i]!;
    const dtS = (b.ts - a.ts) / 1000;
    if (dtS <= 0) continue;
    const d = Math.abs(courseDelta(a.course!, b.course!));
    if (d / dtS >= TURN_RATE_DEG_S) return true;
    total += d;
  }
  return total >= TURN_TOTAL_DEG;
}

/**
 * The focus detector over the camera's samples. `source` hands out the samples that arrived since the last
 * call (the camera bridge drains the controller's queue there); a sample's `endT` is the frame clock in epoch
 * ms, the same clock as the rows.
 */
export function createFocusDetector(newId: () => string, source: () => readonly DmsFocusSample[]): Detector {
  const history: Seen[] = [];
  let signs: { t: number; s: number }[] = [];
  let lastDrowsyAt: number | null = null;

  function remember(row: FeatureRow): void {
    history.push({ ts: row.ts, speedMph: knownSpeedMph(row), course: row.gnssValid ? row.course : null });
    if (history.length > HISTORY_ROWS) history.splice(0, history.length - HISTORY_ROWS);
  }

  function eyesOff(s: DmsFocusSample, row: FeatureRow, ctx: DetectorContext): DetectedEvent | null {
    if (!(s.glanceS >= EYES_OFF_S.minor)) return null;
    const window = rowsIn(history, s.endT - s.glanceS * 1000, s.endT);
    const speeds = window.map((w) => w.speedMph).filter((v): v is number => v !== null);
    if (speeds.length === 0) return null; // the speed was never known across the glance
    const minSpeed = Math.min(...speeds);
    if (minSpeed < EYES_OFF_MIN_MPH) return null;
    if (s.wideTurn && minSpeed < WIDE_TURN_MAX_MPH) return null;
    if (turning(window)) return null;
    const tier: Tier = s.glanceS >= EYES_OFF_S.severe ? 'severe' : 'minor';
    const startedAt = Math.max(ctx.tripStartedAt, Math.round(s.endT - s.glanceS * 1000));
    return { id: newId(), type: 'eyes_off', tier, startedAt, durationS: round1(s.glanceS), measured: { speedMph: round1(minSpeed) } };
  }

  function drowsy(s: DmsFocusSample, row: FeatureRow, ctx: DetectorContext): DetectedEvent | null {
    if (s.lowLight || !(s.glanceS > 0)) return null;
    signs.push({ t: s.endT, s: s.glanceS });
    signs = signs.filter((x) => x.t >= row.ts - DROWSY_WINDOW_S * 1000);
    const total = signs.reduce((n, x) => n + x.s, 0);
    if (total < DROWSY_S) return null;
    if (lastDrowsyAt !== null && row.ts - lastDrowsyAt < DROWSY_COOLDOWN_S * 1000) return null;
    const first = signs[0]!;
    const startedAt = Math.max(ctx.tripStartedAt, Math.round(first.t - first.s * 1000));
    signs = [];
    lastDrowsyAt = row.ts;
    const measured: DetectedEvent['measured'] = {};
    const speed = knownSpeedMph(row);
    if (speed !== null) measured.speedMph = round1(speed);
    return { id: newId(), type: 'drowsy', tier: 'severe', startedAt, durationS: round1(Math.min(total, DROWSY_WINDOW_S)), measured };
  }

  function consume(row: FeatureRow, ctx: DetectorContext): DetectedEvent[] {
    const samples = source();
    if (samples.length === 0 || !rowEligible(row, ctx)) return [];
    const out: DetectedEvent[] = [];
    for (const s of samples) {
      if (!(s.q >= DMS_MIN_CONFIDENCE)) continue;
      const e = s.kind === 'glance' ? eyesOff(s, row, ctx) : drowsy(s, row, ctx);
      if (e !== null) out.push(e);
    }
    return out;
  }

  let last: { row: FeatureRow; ctx: DetectorContext } | null = null;
  return {
    push(row, _limit, ctx) {
      remember(row);
      last = { row, ctx };
      return consume(row, ctx);
    },
    flush() {
      // The samples the camera closed with the drive (the controller's `pendingFocus`), judged on the last row.
      if (last === null) return [];
      return consume(last.row, last.ctx);
    },
  };
}

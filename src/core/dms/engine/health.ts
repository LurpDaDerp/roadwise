// Task C7 (calib-parked design rev2 §2.4, rev1 K2, rev4 §2.4; review-C5 Round 1 (d) and Round 2: the binding
// carry): the gaze accuracy monitor. Pure.
//
// Metrics, on ON-ROAD-classified frames of the configured gaze source only (K2: distraction is never read as a
// calibration fault), on moving time only (no evaluation while STOPPED; the health clock stands):
//   H1  the share within the calibrated radius of the centre, 60 s decayed        bad while < 0.5 for 30 s
//   H2  |the window's mode − the centre| (a mean-shift mode of the last 30 s)      bad at > max(4°, 1.5σ̂) on 2 evaluations
//   H3  the p85 radius of the centre's own cluster ÷ the calibrated radius          bad at > 1.5
//   H4  (net builds) the median |rel_net − rel_geo| over 30 s                       bad at > 6°
// The window is health's OWN: it is never voided by a warning (review-C5 R2 carry). A miscentring that raises D1
// warnings voids the calibration's admitted samples, so the rolling path cannot follow it; health still sees it,
// widens every on-road zone by +5°, the warnings stop, and the rolling path can follow.
//
// C7 round 1 (review-C7 C7-3): H1 and H2 may degrade only if c₀ is vacated BEYOND NOISE against the window's mode
// (C5-1's excess test, calibration.slow.excessMax): a reader of an on-road display who still looks at the road 30–40 %
// of the time moves the mode but does not vacate c₀, and must not blunt D1 by +5° while distracted. A true shift does.
//
// Gaze degraded (any of H1–H4 bad): the zones widen by +5° (never more from health), every distraction rule stays
// on, the HUD shows 'widened' / 'recalibrating'. Health NEVER re-centres and never moves the closure thresholds or
// the looking-down gate (frozen references). Recovery: every metric good for 60 s of health time.
import { angularDistanceDeg } from './angles';
import type { DmsConfig } from './config';
import { vacatedBeyondNoise } from './posture';
import type { AnglePair } from './types';
import { RingBuffer } from './windows';

export interface HealthInput {
  tMs: number;
  dtS: number;
  /** STOPPED, or not calibrated, or in the dual state: no evaluation, the state and the clock stand */
  hold: boolean;
  /** the configured source's gaze (driver frame, absolute) on an on-road-classified TRACKING gaze frame; else null */
  onRoadGaze: AnglePair | null;
  /** the live centre of the configured source (driver frame) */
  centre: AnglePair | null;
  radiusDeg: number | null;
  sigmaDeg: number;
  /** net builds: |rel_net − rel_geo| on a frame with both; null otherwise */
  sourceDiffDeg: number | null;
}

export interface HealthMetrics {
  h1: number | null;
  h2: number | null;
  h3: number | null;
  h4: number | null;
}

export interface HealthMonitor {
  step(x: HealthInput): void;
  gazeDegraded(): boolean;
  metrics(): HealthMetrics;
  /** the last H2 mode (driver frame; diagnostics: health never moves a centre to it) */
  mode(): AnglePair | null;
  /** seconds of health time spent degraded (the summary's degraded seconds) */
  degradedS(): number;
  reset(): void;
}

/** C7 round 1 (C7-3): the far frames form a second target when this share of them is within 2σ̂ of their own mode */
const SECOND_CLUSTER_SHARE = 0.6;

/** A mean-shift mode of the window (flat kernel of radius `r`), started from the component-wise median. */
function modeOf(pts: readonly AnglePair[], r: number): AnglePair {
  const ys = pts.map((p) => p.yaw).sort((a, b) => a - b);
  const ps = pts.map((p) => p.pitch).sort((a, b) => a - b);
  let m: AnglePair = { yaw: ys[ys.length >> 1]!, pitch: ps[ps.length >> 1]! };
  for (let it = 0; it < 20; it++) {
    let sy = 0;
    let sp = 0;
    let n = 0;
    for (const p of pts) {
      if (angularDistanceDeg(p, m) <= r) {
        sy += p.yaw;
        sp += p.pitch;
        n++;
      }
    }
    if (n === 0) break;
    const next = { yaw: sy / n, pitch: sp / n };
    const moved = angularDistanceDeg(next, m);
    m = next;
    if (moved < 0.05) break;
  }
  return m;
}

export function createHealthMonitor(cfg: Pick<DmsConfig, 'health' | 'calibration'>): HealthMonitor {
  const h = cfg.health;
  const excessMax = cfg.calibration.slow.excessMax;
  /** C7 round 1 (C7-3): c₀ vacated beyond noise at the last evaluation (H1 and H2 may degrade only then) */
  let vacated = false;
  /** health time: moving, calibrated seconds */
  let clock = 0;
  let inW = 0;
  let totW = 0;
  let h1LowSince: number | null = null;
  const win = new RingBuffer<{ t: number; g: AnglePair }>(Math.ceil(h.windowS * 30));
  const diffs = new RingBuffer<{ t: number; d: number }>(Math.ceil(h.h4WindowS * 30));
  let nextEval = h.evalEveryS;
  let h2Bad = 0;
  let h2BadNow = false;
  let h3BadNow = false;
  let h4BadNow = false;
  let degraded = false;
  let goodSince: number | null = null;
  let degS = 0;
  const m: HealthMetrics = { h1: null, h2: null, h3: null, h4: null };
  let lastMode: AnglePair | null = null;

  function evaluate(centre: AnglePair, radius: number, sigma: number): void {
    if (win.size === 0 || clock - win.first()!.t < h.minWindowS) {
      h2BadNow = false;
      h3BadNow = false;
      return;
    }
    const pts = win.toArray().map((s) => s.g);
    const mode = modeOf(pts, Math.max(h.h2MinDeg, 2 * sigma));
    lastMode = mode;
    m.h2 = angularDistanceDeg(mode, centre);
    vacated = vacatedBeyondNoise(
      pts.map((g) => ({ yaw: g.yaw, pitch: g.pitch, w: 1 })),
      centre,
      mode,
      radius,
      sigma,
      excessMax
    );
    h2Bad = m.h2 > Math.max(h.h2MinDeg, h.h2Sigmas * sigma) && vacated ? h2Bad + 1 : 0;
    h2BadNow = h2Bad >= h.h2Evals;
    // C7 round 1 (C7-3): H3 measures the spread of the CENTRE's own cluster. A second peaked cluster among the frames
    // beyond the radius (an on-road display watched most of the time: most of them within 2σ̂ of their own mode) is a
    // target, not dispersion, and is left out; frames spread in a ring around the centre are dispersion and count. A
    // true shift is H2's (vacated beyond noise).
    const bw = Math.max(h.h2MinDeg, 2 * sigma);
    let own = pts;
    const far = pts.filter((g) => angularDistanceDeg(g, centre) > radius);
    if (far.length >= Math.max(10, 0.1 * pts.length)) {
      const m2 = modeOf(far, bw);
      const near2 = far.filter((g) => angularDistanceDeg(g, m2) <= bw).length;
      if (near2 >= SECOND_CLUSTER_SHARE * far.length) own = pts.filter((g) => angularDistanceDeg(g, centre) <= angularDistanceDeg(g, m2));
    }
    const rs = (own.length > 0 ? own : pts).map((g) => angularDistanceDeg(g, centre)).sort((a, b) => a - b);
    m.h3 = rs[Math.min(rs.length - 1, Math.floor(h.h3Percentile * (rs.length - 1)))]! / radius;
    h3BadNow = m.h3 > h.h3MaxRatio;
    if (diffs.size > 0 && clock - diffs.first()!.t >= h.h4WindowS / 2) {
      const ds = diffs.toArray().map((d) => d.d).sort((a, b) => a - b);
      m.h4 = ds[ds.length >> 1]!;
      h4BadNow = m.h4 > h.h4MaxDeg;
    } else h4BadNow = false;
  }

  return {
    step(x) {
      if (x.hold || x.centre === null || x.radiusDeg === null) return;
      const dt = Math.max(0, x.dtS);
      clock += dt;
      if (degraded) degS += dt;
      // H1: the decayed inside share.
      const k = Math.exp(-dt / h.h1TauS);
      inW *= k;
      totW *= k;
      if (x.onRoadGaze !== null) {
        totW += dt;
        if (angularDistanceDeg(x.onRoadGaze, x.centre) <= x.radiusDeg) inW += dt;
        win.push({ t: clock, g: x.onRoadGaze });
      }
      win.dropWhile((s) => s.t < clock - h.windowS);
      if (x.sourceDiffDeg !== null) diffs.push({ t: clock, d: x.sourceDiffDeg });
      diffs.dropWhile((s) => s.t < clock - h.h4WindowS);
      m.h1 = totW >= h.minWindowS / 2 ? inW / totW : null;
      if (m.h1 !== null && m.h1 < h.h1MinShare) h1LowSince ??= clock;
      else h1LowSince = null;
      const h1Bad = h1LowSince !== null && clock - h1LowSince >= h.h1HoldS && vacated;
      if (clock >= nextEval) {
        nextEval = clock + h.evalEveryS;
        evaluate(x.centre, x.radiusDeg, x.sigmaDeg);
      }
      const bad = h1Bad || h2BadNow || h3BadNow || h4BadNow;
      if (bad) {
        degraded = true;
        goodSince = null;
      } else if (degraded) {
        goodSince ??= clock;
        if (clock - goodSince >= h.recoverS) {
          degraded = false;
          goodSince = null;
        }
      }
    },
    gazeDegraded: () => degraded,
    mode: () => (lastMode === null ? null : { ...lastMode }),
    metrics: () => ({ ...m }),
    degradedS: () => degS,
    reset() {
      clock = 0;
      inW = 0;
      totW = 0;
      h1LowSince = null;
      win.clear();
      diffs.clear();
      nextEval = h.evalEveryS;
      h2Bad = 0;
      h2BadNow = false;
      h3BadNow = false;
      h4BadNow = false;
      degraded = false;
      goodSince = null;
      m.h1 = m.h2 = m.h3 = m.h4 = null;
      lastMode = null;
      vacated = false;
    },
  };
}

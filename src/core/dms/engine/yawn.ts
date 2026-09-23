// The yawn detector (plan §M6, spec "Yawn detector", C-23, rev1 I4 and m7). Mouth openness = MAR /
// neutral MAR (the neutral floored at 0.05 by the calibrator). A yawn: a rise from 1.5 to 2.5 over
// ≥ 0.3 s, openness ≥ 2.5 AND an absolute MAR ≥ 0.35 held ≥ 2.0 s, a fall from 2.5 to 1.5 over ≥ 0.3 s;
// rejected as speech when the DFT energy in [3, min(8, fps/2)] Hz over [0.3, fps/2] Hz, in the 2 s
// before the peak, is ≥ 0.35; rejected as a laugh when the mouth width during the rise reaches 1.15 ×
// neutral; disabled below the yawn fps floor. Tier 0 only. Pure; bounded.
import type { DmsConfig } from './config';
import type { Quality } from './quality';
import { RingBuffer } from './windows';

export interface YawnInput {
  tMs: number;
  quality: Quality;
  /** null when there is no mouth (clipped or no face) */
  mar: number | null;
  mouthW: number | null;
  neutralMar: number | null;
  neutralMouthW: number | null;
  /** the measured fps */
  fps: number;
}

export interface YawnEvent {
  kind: 'yawn';
  tMs: number;
}

/**
 * The share of the signal's energy (mean removed) in the speech band [3, min(8, fps/2)] Hz, of the
 * energy in [0.3, fps/2] Hz. `xs` is uniformly sampled at `fps`. A plain DFT: n ≤ 2 s × 30 fps.
 */
export function speechRatio(xs: readonly number[], fps: number, cfg: Pick<DmsConfig, 'yawn'> = { yawn: { speechBandHz: [3, 8], speechRefLowHz: 0.3 } as DmsConfig['yawn'] }): number {
  const n = xs.length;
  if (n < 4) return 0;
  const mean = xs.reduce((s, x) => s + x, 0) / n;
  const nyq = fps / 2;
  const [b0, b1raw] = cfg.yawn.speechBandHz;
  const b1 = Math.min(b1raw, nyq);
  let band = 0;
  let ref = 0;
  for (let k = 1; k <= Math.floor(n / 2); k++) {
    const hz = (k * fps) / n;
    if (hz < cfg.yawn.speechRefLowHz - 1e-9 || hz > nyq + 1e-9) continue;
    let re = 0;
    let im = 0;
    for (let i = 0; i < n; i++) {
      const a = (2 * Math.PI * k * i) / n;
      re += (xs[i]! - mean) * Math.cos(a);
      im -= (xs[i]! - mean) * Math.sin(a);
    }
    const e = re * re + im * im;
    ref += e;
    if (hz >= b0 - 1e-9 && hz <= b1 + 1e-9) band += e;
  }
  return ref > 0 ? band / ref : 0;
}

type Phase = 'idle' | 'rising' | 'high' | 'falling';

/**
 * The ramps are timed between bracketing frames: a rise runs from the last frame below 1.5 (or, if the
 * detector never saw one, the first frame of the ramp) to the first frame at ≥ 2.5; a fall from the last
 * frame at ≥ 2.5 to the first frame below 1.5. At 15 fps a crossing is only known to within a frame, and
 * the bracket keeps a 0.8 s mouth opening (0.27 s between the exact crossings of a 1 → 4 ramp) from
 * failing a 0.3 s test that a 0.15 s snap (0.13 s bracketed) must still fail.
 */
export function createYawnDetector(cfg: Pick<DmsConfig, 'yawn'>) {
  const y = cfg.yawn;
  const history = new RingBuffer<{ t: number; o: number }>(Math.ceil((y.speechWindowS + 6) * 30) + 8);
  let phase: Phase = 'idle';
  let lastBelow: number | null = null;
  let riseStart = 0;
  let riseOk = false;
  let laugh = false;
  let heldS = 0;
  let heldRunStart: number | null = null;
  let peak = { t: 0, o: 0 };
  let lastHigh = 0;
  let speech = false;

  const reset = () => {
    phase = 'idle';
    heldS = 0;
    heldRunStart = null;
    laugh = false;
    speech = false;
  };
  const enterHigh = (t: number, o: number, mar: number) => {
    phase = 'high';
    riseOk = t - riseStart >= y.rampMinS * 1000 - 1e-6;
    heldS = 0;
    heldRunStart = mar >= y.absMar ? t : null;
    peak = { t, o };
    lastHigh = t;
  };
  const isWide = (x: YawnInput) => x.mouthW !== null && x.neutralMouthW !== null && x.mouthW >= y.laughWidthRatio * x.neutralMouthW - 1e-9;

  return {
    reset() {
      reset();
      lastBelow = null;
      history.clear();
    },
    onFrame(x: YawnInput): YawnEvent[] {
      const out: YawnEvent[] = [];
      if (x.quality !== 'tracking' || x.mar === null || x.neutralMar === null || x.fps < y.minFps) {
        reset();
        lastBelow = null;
        return out;
      }
      const o = x.mar / x.neutralMar;
      history.push({ t: x.tMs, o });
      history.dropWhile((h) => h.t < x.tMs - (y.speechWindowS + 6) * 1000);
      // A sample landing on a threshold counts as on it (float noise must not move a bracket by a frame).
      const lo = y.rampFrom - 1e-9;
      const hi = y.openness - 1e-9;
      if (phase === 'idle') {
        if (o < lo) lastBelow = x.tMs;
        else {
          riseStart = lastBelow ?? x.tMs;
          laugh = isWide(x);
          if (o >= hi) enterHigh(x.tMs, o, x.mar);
          else phase = 'rising';
        }
        return out;
      }
      if (phase === 'rising') {
        if (isWide(x)) laugh = true;
        if (o < lo) {
          reset();
          lastBelow = x.tMs;
        } else if (o >= hi) enterHigh(x.tMs, o, x.mar);
        return out;
      }
      if (phase === 'high' && o >= hi) {
        lastHigh = x.tMs;
        if (o > peak.o) peak = { t: x.tMs, o };
        if (x.mar >= y.absMar) {
          heldRunStart ??= x.tMs;
          heldS = Math.max(heldS, (x.tMs - heldRunStart) / 1000);
        } else heldRunStart = null;
        return out;
      }
      if (phase === 'high') {
        // Leaving the plateau: the speech test over the 2 s before the peak.
        const win = history.toArray().filter((h) => h.t <= peak.t && h.t > peak.t - y.speechWindowS * 1000);
        speech = speechRatio(win.map((h) => h.o), x.fps, cfg) >= y.speechMaxRatio;
        phase = 'falling';
      }
      // falling
      if (o >= hi) {
        reset(); // back up: not one clean yawn
      } else {
        // The fall passes once the mouth has been off the plateau for 0.3 s without dropping below 1.5
        // sooner (a snap shut fails). It need not reach 1.5: a mouth whose resting openness sits between
        // the thresholds (a floored neutral, rev1 I4) still ends its yawn.
        const fallOk = x.tMs - lastHigh >= y.rampMinS * 1000 - 1e-6;
        if (o < lo || fallOk) {
          if (riseOk && fallOk && heldS >= y.heldS - 1e-6 && !speech && !laugh) out.push({ kind: 'yawn', tMs: x.tMs });
          reset();
          // Ending above 1.5, the next ramp is timed from its own first frame, as at the start.
          lastBelow = o < lo ? x.tMs : null;
        }
      }
      return out;
    },
  };
}

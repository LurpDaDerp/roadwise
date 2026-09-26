// The eye and mouth baselines during a drive (Task C6; design rev2 §2.3.4, rev1 I3, rev3, rev4 §2.3.9). Pure and
// bounded: the frame clock is the only clock; per eye a 5 × 1-minute histogram, O(1) per frame.
//
// - Eligible frames: TRACKING, moving (not STOPPED, ≥ admitMinSpeedKmh), no episode (a closure, a bridge, a yawn
//   or talking: `hold`), |head yaw| ≤ maxYawDeg, head pitch within ±maxPitchRelDeg of the reference, the eye
//   usable, and its openness against the current reference ≥ minOpenness.
// - The p90 is read every readEveryS, never at a boundary inside an episode.
// - EAR up: ≤ earUpPctPerMin, capped at earUpCapFrac × the drive reference.
// - EAR down: NEVER continuous. Only on an appearance event, held appearanceHoldS: a stable change of an eye's
//   usability/iris tier, the eye luma ≥ appearanceLumaFrac against the luma at the current reference, or the
//   projected IOD ≥ appearanceIodFrac. A checkS window of eligible frames then gives the observed factor, and the
//   reference is lowered only with the fatigue gate clear and only by the EXPLAINED factor, never the full drop.
//   C6 round 1 (review-C6 C6-1): only lid-INDEPENDENT evidence explains a drop: the FACE luma (the luma table,
//   device item K5) and the projected IOD (the IOD model), and only when one of them changed by an event's size.
//   The iris contrast and the eye-ROI luma fall with a lowering lid, so they never explain anything; a lone tier
//   loss explains nothing (fatigue evidence). An unexplained remainder is fatigue evidence (`lowUnexplained`,
//   held unexplainedHoldS).
// - A continuous q/b ≤ lowRatio for lowHoldS with no event is fatigue evidence too, and changes nothing.
// - The floor: max(earFloorFrac × the drive reference × its appearance correction, earFloorFrac × the profile
//   EAR). The profile's appearance is not stored yet (T8), so its correction is 1.
// - The MAR: up ≤ marUpPctPerMin and ≤ +marUpCap10MinFrac per 10 min, never with a yawn in yawnBlockS; down
//   ≤ marDownPctPerMin, floored at neutralMarFloor; talking (MAR above talkMarFactor × the reference) excluded.
// - With no reference (the eyes never usable, e.g. sunglasses), eyes becoming usable give one after checkS.
import type { EarPair } from './conditioning';
import type { DmsConfig } from './config';
import { correctedRef, deconvolvedP90, EarNoiseMeter } from './earNoise';

export interface EyeSample {
  ear: number;
  /** the iris contrast: recorded in the appearance (diagnostics), never an explanation (it falls with the lid) */
  contrast?: number;
  usable: boolean;
  /** the iris was seen (the reliable tier) */
  reliable: boolean;
}

export interface BaselineInput {
  tMs: number;
  /** observed seconds since the previous frame (0 on a gap) */
  dtS: number;
  /** not STOPPED and at the admission speed (rev4 S4) */
  moving: boolean;
  tracking: boolean;
  /** an episode is running: a closure, a bridge, a yawn or talking (or STOPPED): no change at a boundary */
  hold: boolean;
  headYaw: number | null;
  /** head pitch against the pitch reference */
  headPitchRel: number | null;
  r: EyeSample | null;
  l: EyeSample | null;
  /** the projected IOD (iod / cos yaw cos pitch) */
  iodC: number | null;
  /** C6 round 1: the FACE ROI luma (lid-independent), null without a face */
  faceLuma: number | null;
  /** null when there is no mouth */
  mar: number | null;
  fatigueGate: boolean;
  /**
   * With no reference, may usable eyes derive one after checkS (default true)? The calibrator allows it only after
   * the eyes were unseen for a while (sunglasses off), so a drive start keeps its 20 s provisional collector.
   */
  mayDerive?: boolean;
}

/** The appearance behind a reference: the face luma and the projected IOD (lid-independent; C6 round 1). */
export interface Appearance {
  luma: number;
  iodC: number;
  /** the mean iris contrast: recorded, never an explanation (C6 round 1); null when unknown */
  contrast?: number | null;
}

export type BaselineEventKind = 'appearance' | 'ear_derived' | 'ear_raised' | 'ear_lowered' | 'ear_unexplained' | 'ear_low_unexplained';
export interface BaselineEvent {
  kind: BaselineEventKind;
  tMs: number;
}

export interface BaselineOut {
  ear: EarPair | null;
  mar: number | null;
  events: BaselineEvent[];
}

export interface Baselines {
  /**
   * A derived reference (Stage 1, a seed, a profile, a driver change): the profile floor applies. Task C8: a
   * profile's reference comes with the appearance it was taken under, which becomes the reference's (so an
   * appearance change since then is an event, and is followed by the factor it explains).
   */
  setReference(ear: EarPair, mar: number | null, tMs: number, appearance?: Appearance | null): EarPair;
  /** Task C8: the drive's reference as set (verified, never the adapted state) and its appearance, for the profile */
  reference0(): { ear: EarPair; appearance: Appearance | null } | null;
  /** C7 round 4 (B): one eye's frame-to-frame EAR noise σ_n (capped), null before enough open pairs */
  noiseSigma(side: 'r' | 'l'): number | null;
  /**
   * C8 round 1 (review-C8 C8-2): what the profile saves. The reference as set (reference0) or, when the drive's
   * reference has only ever been RAISED from it (no downward adoption), the current reference, whichever is not lower,
   * each with its appearance: an upward move is always safe (C6), a downward one is never saved (a drowsy start's
   * Stage 1 EAR is replaced by the raised value it was corrected to).
   */
  savedReference(): { ear: EarPair; appearance: Appearance | null } | null;
  step(x: BaselineInput): BaselineOut;
  /**
   * A value from a resume path (rederiveEar, baselineReset; R4): up is taken; down only with the fatigue gate
   * clear and by the factor its appearance explains against the reference's.
   */
  offer(candidate: EarPair, appearance: Appearance | null, gate?: boolean): EarPair;
  onYawn(tMs: number): void;
  /** Task C8 (rev2 §2.2 item 3): the start check re-derived the MAR: a new reference, its history restarted */
  setMar(m: number, tMs: number): void;
  /** fatigue evidence: an unexplained EAR drop (at an event, or a continuous low q/b) */
  lowUnexplained(): boolean;
  /** Task C7 (H5): the eye baseline is degraded (corroborated) */
  eyesDegraded(): boolean;
  /** the current appearance (smoothed), for the resume paths */
  appearance(): Appearance | null;
  reset(): void;
  stats(): { derived: number; raised: number; lowered: number; unexplained: number; lowUnexplained: number };
}

const BINS = 150;
const BIN = 0.004;
/**
 * C7 round 4 (review-C7 Round 4 ruling, B): the EAR histograms' bins are 0.001 (0 to 0.6), so the deconvolved read's
 * P90 and median are well inside the noise σ (0.009–0.012 EAR) the correction removes; the MAR keeps 0.004.
 */
const EAR_BINS = 600;
const EAR_BIN = 0.001;
const APP_TAU_S = 2;
const TIER_HOLD_S = 1;
/** a check window takes every eligible frame above this openness (the histogram's minOpenness would hide the drop it measures) */
const CHECK_MIN_OPENNESS = 0.3;

/** Piecewise-linear lookup; clamped at the ends. */
function interp(table: readonly (readonly [number, number])[], x: number): number {
  if (table.length === 0) return 1;
  if (x <= table[0]![0]) return table[0]![1];
  for (let i = 1; i < table.length; i++) {
    const [x1, y1] = table[i]!;
    const [x0, y0] = table[i - 1]!;
    if (x <= x1) return y0 + ((y1 - y0) * (x - x0)) / (x1 - x0);
  }
  return table[table.length - 1]![1];
}

/** The EAR factor an appearance change explains (ratios now ÷ at the reference): K5's luma table and the IOD model. */
export function explainedFactor(cfg: Pick<DmsConfig, 'calibration'>, ratio: { luma: number; iod: number }): number {
  const b = cfg.calibration.baselines;
  return interp(b.lumaEarTable, ratio.luma) * (1 + b.iodEarPerFrac * (ratio.iod - 1));
}

type Tier = 0 | 1 | 2;
type TierState = { now: Tier; cand: Tier; since: number };
const tierOf = (e: EyeSample | null): Tier => (e === null || !e.usable ? 0 : e.reliable ? 2 : 1);

/** Per eye, a histogram of 5 one-minute buckets; each bin also sums its values, so a quantile is the bin's mean value (no grid bias). */
class EarHist {
  private readonly h: Float64Array;
  private readonly v: Float64Array;
  private readonly minute: number[];
  constructor(private readonly buckets: number, private readonly bin = BIN, private readonly bins = BINS) {
    this.h = new Float64Array(buckets * this.bins);
    this.v = new Float64Array(buckets * this.bins);
    this.minute = new Array<number>(buckets).fill(Number.NEGATIVE_INFINITY);
  }
  add(tMs: number, v: number, w: number): void {
    const m = Math.floor(tMs / 60_000);
    const i = ((m % this.buckets) + this.buckets) % this.buckets;
    if (this.minute[i] !== m) {
      this.h.fill(0, i * this.bins, (i + 1) * this.bins);
      this.v.fill(0, i * this.bins, (i + 1) * this.bins);
      this.minute[i] = m;
    }
    const bin = Math.min(this.bins - 1, Math.max(0, Math.floor(v / this.bin)));
    this.h[i * this.bins + bin]! += w;
    this.v[i * this.bins + bin]! += w * v;
  }
  /** The q-quantile over the buckets of the last `buckets` minutes, and the weight behind it. */
  quantile(tMs: number, q: number): { v: number; w: number } {
    const m = Math.floor(tMs / 60_000);
    let total = 0;
    const acc = new Float64Array(this.bins);
    const sum = new Float64Array(this.bins);
    for (let i = 0; i < this.buckets; i++) {
      if (!(this.minute[i]! > m - this.buckets)) continue;
      for (let j = 0; j < this.bins; j++) {
        const x = this.h[i * this.bins + j]!;
        acc[j]! += x;
        sum[j]! += this.v[i * this.bins + j]!;
        total += x;
      }
    }
    if (!(total > 0)) return { v: Number.NaN, w: 0 };
    let run = 0;
    for (let j = 0; j < this.bins; j++) {
      run += acc[j]!;
      if (run >= q * total - 1e-12 && acc[j]! > 0) {
        return { v: sum[j]! / acc[j]!, w: total };
      }
    }
    return { v: (this.bins - 0.5) * this.bin, w: total };
  }
  clear(): void {
    this.h.fill(0);
    this.v.fill(0);
    this.minute.fill(Number.NEGATIVE_INFINITY);
  }
}

export function createBaselines(cfg: Pick<DmsConfig, 'calibration'>, init: { profileEar: EarPair | null; profileAppearance?: Appearance | null }): Baselines {
  const c = cfg.calibration;
  const b = c.baselines;
  const profile = init.profileEar;
  /** Task C8: the appearance the profile's EAR was taken under (its floor is corrected by the change since) */
  const profileApp = init.profileAppearance ?? null;
  const hist = { r: new EarHist(b.buckets, EAR_BIN, EAR_BINS), l: new EarHist(b.buckets, EAR_BIN, EAR_BINS) };
  const marHist = new EarHist(b.buckets);
  let ref: EarPair | null = null;
  let ref0: EarPair | null = null;
  let ref0App: Appearance | null = null;
  let refApp: Appearance | null = null;
  /** C8 round 1 (C8-2): the drive's reference has only been raised since it was set (no downward adoption) */
  let onlyRaised = true;
  /** C7 round 4 (review-C7 Round 4 ruling, B): the frame-to-frame EAR noise, for the noise-corrected P90 */
  const noise = new EarNoiseMeter(b.earNoiseMaxSd);
  const sigmaOf = (side: 'r' | 'l') => noise.sigma(side, tNow);
  let refTier: { r: Tier; l: Tier } = { r: 0, l: 0 };
  /**
   * A reference set before its appearance is known (no TRACKING frame yet, or the tiers not settled): the first
   * settled appearance becomes the reference's (and the drive reference's), so an appearance change is measured
   * against the appearance the reference was taken under, never against nothing.
   */
  let appPending = true;
  let mar: number | null = null;
  /** the MAR reference at each read in the last 10 min (the +20 % per 10 min cap) */
  let marReads: { t: number; v: number }[] = [];
  let app: Appearance | null = null;
  const tier: { r: TierState; l: TierState } = { r: { now: 0, cand: 0, since: 0 }, l: { now: 0, cand: 0, since: 0 } };
  let tiersSeen = false;
  const tiersSettled = () => tiersSeen && tier.r.cand === tier.r.now && tier.l.cand === tier.l.now;
  let lumaOffSince: number | null = null;
  let iodOffSince: number | null = null;
  let check: { obsS: number; r: number[]; l: number[] } | null = null;
  let checkCooldownUntil = Number.NEGATIVE_INFINITY;
  let lastSlot: number | null = null;
  /** a boundary passed inside an episode: the read waits for its end (never a change while closed or stopped) */
  let readDue = false;
  let lowSince: number | null = null;
  /** Task C7 (H5) */
  let lastAppEventT = Number.NEGATIVE_INFINITY;
  let h5BadSince: number | null = null;
  let h5GoodSince: number | null = null;
  let h5Degraded = false;
  let lowFlag = false;
  let unexplainedUntil = Number.NEGATIVE_INFINITY;
  let yawnT = Number.NEGATIVE_INFINITY;
  let tNow = 0;
  const stats = { derived: 0, raised: 0, lowered: 0, unexplained: 0, lowUnexplained: 0 };

  const ratios = (now: Appearance, at: Appearance) => ({
    luma: at.luma > 0 ? now.luma / at.luma : 1,
    iod: at.iodC > 0 ? now.iodC / at.iodC : 1,
  });
  /**
   * C6 round 1: the factor a change of appearance explains, or 1 when neither the face luma nor the IOD changed
   * by an event's size (a lone tier change, or small drifts, explain nothing).
   */
  const explainedBetween = (now: Appearance, at: Appearance): number => {
    const rt = ratios(now, at);
    const sized = Math.abs(rt.luma - 1) >= b.appearanceLumaFrac || Math.abs(rt.iod - 1) >= b.appearanceIodFrac;
    return sized ? explainedFactor(cfg, rt) : 1;
  };

  /** The floor for one eye: the drive reference (appearance-corrected) and the profile anchor. */
  function floorOf(side: 'r' | 'l', now: Appearance | null = app): number {
    let f = 0;
    const r0 = ref0?.[side] ?? null;
    if (r0 !== null) {
      const corr = now !== null && ref0App !== null ? explainedBetween(now, ref0App) : 1;
      f = Math.max(f, b.earFloorFrac * r0 * corr);
    }
    f = Math.max(f, profileFloor(side, now));
    return f;
  }
  /** The profile anchor: 0.85 × the profile's EAR, corrected (Task C8) by the appearance change since it was taken. */
  function profileFloor(side: 'r' | 'l', now: Appearance | null): number {
    const p = profile?.[side] ?? null;
    if (p === null) return 0;
    const corr = now !== null && profileApp !== null ? explainedBetween(now, profileApp) : 1;
    return b.earFloorFrac * p * corr;
  }
  const floored = (side: 'r' | 'l', v: number | null, now: Appearance | null = app) => (v === null ? null : Math.max(v, floorOf(side, now)));

  function adopt(next: EarPair): void {
    if (ref !== null && ((next.r !== null && ref.r !== null && next.r < ref.r - 1e-12) || (next.l !== null && ref.l !== null && next.l < ref.l - 1e-12))) onlyRaised = false;
    ref = next;
    refApp = app === null ? null : { ...app };
    refTier = { r: tier.r.now, l: tier.l.now };
    appPending = app === null || !tiersSettled();
    hist.r.clear();
    hist.l.clear();
    lowSince = null;
    lowFlag = false;
  }

  function setReference(ear: EarPair, m: number | null, tMs: number, appearance: Appearance | null = null): EarPair {
    tNow = tMs;
    // Task C8: with the reference's own appearance given (a profile's), the floor is corrected against it.
    const at = appearance ?? app;
    const p = (side: 'r' | 'l', v: number | null) => (v === null ? null : Math.max(v, profileFloor(side, at)));
    const next = { r: p('r', ear.r), l: p('l', ear.l) };
    ref0 = next;
    ref0App = at === null ? null : { ...at };
    adopt(next);
    onlyRaised = true;
    if (appearance !== null) {
      refApp = { ...appearance };
      appPending = false;
    }
    if (m !== null) {
      mar = Math.max(m, c.neutralMarFloor);
      marReads = [{ t: tMs, v: mar }];
      marHist.clear();
    }
    return next;
  }

  function offer(cand: EarPair, appearance: Appearance | null, gate = false): EarPair {
    if (ref === null) return setReference(cand, null, tNow);
    const cur = ref;
    // Down only on an appearance event (rev2 §2.3.4): an offered drop explains nothing unless its appearance differs
    // from the reference's by an event's size.
    const explained = appearance !== null && refApp !== null ? explainedBetween(appearance, refApp) : 1;
    let down = false;
    const pick = (side: 'r' | 'l'): number | null => {
      const was = cur[side];
      const v = cand[side];
      if (v === null) return was;
      if (was === null) return floored(side, v);
      if (v >= was) return v;
      if (gate) return was;
      const next = Math.max(v, was * Math.min(1, explained));
      if (next < was) down = true;
      return floored(side, next, appearance ?? app);
    };
    const next = { r: pick('r'), l: pick('l') };
    const keepApp = !down;
    const oldApp = refApp;
    adopt(next);
    if (keepApp) refApp = oldApp;
    else if (appearance !== null) refApp = { ...appearance };
    return next;
  }

  function resolveCheck(x: BaselineInput, events: BaselineEvent[]): void {
    const chk = check!;
    check = null;
    // C7 round 4 (B): the noise-corrected P90.
    const p90 = (xs: number[], side: 'r' | 'l') => (xs.length < 10 ? null : correctedRef(xs, sigmaOf(side)));
    const obs = { r: p90(chk.r, 'r'), l: p90(chk.l, 'l') };
    if (ref === null || (ref.r === null && ref.l === null)) {
      if (obs.r === null && obs.l === null) return;
      setReference({ r: obs.r, l: obs.l }, null, x.tMs);
      stats.derived++;
      events.push({ kind: 'ear_derived', tMs: x.tMs });
      return;
    }
    const explained = app !== null && refApp !== null ? explainedBetween(app, refApp) : 1;
    const cur = ref;
    let up = false;
    let down = false;
    let unexplained = false;
    let blocked = false;
    const pick = (side: 'r' | 'l'): number | null => {
      const was = cur[side];
      const v = obs[side];
      if (v === null) return was;
      if (was === null) return floored(side, v);
      const f = v / was;
      if (f >= 1) {
        if (f > 1 + 1e-9) up = true;
        return Math.min(v, (ref0?.[side] ?? was) * b.earUpCapFrac);
      }
      if (x.fatigueGate) {
        blocked = true;
        return was;
      }
      const allowed = Math.min(1, explained);
      if (f < allowed - b.explainTol) unexplained = true;
      const next = floored(side, was * Math.max(f, allowed))!;
      if (next < was - 1e-12) down = true;
      return next;
    };
    const next = { r: pick('r'), l: pick('l') };
    if (blocked) {
      // Kept: the appearance stays pending and is checked again once the gate clears.
      checkCooldownUntil = x.tMs + b.readEveryS * 1000;
      return;
    }
    adopt(next);
    if (up) {
      stats.raised++;
      events.push({ kind: 'ear_raised', tMs: x.tMs });
    }
    if (down) {
      stats.lowered++;
      events.push({ kind: 'ear_lowered', tMs: x.tMs });
    }
    if (unexplained) {
      stats.unexplained++;
      unexplainedUntil = x.tMs + b.unexplainedHoldS * 1000;
      events.push({ kind: 'ear_unexplained', tMs: x.tMs });
    }
  }

  function read(x: BaselineInput, events: BaselineEvent[]): void {
    if (ref !== null && check === null) {
      let allLow = true;
      let anyEye = false;
      let allHigh = true;
      let allH5Low = true;
      const cur = ref;
      const next: EarPair = { ...cur };
      for (const side of ['r', 'l'] as const) {
        const was = cur[side];
        if (was === null) continue;
        // C7 round 4 (B): the read uses the reference's estimator (the noise-corrected P90), so q/b keeps its meaning.
        const q90 = hist[side].quantile(x.tMs, 0.9);
        const q50 = hist[side].quantile(x.tMs, 0.5);
        const q = { v: q90.w > 0 && q50.w > 0 ? deconvolvedP90(q90.v, q50.v, sigmaOf(side)) : q90.v, w: q90.w };
        if (!(q.w >= b.minReadS)) {
          allLow = false;
          continue;
        }
        anyEye = true;
        if (q.v / was > b.lowRatio) allLow = false;
        if (!(q.v / was > b.h5Hi)) allHigh = false;
        if (!(q.v / was < b.h5Lo)) allH5Low = false;
        if (q.v > was) {
          const step = ((ref0?.[side] ?? was) * b.earUpPctPerMin * b.readEveryS) / (100 * 60);
          next[side] = Math.min(q.v, was + step, (ref0?.[side] ?? was) * b.earUpCapFrac);
        }
      }
      if ((next.r ?? 0) > (cur.r ?? 0) + 1e-12 || (next.l ?? 0) > (cur.l ?? 0) + 1e-12) {
        ref = next;
        stats.raised++;
        events.push({ kind: 'ear_raised', tMs: x.tMs });
      }
      // A continuous low q/b with no appearance event: fatigue evidence, nothing changes. A read with no eye's
      // weight (a droop so deep that every frame is under minOpenness, or the eyes unseen) keeps the state.
      if (!anyEye) {
        // no evidence either way
      } else if (allLow) {
        lowSince ??= x.tMs;
        if (x.tMs - lowSince >= b.lowHoldS * 1000 && !lowFlag) {
          lowFlag = true;
          stats.lowUnexplained++;
          events.push({ kind: 'ear_low_unexplained', tMs: x.tMs });
        }
      } else {
        lowSince = null;
        lowFlag = false;
      }
      // Task C7 (H5): up alone, or down WITH a face-luma/IOD event (corroborated); held, and recovered, h5HoldS.
      if (anyEye) {
        const corroborated = x.tMs - lastAppEventT <= b.h5CorroborateS * 1000;
        const bad = allHigh || (allH5Low && corroborated);
        if (bad) {
          h5GoodSince = null;
          h5BadSince ??= x.tMs;
          if (x.tMs - h5BadSince >= b.h5HoldS * 1000) h5Degraded = true;
        } else {
          h5BadSince = null;
          if (h5Degraded) {
            h5GoodSince ??= x.tMs;
            if (x.tMs - h5GoodSince >= b.h5HoldS * 1000) {
              h5Degraded = false;
              h5GoodSince = null;
            }
          }
        }
      }
    }
    // The MAR.
    if (mar !== null) {
      const q = marHist.quantile(x.tMs, 0.5);
      if (q.w >= b.minReadS) {
        const dtMin = b.readEveryS / 60;
        marReads = marReads.filter((r) => r.t >= x.tMs - 600_000);
        const base10 = marReads.length > 0 ? marReads[0]!.v : mar;
        let next = mar;
        if (q.v > mar && x.tMs - yawnT > b.yawnBlockS * 1000) next = Math.min(q.v, mar * (1 + (b.marUpPctPerMin / 100) * dtMin), base10 * (1 + b.marUpCap10MinFrac));
        else if (q.v < mar) next = Math.max(q.v, mar * (1 - (b.marDownPctPerMin / 100) * dtMin), c.neutralMarFloor);
        mar = Math.max(next, c.neutralMarFloor);
        marReads.push({ t: x.tMs, v: mar });
      }
    }
  }

  return {
    setReference,
    offer,
    onYawn(tMs) {
      yawnT = Math.max(yawnT, tMs);
    },
    setMar(m, tMs) {
      mar = Math.max(m, c.neutralMarFloor);
      marReads = [{ t: tMs, v: mar }];
      marHist.clear();
    },
    lowUnexplained: () => lowFlag || tNow <= unexplainedUntil,
    reference0: () => (ref0 === null ? null : { ear: { ...ref0 }, appearance: ref0App === null ? null : { ...ref0App } }),
    noiseSigma: (side) => sigmaOf(side),
    savedReference() {
      if (ref0 === null) return null;
      const set = { ear: { ...ref0 }, appearance: ref0App === null ? null : { ...ref0App } };
      if (!onlyRaised || ref === null) return set;
      const notLower = (ref.r ?? 0) >= (ref0.r ?? 0) - 1e-12 && (ref.l ?? 0) >= (ref0.l ?? 0) - 1e-12;
      return notLower ? { ear: { ...ref }, appearance: refApp === null ? set.appearance : { ...refApp } } : set;
    },
    eyesDegraded: () => h5Degraded,
    appearance: () => (app === null ? null : { ...app }),
    reset() {
      ref = null;
      lastAppEventT = Number.NEGATIVE_INFINITY;
      h5BadSince = null;
      h5GoodSince = null;
      h5Degraded = false;
      ref0 = null;
      ref0App = null;
      refApp = null;
      onlyRaised = true;
      mar = null;
      marReads = [];
      check = null;
      hist.r.clear();
      hist.l.clear();
      marHist.clear();
      lowSince = null;
      lowFlag = false;
      lumaOffSince = null;
      iodOffSince = null;
    },
    stats: () => ({ ...stats }),

    step(x) {
      tNow = x.tMs;
      const events: BaselineEvent[] = [];
      const dt = x.dtS;
      // C7 round 4 (B): the frame-to-frame noise, from every TRACKING frame's usable eyes.
      if (x.tracking) {
        noise.frame(x.tMs);
        for (const side of ['r', 'l'] as const) {
          const e = x[side];
          noise.eye(side, x.tMs, e !== null && e.usable ? e.ear : null, ref?.[side] ?? null);
        }
      }
      // The appearance (smoothed) and the stable tiers, from TRACKING frames.
      if (x.tracking && dt > 0) {
        const anyEye = (x.r !== null && x.r.usable) || (x.l !== null && x.l.usable);
        if (anyEye && x.iodC !== null && x.faceLuma !== null) {
          const k = Math.min(1, dt / APP_TAU_S);
          // the contrast (diagnostic) from open-eye frames only: a blink or an episode would pull it down
          let cs = 0;
          let cn = 0;
          if (!x.hold) for (const e of [x.r, x.l]) {
            if (e !== null && e.usable && e.contrast !== undefined) {
              cs += e.contrast;
              cn++;
            }
          }
          const contrast = cn > 0 ? cs / cn : null;
          if (app === null) app = { luma: x.faceLuma, iodC: x.iodC, contrast };
          else {
            app.luma += k * (x.faceLuma - app.luma);
            app.iodC += k * (x.iodC - app.iodC);
            app.contrast = contrast === null ? (app.contrast ?? null) : app.contrast == null ? contrast : app.contrast + k * (contrast - app.contrast);
          }
        }
        for (const side of ['r', 'l'] as const) {
          const t = tier[side];
          const cand = tierOf(x[side]);
          if (cand !== t.cand) {
            t.cand = cand;
            t.since = x.tMs;
          }
          if (t.cand !== t.now && x.tMs - t.since >= TIER_HOLD_S * 1000) t.now = t.cand;
        }
        if (!tiersSeen && x.tMs - Math.min(tier.r.since, tier.l.since) >= TIER_HOLD_S * 1000) tiersSeen = true;
      }
      // The reference's appearance, once known (see appPending).
      if (appPending && ref !== null && app !== null && tiersSettled()) {
        refApp = { ...app };
        refTier = { r: tier.r.now, l: tier.l.now };
        ref0App ??= { ...app };
        appPending = false;
      }

      // Eligibility (never stopped, never in an episode).
      const eligible = x.tracking && x.moving && !x.hold && dt > 0 && (x.headYaw === null || Math.abs(x.headYaw) <= b.maxYawDeg) && (x.headPitchRel === null || Math.abs(x.headPitchRel) <= b.maxPitchRelDeg);
      if (eligible) {
        for (const side of ['r', 'l'] as const) {
          const e = x[side];
          if (e === null || !e.usable) continue;
          const was = ref?.[side] ?? null;
          const o = was === null ? 1 : e.ear / was;
          if (check !== null && o >= CHECK_MIN_OPENNESS) check[side].push(e.ear);
          if (o >= b.minOpenness) hist[side].add(x.tMs, e.ear, dt);
        }
        if (check !== null) check.obsS += dt;
        if (x.mar !== null && mar !== null && x.mar <= b.talkMarFactor * mar) marHist.add(x.tMs, x.mar, dt);
      }

      // Appearance events (held), and the eyes becoming usable with no reference.
      if (check === null && x.tMs >= checkCooldownUntil) {
        let event = false;
        if (ref === null || (ref.r === null && ref.l === null)) {
          event = x.mayDerive !== false && (tier.r.now > 0 || tier.l.now > 0);
        } else if (app !== null && refApp !== null) {
          const rt = ratios(app, refApp);
          lumaOffSince = Math.abs(rt.luma - 1) >= b.appearanceLumaFrac ? (lumaOffSince ?? x.tMs) : null;
          iodOffSince = Math.abs(rt.iod - 1) >= b.appearanceIodFrac ? (iodOffSince ?? x.tMs) : null;
          const held = (s: number | null) => s !== null && x.tMs - s >= b.appearanceHoldS * 1000;
          if (held(lumaOffSince) || held(iodOffSince)) lastAppEventT = x.tMs; // Task C7: H5's corroboration
          event = held(lumaOffSince) || held(iodOffSince) || tier.r.now !== refTier.r || tier.l.now !== refTier.l;
        }
        if (event) {
          check = { obsS: 0, r: [], l: [] };
          lowSince = null;
          if (ref !== null) events.push({ kind: 'appearance', tMs: x.tMs });
        }
      }
      if (check !== null && check.obsS >= b.checkS) {
        resolveCheck(x, events);
        lumaOffSince = null;
        iodOffSince = null;
      }

      // The reads at readEveryS boundaries, never inside an episode.
      const slot = Math.floor(x.tMs / (b.readEveryS * 1000));
      if (lastSlot === null) lastSlot = slot;
      else if (slot !== lastSlot) {
        lastSlot = slot;
        readDue = true;
      }
      if (readDue && !x.hold && x.moving) {
        readDue = false;
        read(x, events);
      }
      return { ear: ref === null ? null : { ...ref }, mar, events };
    },
  };
}

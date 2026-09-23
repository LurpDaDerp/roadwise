// The fatigue score (plan §M7; spec "Fatigue score"). Pure and bounded: the frame clock is the caller's.
//
// - Learning: the score is off until 10 min of driving at a known or held (tunnel) ≥ 20 km/h
//   (`ruleSpeedKmh`). Those minutes set the personal baselines (frames and events while at speed).
// - Every 60 s (from the first frame) a minute is closed: `learning`, `insufficient` (TRACKING < 50 % of
//   the last 60 s) or `scored`.
// - Sub-score s = clamp((x − b) / (e − b), 0, 1), e = max(target, b + margin):
//   PERCLOS P80 (60 s), long blinks per minute (5 min), mean blink duration as a ratio to the baseline
//   (5 min, b = 1), nods (10 min), yawns (15 min), and gaze dispersion "reduced" (5 min: x = 1 − the
//   window's dispersion / the baseline's, b = 0).
// - Rates are per OBSERVED time (T10 review I1), in the window and in the baseline alike: long blinks,
//   yawns and nods per TRACKING second (`trackS`, not bridged), each scaled to the row's window. Nods
//   need TRACKING too (T10 r1 m1): since T9 m2 a nod needs a known openness, which exists only in
//   TRACKING, so HEAD_ONLY time is not nod-observable. Wall-clock rates would read a glare window low and
//   a baseline learned in glare high. A row observed for under 50 % of its window (PERCLOS: under
//   `perclosMinTrackingS`) is dropped for the minute as `sparse`, which is not `degraded`.
// - A minute whose surviving weights sum below `minScoredWeight` (0.25) is `insufficient` (T10 r1 m2): no
//   score from one weak row or from nothing, but its drops are still reported.
// - Learning also waits for `minTrackingShare × activeAfterS` (300 s) of TRACKING at speed (T10 r1 m3),
//   so the baselines are never built on a few observed seconds; the fast rules' floor covers the wait.
// - A row whose minFps is above the minute's mean measured fps is dropped and the weights renormalise; the
//   minute is `degraded`, with one reason: `hot` when the thermal governor was active in it (the frame
//   rate was cut for heat), else `low_fps` (rev1: R-U4).
// - Score = 100 × the weighted sum, × 1.15 past a 2 h trip, × 1.15 at 00:00–06:00 local (an unknown
//   local time is never night), capped at 100. The amplifiers multiply, so they never raise a zero.
// - Levels 40 / 60 / 80; the fast rules' floor (F1 → at least Drowsy, F4 → Severe) applies on every
//   minute, learning and insufficient ones included (a microsleep is evidence on its own).
// - Actions: early → Tier 1 `fatigue_early` at most once per 20 min; drowsy → a Tier 2 `fatigue` burst
//   every 5 min; severe → a burst every 2 min, plus an event.
// - C-26: PERCLOS and the TRACKING share count only TRACKING frames that are not bridged.
import type { AnglePair } from './types';
import type { DmsConfig, FatigueSignal } from './config';
import type { FatigueFloor } from './fastRules';
import type { Quality } from './quality';
import { RingBuffer } from './windows';

export type FatigueLevel = 'none' | 'early' | 'drowsy' | 'severe';
export type SignalName = 'perclos' | 'longBlinks' | 'blinkDuration' | 'nods' | 'yawns' | 'dispersion';
export const SIGNALS: readonly SignalName[] = ['perclos', 'longBlinks', 'blinkDuration', 'nods', 'yawns', 'dispersion'];

export interface FatigueFrame {
  tMs: number;
  dtS: number;
  quality: Quality;
  closureBridged: boolean;
  openness: number | null;
  lookingDown: boolean;
  /** the rules' relative gaze; null without one */
  gazeRel: AnglePair | null;
  /**
   * which path gave the gaze (Perceived.gazeFrom). Only a net configuration ever says 'net'; its dispersion is
   * summed apart from everything else and scored against its own baseline (T16 r3 m2). Absent = not net.
   */
  gazeFrom?: 'net' | 'geometric' | null;
  /** ContextState.ruleSpeedKmh; null = unknown (never counts toward learning) */
  speedKmh: number | null;
  /** the measured fps (the fps meter) */
  fps: number;
  /** the thermal governor is cutting the frame rate */
  hot: boolean;
  tripElapsedS: number;
  /** local minutes since midnight; null = unknown, which is never night */
  localMinutes: number | null;
  /** the fast rules' fatigue floor at this frame */
  floor: FatigueFloor;
}

export interface FatigueAction {
  kind: 'fatigue_early' | 'fatigue';
  tier: 1 | 2;
  level: FatigueLevel;
  /** severe: the burst is also logged as an event */
  event: boolean;
  tMs: number;
}

export interface FatigueMinute {
  tMs: number;
  status: 'learning' | 'insufficient' | 'scored';
  score: number | null;
  /** per row: the sub-score, or null when dropped (or not scored) */
  sub: Record<SignalName, number | null>;
  /** per row: the value and its baseline behind the sub-score (diagnostics); null when not scored */
  raw: Record<SignalName, { x: number; b: number } | null>;
  /** rows dropped this minute for too little observed time (not a degraded minute) */
  sparse: SignalName[];
  level: FatigueLevel;
  degraded: boolean;
  reason: 'hot' | 'low_fps' | null;
  perclosDropped: boolean;
  fps: number;
  actions: FatigueAction[];
}

export interface FatigueStats {
  minutes: number;
  scoredMinutes: number;
  degradedMinutes: { hot: number; low_fps: number };
  perclosDroppedMinutes: number;
  /** minutes each row was dropped as sparse */
  sparseRowMinutes: Record<SignalName, number>;
  /** the last 24 h of minutes */
  timeline: FatigueMinute[];
}

const LEVEL_RANK: Record<FatigueLevel, number> = { none: 0, early: 1, drowsy: 2, severe: 3 };

/** The level for a score (40 / 60 / 80 by default). */
export function levelOf(score: number, levels: readonly [number, number, number] | readonly number[]): FatigueLevel {
  if (score >= levels[2]!) return 'severe';
  if (score >= levels[1]!) return 'drowsy';
  if (score >= levels[0]!) return 'early';
  return 'none';
}

/** s = clamp((x − b) / (e − b), 0, 1) with e = max(target, b + margin); 0 when e ≤ b. */
export function subScore(x: number, b: number, sig: Pick<FatigueSignal, 'target' | 'margin'>): number {
  const e = Math.max(sig.target, b + (sig.margin ?? 0));
  if (!(e > b)) return 0;
  return Math.min(1, Math.max(0, (x - b) / (e - b)));
}

/** The action timers (§M7): each level has its own period, measured from its last action. */
export function createFatigueActions(cfg: Pick<DmsConfig, 'fatigue'>) {
  const f = cfg.fatigue;
  const last: Record<Exclude<FatigueLevel, 'none'>, number | null> = { early: null, drowsy: null, severe: null };
  return {
    onMinute(tMs: number, level: FatigueLevel): FatigueAction[] {
      if (level === 'none') return [];
      const every = level === 'early' ? f.earlyEveryS : level === 'drowsy' ? f.drowsyEveryS : f.severeEveryS;
      const prev = last[level];
      if (prev !== null && tMs - prev < every * 1000 - 1e-6) return [];
      last[level] = tMs;
      return [{ kind: level === 'early' ? 'fatigue_early' : 'fatigue', tier: level === 'early' ? 1 : 2, level, event: level === 'severe', tMs }];
    },
  };
}

/** Dispersion sums for one gaze path. */
interface Disp {
  gn: number;
  gy: number;
  gp: number;
  gyy: number;
  gpp: number;
}
interface Second extends Disp {
  k: number;
  trackS: number;
  closedS: number;
  fpsSum: number;
  frames: number;
  hot: boolean;
  /** the net path's sums (a net configuration); the Disp fields hold every other gaze */
  net: Disp;
}
const newDisp = (): Disp => ({ gn: 0, gy: 0, gp: 0, gyy: 0, gpp: 0 });
const newSecond = (k: number): Second => ({ k, trackS: 0, closedS: 0, fpsSum: 0, frames: 0, hot: false, ...newDisp(), net: newDisp() });
const addDisp = (to: Disp, from: Disp) => {
  to.gn += from.gn;
  to.gy += from.gy;
  to.gp += from.gp;
  to.gyy += from.gyy;
  to.gpp += from.gpp;
};
const addGaze = (to: Disp, g: AnglePair) => {
  to.gn++;
  to.gy += g.yaw;
  to.gp += g.pitch;
  to.gyy += g.yaw * g.yaw;
  to.gpp += g.pitch * g.pitch;
};
const dispersionOf = (n: number, y: number, p: number, yy: number, pp: number) => (n < 2 ? null : Math.sqrt(Math.max(0, yy / n - (y / n) ** 2) + Math.max(0, pp / n - (p / n) ** 2)));


export function createFatigue(cfg: DmsConfig) {
  const f = cfg.fatigue;
  const sig = f.signals;
  const maxWindowS = Math.max(...SIGNALS.map((s) => sig[s].windowS), f.everyS);
  const seconds = new RingBuffer<Second>(maxWindowS + 2);
  let cur: Second | null = null;
  const blinks = new RingBuffer<{ t: number; durMs: number; long: boolean }>(4096);
  const nods = new RingBuffer<number>(512);
  const yawns = new RingBuffer<number>(512);
  const actions = createFatigueActions(cfg);
  const timeline = new RingBuffer<FatigueMinute>(1440);
  const stats = {
    minutes: 0,
    scoredMinutes: 0,
    degradedMinutes: { hot: 0, low_fps: 0 },
    perclosDroppedMinutes: 0,
    sparseRowMinutes: Object.fromEntries(SIGNALS.map((s) => [s, 0])) as Record<SignalName, number>,
  };

  // Learning: the baseline sums over frames (and events) at a known ≥ minSpeedKmh.
  const base = { drivingS: 0, trackS: 0, closedS: 0, longBlinks: 0, blinkN: 0, blinkDurMs: 0, nods: 0, yawns: 0, ...newDisp(), net: newDisp() };
  let active = false;
  let atSpeed = false;
  let nextMinute: number | null = null;

  const closedFrame = (x: FatigueFrame) =>
    x.openness !== null && x.openness < (x.lookingDown ? cfg.closure.lookDownClosedBelow : f.perclosOpennessBelow);
  const tracked = (x: FatigueFrame) => x.quality === 'tracking' && !x.closureBridged;

  /** Sums over the last `windowS` complete seconds before the one holding `nowMs`. */
  function over(nowMs: number, windowS: number) {
    const kNow = Math.floor(nowMs / 1000);
    const s = newSecond(0);
    const add = (x: Second) => {
      if (x.k < kNow - windowS || x.k >= kNow) return;
      s.trackS += x.trackS;
      s.closedS += x.closedS;
      s.fpsSum += x.fpsSum;
      s.frames += x.frames;
      s.hot ||= x.hot;
      addDisp(s, x);
      addDisp(s.net, x.net);
    };
    seconds.forEach(add);
    if (cur !== null) add(cur);
    return s;
  }
  const countSince = (ring: RingBuffer<number>, fromMs: number) => {
    let n = 0;
    ring.forEach((t) => (n += t > fromMs ? 1 : 0));
    return n;
  };

  function score(nowMs: number, x: FatigueFrame, minute: Second): Pick<FatigueMinute, 'score' | 'sub' | 'raw' | 'sparse' | 'degraded' | 'reason' | 'perclosDropped'> & { wSum: number } {
    const fps = minute.frames > 0 ? minute.fpsSum / minute.frames : 0;
    const values = {} as Record<SignalName, { x: number; b: number }>;
    /** the observed seconds behind each row, in its window */
    const observed = {} as Record<SignalName, number>;
    const w = (s: SignalName) => nowMs - sig[s].windowS * 1000;
    const win = (s: SignalName) => over(nowMs, sig[s].windowS);

    const pc = win('perclos');
    values.perclos = { x: pc.trackS > 0 ? pc.closedS / pc.trackS : 0, b: base.trackS > 0 ? base.closedS / base.trackS : 0 };
    observed.perclos = pc.trackS;

    let longN = 0;
    let durSum = 0;
    let durN = 0;
    blinks.forEach((bl) => {
      if (bl.t > w('longBlinks') && bl.long) longN++;
      if (bl.t > w('blinkDuration')) {
        durSum += bl.durMs;
        durN++;
      }
    });
    const lb = win('longBlinks');
    observed.longBlinks = lb.trackS;
    values.longBlinks = { x: lb.trackS > 0 ? longN / (lb.trackS / 60) : 0, b: base.trackS > 0 ? base.longBlinks / (base.trackS / 60) : 0 };
    const baseMean = base.blinkN > 0 ? base.blinkDurMs / base.blinkN : 0;
    observed.blinkDuration = win('blinkDuration').trackS;
    values.blinkDuration = { x: durN > 0 && baseMean > 0 ? durSum / durN / baseMean : 1, b: 1 };
    // Counts scaled to a fully observed window.
    const scaled = (n: number, windowS: number, obsS: number) => (obsS > 0 ? (n * windowS) / obsS : 0);
    const nw = win('nods');
    observed.nods = nw.trackS;
    values.nods = { x: scaled(countSince(nods, w('nods')), sig.nods.windowS, nw.trackS), b: scaled(base.nods, sig.nods.windowS, base.trackS) };
    const yw = win('yawns');
    observed.yawns = yw.trackS;
    values.yawns = { x: scaled(countSince(yawns, w('yawns')), sig.yawns.windowS, yw.trackS), b: scaled(base.yawns, sig.yawns.windowS, base.trackS) };
    const g = win('dispersion');
    observed.dispersion = g.trackS;
    // Within one path only (T16 r3 m2): the path that dominates the window, against that path's baseline. A
    // path with no baseline leaves the row sparse rather than compare two paths' noise.
    const onNet = g.net.gn > g.gn;
    const now = onNet ? g.net : g;
    const was = onNet ? base.net : base;
    const dNow = dispersionOf(now.gn, now.gy, now.gp, now.gyy, now.gpp);
    const dBase = dispersionOf(was.gn, was.gy, was.gp, was.gyy, was.gpp);
    values.dispersion = { x: dNow !== null && dBase !== null && dBase > 0 ? Math.max(0, 1 - dNow / dBase) : 0, b: 0 };
    const noBaseline = now.gn > 0 && dBase === null;

    const sub = {} as Record<SignalName, number | null>;
    const raw = {} as Record<SignalName, { x: number; b: number } | null>;
    const sparse: SignalName[] = [];
    let wSum = 0;
    let acc = 0;
    let lowFps = false;
    for (const s of SIGNALS) {
      sub[s] = null;
      raw[s] = null;
      if (sig[s].minFps > 0 && fps < sig[s].minFps) {
        lowFps = true;
        continue;
      }
      const minObs = s === 'perclos' ? f.perclosMinTrackingS : f.minTrackingShare * sig[s].windowS;
      if (observed[s] < minObs - 1e-6 || (s === 'dispersion' && noBaseline)) {
        sparse.push(s);
        continue;
      }
      raw[s] = values[s];
      sub[s] = subScore(values[s].x, values[s].b, sig[s]);
      wSum += sig[s].weight;
      acc += sig[s].weight * sub[s];
    }
    let total = wSum > 0 ? (100 * acc) / wSum : 0;
    if (x.tripElapsedS > f.longTripS) total *= f.longTripFactor;
    if (isNight(x.localMinutes)) total *= f.nightFactor;
    total = Math.min(f.cap, total);
    return { wSum, score: total, sub, raw, sparse, degraded: lowFps, reason: lowFps ? (minute.hot ? 'hot' : 'low_fps') : null, perclosDropped: sub.perclos === null };
  }

  function isNight(m: number | null): boolean {
    if (m === null) return false;
    const a = f.nightStartMin;
    const b = f.nightEndMin;
    return a <= b ? m >= a && m < b : m >= a || m < b;
  }

  function closeMinute(nowMs: number, x: FatigueFrame): FatigueMinute {
    const minute = over(nowMs, f.everyS);
    const fps = minute.frames > 0 ? minute.fpsSum / minute.frames : 0;
    const empty = Object.fromEntries(SIGNALS.map((s) => [s, null])) as Record<SignalName, null>;
    const none = { score: null, sub: empty, raw: empty, sparse: [], degraded: false, reason: null, perclosDropped: false, fps };
    let m: Omit<FatigueMinute, 'level' | 'actions'>;
    if (!active) m = { tMs: nowMs, status: 'learning', ...none };
    else if (minute.trackS < f.minTrackingShare * f.everyS - 1e-6) m = { tMs: nowMs, status: 'insufficient', ...none };
    else {
      const { wSum, ...r } = score(nowMs, x, minute);
      // Too little weight survives: no score, but the drops (sparse, fps, PERCLOS) are still reported.
      if (wSum < f.minScoredWeight - 1e-9) m = { tMs: nowMs, status: 'insufficient', ...none, sparse: r.sparse, degraded: r.degraded, reason: r.reason, perclosDropped: r.perclosDropped };
      else m = { tMs: nowMs, status: 'scored', fps, ...r };
    }
    let level: FatigueLevel = m.score === null ? 'none' : levelOf(m.score, f.levels);
    const floor: FatigueLevel = x.floor === 'severe' ? 'severe' : x.floor === 'drowsy' ? 'drowsy' : 'none';
    if (LEVEL_RANK[floor] > LEVEL_RANK[level]) level = floor;
    const out: FatigueMinute = { ...m, level, actions: actions.onMinute(nowMs, level) };
    stats.minutes++;
    if (out.status === 'scored') stats.scoredMinutes++;
    if (out.reason !== null) stats.degradedMinutes[out.reason]++;
    if (out.perclosDropped) stats.perclosDroppedMinutes++;
    for (const r of out.sparse) stats.sparseRowMinutes[r]++;
    timeline.push(out);
    return out;
  }

  return {
    /** Feeds one frame; returns the minute closed at it, if any. */
    onFrame(x: FatigueFrame): FatigueMinute | null {
      // A frame gap is unobserved time (T12 review I1): it counts 0, not a capped second.
      const dt = x.dtS > cfg.closure.maxFrameGapS ? 0 : Math.max(0, x.dtS);
      const k = Math.floor(x.tMs / 1000);
      if (cur === null || cur.k !== k) {
        if (cur !== null) seconds.push(cur);
        cur = newSecond(k);
        seconds.dropWhile((s) => s.k <= k - maxWindowS - 1);
      }
      const trk = tracked(x);
      const closed = trk && closedFrame(x);
      cur.frames++;
      cur.fpsSum += x.fps;
      cur.hot ||= x.hot;
      if (trk) {
        cur.trackS += dt;
        if (closed) cur.closedS += dt;
      }
      const g = trk ? x.gazeRel : null;
      const onNet = x.gazeFrom === 'net';
      if (g !== null) addGaze(onNet ? cur.net : cur, g);
      // Learning.
      atSpeed = x.speedKmh !== null && x.speedKmh >= f.minSpeedKmh;
      if (!active && atSpeed) {
        base.drivingS += dt;
        if (trk) {
          base.trackS += dt;
          if (closed) base.closedS += dt;
        }
        if (g !== null) addGaze(onNet ? base.net : base, g);
        if (base.drivingS >= f.activeAfterS - 1e-6 && base.trackS >= f.minTrackingShare * f.activeAfterS - 1e-6) active = true;
      }
      nextMinute ??= x.tMs + f.everyS * 1000;
      if (x.tMs < nextMinute - 1e-6) return null;
      nextMinute += f.everyS * 1000;
      return closeMinute(x.tMs, x);
    },
    /** A finished blink (fastRules); only counted blinks (fps ≥ blinkMinFps) enter the statistics. */
    onBlink(b: { tMs: number; durMs: number; long: boolean; counted: boolean }): void {
      if (!b.counted) return;
      blinks.push({ t: b.tMs, durMs: b.durMs, long: b.long });
      if (!active && atSpeed) {
        base.blinkN++;
        base.blinkDurMs += b.durMs;
        if (b.long) base.longBlinks++;
      }
    },
    onNod(tMs: number): void {
      nods.push(tMs);
      if (!active && atSpeed) base.nods++;
    },
    onYawn(tMs: number): void {
      yawns.push(tMs);
      if (!active && atSpeed) base.yawns++;
    },
    active: () => active,
    stats(): FatigueStats {
      return { ...stats, degradedMinutes: { ...stats.degradedMinutes }, sparseRowMinutes: { ...stats.sparseRowMinutes }, timeline: timeline.toArray() };
    },
  };
}

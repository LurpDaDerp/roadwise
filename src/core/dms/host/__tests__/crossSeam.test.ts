// The cross-seam table (plan Task 15; reviewer class "display gate vs action gate"): the capture policy's
// gazeNet, the native records' NET_RAN flag and the engine's gaze source must agree at every seam.
//
//   policy gazeNet off  ⇔  no record carries NET_RAN  ⇔  the engine's gaze comes from the geometric path
//   (or the head), never the net.
//
// The chain is run for real on each frame: policy.next → nativePolicy → a simulated native (the net runs
// only when the policy asks, the build has it, and on every gazeNetEvery-th frame) → the wire encoding →
// decodeFrameBatch → engineFrame → engine.pushFrame → engine.snapshot().
import { FLAG, THERMAL_FLOOR, type ThermalName } from '../../../../../modules/dms-vision/src/constants';
import { buildFrameBatch, decodeFrameBatch, recordFromFeatures } from '../../../../../modules/dms-vision/src/wire';
import { resolveDmsConfig } from '../../engine/config';
import { createDmsEngine } from '../../engine/engine';
import type { EngineFrame } from '../../engine/types';
import { frame } from '../../engine/__fixtures__/synth';
import { createCapturePolicy, nativePolicy, STATE_TABLE, type PolicyInput } from '../../policy/capture';
import { createGate, type DmsGate } from '../../policy/gate';
import { onRoad, synthDrive, type DriverFn } from '../../replay/synth';
import { featuresFromFrame } from '../__fixtures__/records';
import { engineFrame } from '../frames';

const GATE: DmsGate = { optedIn: true, cameraBeta: true, ageBand: '18_plus', driveActive: true, mode: 'mounted', role: 'driver', appActive: true };
const r = createGate(() => 'cross-seam').gateOpen(GATE, 'granted');
if (!r.open) throw new Error('the gate must open');
const TOKEN = r.token;

interface Seg {
  untilS: number;
  speedKmh: number;
  thermal: ThermalName;
}
interface Tick {
  t: number;
  policyNet: boolean;
  netRan: boolean;
  engineNet: boolean;
  source: string | null;
  gazeFrom: string | null;
}

/** One drive through every seam. */
function chain(o: { cfgSource: 'geometric' | 'net'; netAvailable: boolean; gazeNetEvery: 1 | 2; segs: Seg[]; netFallback?: boolean }): Tick[] {
  const seconds = o.segs.at(-1)!.untilS;
  const seg = (t: number) => o.segs.find((s) => t < s.untilS) ?? o.segs.at(-1)!;
  const driver: DriverFn = (t, rr) => ({ gaze: onRoad(rr), speedKmh: seg(t).speedKmh });
  const items = synthDrive({ fps: 15, seconds, seed: 31, source: 'net', driver });
  const engine = createDmsEngine(resolveDmsConfig({ gazeSource: o.cfgSource, gazeNetEvery: o.gazeNetEvery, ...(o.netFallback === undefined ? {} : { gaze: { netFallback: o.netFallback } }) }), { driverSide: 'left', sensitivity: 'normal', alerts: 'shadow', profile: null });
  const policy = createCapturePolicy();
  let np: ReturnType<typeof nativePolicy> = null;
  let quality: PolicyInput['quality'] = null;
  let qualitySince = 0;
  let delivered = 0;
  let prevTMs: number | null = null;
  const ticks: Tick[] = [];
  for (const it of items) {
    const tMs = it.frame.tMs;
    if (it.row) {
      engine.pushRow(it.row.row, it.row.ex, tMs);
      const out = policy.next({
        tMs,
        gateOpen: true,
        row: { tMs, speedKmh: seg(tMs / 1000).speedKmh, imuMoving: true, handling: false },
        quality,
        qualityForMs: quality === null ? 0 : tMs - qualitySince,
        thermal: seg(tMs / 1000).thermal,
        lowPower: false,
        batteryLevel: 80,
        charging: false,
        setup: false,
        lostLowLight: false,
        gazeNetEvery: o.gazeNetEvery,
      });
      np = nativePolicy(out, TOKEN);
      expect(np?.gazeNet ?? false).toBe(out.gazeNet);
    }
    if (np === null || np.capture === 'pause') continue;
    // The simulated native: the net runs only when asked, in a build that has it, every gazeNetEvery-th frame.
    const netRuns = o.netAvailable && np.gazeNet && delivered % np.gazeNetEvery === 0;
    delivered++;
    const f: EngineFrame = netRuns ? it.frame : { ...it.frame, net: null };
    const res = decodeFrameBatch(buildFrameBatch([recordFromFeatures(featuresFromFrame(f))], tMs), prevTMs);
    expect(res.batch).not.toBeNull();
    prevTMs = res.lastTMs;
    const rec = res.batch!.frames[0]!;
    const ef = engineFrame(rec, 0);
    engine.pushFrame(ef);
    const snap = engine.snapshot();
    if (snap.quality !== quality) {
      quality = snap.quality;
      qualitySince = tMs;
    }
    ticks.push({ t: tMs, policyNet: np.gazeNet, netRan: (rec.flags & FLAG.NET_RAN) !== 0, engineNet: ef.net !== null, source: snap.source, gazeFrom: snap.gazeFrom });
  }
  return ticks;
}

// 0–100 s FULL (calibration); 100–130 s at 10 km/h (CLOSURE_WATCH: no net); 130–160 s FULL again;
// 160–190 s thermal `serious` (L2: no net, at once).
const SEGS: Seg[] = [
  { untilS: 100, speedKmh: 60, thermal: 'nominal' },
  { untilS: 130, speedKmh: 10, thermal: 'nominal' },
  { untilS: 160, speedKmh: 60, thermal: 'nominal' },
  { untilS: 190, speedKmh: 60, thermal: 'serious' },
];
/** Frames with the gaze in use, at least 1 s after the last net value (beyond any hold). */
function sinceNet(ticks: Tick[]): (Tick & { sinceNetMs: number })[] {
  let lastNet = Number.NEGATIVE_INFINITY;
  return ticks.map((x) => {
    if (x.netRan) lastNet = x.t;
    return { ...x, sinceNetMs: x.t - lastNet };
  });
}

describe('policy gazeNet ⇔ NET_RAN ⇔ the engine’s gaze source (a net build, the net configured)', () => {
  const ticks = chain({ cfgSource: 'net', netAvailable: true, gazeNetEvery: 1, segs: SEGS });
  test('every segment ran: net on and net off, with frames in both', () => {
    expect(ticks.some((x) => x.policyNet)).toBe(true);
    expect(ticks.some((x) => !x.policyNet)).toBe(true);
  });
  test('a record carries NET_RAN exactly when the policy asked for the net (gazeNetEvery 1)', () => {
    expect(ticks.filter((x) => x.netRan !== x.policyNet)).toEqual([]);
  });
  test('the engine frame has a net value exactly when the record carries NET_RAN', () => {
    expect(ticks.filter((x) => x.engineNet !== x.netRan)).toEqual([]);
  });
  test('with the net off, the gaze in use is the geometric path (or the head): never the net', () => {
    const off = sinceNet(ticks).filter((x) => x.sinceNetMs >= 1000 && x.source === 'gaze');
    expect(off.length).toBeGreaterThan(300);
    expect(off.filter((x) => x.gazeFrom !== 'geometric')).toEqual([]);
  });
  test('with the net on, the gaze in use is the net', () => {
    const on = ticks.filter((x) => x.netRan && x.source === 'gaze' && x.t > 100_000);
    expect(on.length).toBeGreaterThan(300);
    expect(on.filter((x) => x.gazeFrom !== 'net')).toEqual([]);
  });
});

describe('the other producer values', () => {
  test('gazeNetEvery 2: NET_RAN on every other delivered frame only while the policy asks', () => {
    const ticks = chain({ cfgSource: 'net', netAvailable: true, gazeNetEvery: 2, segs: SEGS });
    expect(ticks.filter((x) => x.netRan && !x.policyNet)).toEqual([]);
    const onRuns = ticks.filter((x) => x.policyNet);
    const ran = onRuns.filter((x) => x.netRan).length;
    expect(ran / onRuns.length).toBeCloseTo(0.5, 1);
  });
  test('a build without the net (preview/production): never NET_RAN, never the net', () => {
    const ticks = chain({ cfgSource: 'net', netAvailable: false, gazeNetEvery: 1, segs: SEGS });
    expect(ticks.some((x) => x.netRan || x.engineNet)).toBe(false);
    expect(ticks.some((x) => x.gazeFrom === 'net')).toBe(false);
  });
  test('the geometric configuration never uses the net, even when frames carry it', () => {
    const ticks = chain({ cfgSource: 'geometric', netAvailable: true, gazeNetEvery: 1, segs: SEGS });
    expect(ticks.some((x) => x.netRan)).toBe(true);
    expect(ticks.some((x) => x.gazeFrom === 'net')).toBe(false);
    expect(ticks.filter((x) => x.source === 'gaze').every((x) => x.gazeFrom === 'geometric')).toBe(true);
  });
});

describe('T16 r3 m3: gaze.netFallback false (the pure-net shadow engine)', () => {
  test('with the net off it uses the head, never the geometric path; with the net on, the net', () => {
    const ticks = chain({ cfgSource: 'net', netAvailable: true, gazeNetEvery: 1, segs: SEGS, netFallback: false });
    expect(ticks.some((x) => x.gazeFrom === 'geometric')).toBe(false);
    expect(ticks.some((x) => x.gazeFrom === 'net')).toBe(true);
    expect(sinceNet(ticks).some((x) => x.sinceNetMs >= 1000 && x.source === 'head')).toBe(true);
  });
});

describe('the policy table and the wire table', () => {
  test('out.gazeNet = the state’s gazeNet ∧ the thermal floor’s gazeNet, and never while paused or off (a 4000-step random walk)', () => {
    const policy = createCapturePolicy();
    let seed = 7;
    const rnd = () => ((seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648);
    const pick = <T,>(xs: readonly T[]) => xs[Math.floor(rnd() * xs.length)]!;
    const seen = new Set<string>();
    // A sticky walk: each input changes with a small chance per step, so states have time to be reached.
    const cur = {
      gateOpen: true,
      speedKmh: 60 as number | null,
      imuMoving: true,
      handling: false,
      q: 'tracking' as PolicyInput['quality'],
      qSince: 0,
      thermal: 'nominal' as ThermalName,
      lowPower: false,
      batteryLevel: 80 as number | null,
      charging: false as boolean | null,
      setup: false,
      lostLowLight: false,
      gazeNetEvery: 1 as 1 | 2,
    };
    const maybe = (p: number) => rnd() < p;
    for (let i = 0; i < 4000; i++) {
      const tMs = i * 500;
      if (maybe(0.01)) cur.gateOpen = !cur.gateOpen;
      if (maybe(0.03)) cur.speedKmh = pick([null, 0, 5, 15, 30, 60, 100]);
      if (maybe(0.02)) cur.imuMoving = !cur.imuMoving;
      if (maybe(0.01)) cur.handling = !cur.handling;
      if (maybe(0.03)) {
        cur.q = pick(['tracking', 'head_only', 'lost', null] as const);
        cur.qSince = tMs;
      }
      if (maybe(0.005)) cur.thermal = pick(['nominal', 'nominal', 'fair', 'serious', 'critical', 'unknown'] as const);
      if (maybe(0.01)) cur.lowPower = !cur.lowPower;
      if (maybe(0.01)) cur.batteryLevel = pick([null, 10, 80]);
      if (maybe(0.01)) cur.charging = pick([null, true, false]);
      if (maybe(0.005)) cur.setup = !cur.setup;
      if (maybe(0.01)) cur.lostLowLight = !cur.lostLowLight;
      if (maybe(0.01)) cur.gazeNetEvery = pick([1, 2] as const);
      const out = policy.next({
        tMs,
        gateOpen: cur.gateOpen,
        row: { tMs, speedKmh: cur.speedKmh, imuMoving: cur.imuMoving, handling: cur.handling },
        quality: cur.q,
        qualityForMs: tMs - cur.qSince,
        thermal: cur.thermal,
        lowPower: cur.lowPower,
        batteryLevel: cur.batteryLevel,
        charging: cur.charging,
        setup: cur.setup,
        lostLowLight: cur.lostLowLight,
        gazeNetEvery: cur.gazeNetEvery,
      });
      seen.add(out.state);
      expect(out.gazeNet).toBe(STATE_TABLE[out.state].gazeNet && THERMAL_FLOOR[out.thermalLevel]!.gazeNet);
      if (out.action !== 'run') expect(out.gazeNet).toBe(false);
      const p = nativePolicy(out, TOKEN);
      if (p !== null) expect(p.gazeNet).toBe(out.gazeNet);
    }
    expect([...seen].sort()).toEqual(expect.arrayContaining(['CLOSURE_WATCH', 'FULL', 'HEAD_ONLY_RUN', 'OFF', 'PAUSED', 'SEARCH', 'SETUP']));
  });
  test.each([
    ['NET_RAN with a net value: accepted, the engine frame has it', true, true, 'net'],
    ['no NET_RAN and no net value: accepted, the engine frame has none', false, false, 'none'],
    ['NET_RAN without a net value: the record is dropped', true, false, 'dropped'],
    ['a net value without NET_RAN: the record is dropped', false, true, 'dropped'],
  ])('%s', (_n, flag, value, expected) => {
    const f = featuresFromFrame(frame({ tMs: 1000, net: { yaw: 4, pitch: -2 } }));
    const g = { ...f, flags: flag ? f.flags | FLAG.NET_RAN : f.flags & ~FLAG.NET_RAN, netYaw: value ? 4 : null, netPitch: value ? -2 : null };
    const res = decodeFrameBatch(buildFrameBatch([recordFromFeatures(g)], 1000));
    if (expected === 'dropped') {
      expect(res.batch === null || res.batch.frames.length === 0).toBe(true);
      return;
    }
    const ef = engineFrame(res.batch!.frames[0]!, 0);
    expect(ef.net === null ? 'none' : 'net').toBe(expected);
  });
});

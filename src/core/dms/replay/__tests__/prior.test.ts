// C6 round 1 (review-C6 C6-2): the deep-only population-prior fallback. Before any EAR reference exists (a drive
// that has not yet moved at the admission speed: a queue, a first stop), closure runs on absolute EARs: closed below
// closure.prior.closedEar (0.06), open above prior.openEar (0.12) or back above the closed EAR for prior.reopenMs;
// C6 round 2 (review-C6 R1-P): F1–F3 count deep time only (a continuous run below prior.deepEar, 0.045), latched or
// not, F1 at 1.5 s: before any pitch reference the looking-down gate cannot be measured. It feeds no fatigue statistic and no
// calibration, the HUD shows drowsiness as limited, and it is replaced as soon as a reference exists.
// Negative controls: NC-C6-P1 (no prior mode: S-FIRST-CRAWL and S-FIRST-STOPPED fail), NC-C6-P2 (a closed EAR of
// 0.15: S-PRIOR-READ fails; also pinned below as a config-level control), NC-C6-R (no prior.reopenMs: the squint
// that moves off never gets a reference) and NC-C6-P3 (prior closures count closed time: S-PRIOR-READ-45 fails).
import { DEFAULT_DMS_CONFIG, validateDmsConfig, type DmsConfig } from '../../engine/config';
import type { DmsAlertCommand } from '../../engine/alerts';
import { createDmsEngine, type DmsEvent } from '../../engine/engine';
import { DEFAULT_INIT } from '../run';
import { blinkOpenness, onRoad, rel, synthDrive, type DriverFn, type DriverState } from '../synth';

const C = DEFAULT_DMS_CONFIG as DmsConfig;

interface Run {
  events: DmsEvent[];
  commands: DmsAlertCommand[];
  seconds: { tMs: number; earRef: number | null; priorMode: boolean; closedMs: number }[];
}

function play(driver: DriverFn, seconds: number, o: { cfg?: DmsConfig; lidGaze?: boolean; seed?: number } = {}): Run {
  const items = synthDrive({ fps: 15, seconds, seed: o.seed ?? 31, source: 'geometric', driver, motion: true, lidGaze: o.lidGaze });
  const engine = createDmsEngine(o.cfg ?? C, { ...DEFAULT_INIT, profile: null });
  const run: Run = { events: [], commands: [], seconds: [] };
  let next = 0;
  for (const it of items) {
    if (it.row !== undefined) engine.pushRow(it.row.row, it.row.ex, it.frame.tMs);
    engine.pushFrame(it.frame);
    const out = engine.drain();
    run.events.push(...out.events);
    run.commands.push(...out.commands);
    if (it.frame.tMs >= next) {
      next += 1000;
      const s = engine.snapshot();
      run.seconds.push({ tMs: it.frame.tMs, earRef: s.earRef, priorMode: s.priorMode, closedMs: s.closedMs });
    }
  }
  return run;
}

const kinds = (r: Run, k: string) => r.events.filter((e) => e.kind === k);
const sleepFamily = (r: Run) => r.events.filter((e) => e.kind === 'microsleep' || e.kind === 'sleep' || e.kind === 'unresponsive' || e.kind === 'microsleep_nod');
const criticals = (r: Run) => r.commands.filter((c) => c.tier === 3 && c.action === 'start');

/** A driver with blinks, at `speedKmh`, the open EAR 0.3 × `scale`; eyes shut (EAR `shutEar`) over [from, to). */
function driver(speedKmh: number, o: { scale?: number; shut?: [number, number]; shutEar?: number; over?: (t: number) => Partial<DriverState> | null } = {}): DriverFn {
  const scale = o.scale ?? 1;
  return (t, r) => {
    const shut = o.shut !== undefined && t >= o.shut[0] && t < o.shut[1];
    const base: DriverState = { gaze: onRoad(r), speedKmh, earScale: scale, openness: shut ? (o.shutEar ?? 0.03) / (0.3 * scale) : blinkOpenness(t) };
    const x = o.over?.(t) ?? null;
    return x === null ? base : { ...base, ...x };
  };
}

describe('C6-2: sleep before any reference (S-FIRST-CRAWL, S-FIRST-STOPPED; NC-C6-P1)', () => {
  test('S-FIRST-CRAWL: a 7 km/h queue for 5 min from the start, the eyes shut 3.5 s at 2 min: F1 at 1.5 s, F2 at 3 s, on the prior', () => {
    const r = play(driver(7, { shut: [120, 123.5] }), 300);
    expect(r.seconds.every((s) => s.earRef === null && s.priorMode)).toBe(true);
    const f1 = kinds(r, 'microsleep');
    const f2 = kinds(r, 'sleep');
    expect(f1).toHaveLength(1);
    expect(f2).toHaveLength(1);
    expect(f1[0]!.tMs).toBeGreaterThanOrEqual(121_400);
    expect(f1[0]!.tMs).toBeLessThanOrEqual(121_700);
    expect(f2[0]!.tMs).toBeLessThanOrEqual(123_200);
    // nothing but the closure: the blinks (EAR 0.03 for 200 ms) are no F event
    expect(sleepFamily(r).filter((e) => e.tMs < 120_000 || e.tMs > 124_000)).toEqual([]);
  });
  test('S-FIRST-STOPPED: 0 km/h from the start, the eyes shut 3.5 s at 2 min: F2', () => {
    const r = play(driver(0, { shut: [120, 123.5] }), 130);
    expect(r.seconds.every((s) => s.earRef === null && s.priorMode)).toBe(true);
    expect(kinds(r, 'sleep')).toHaveLength(1);
    expect(sleepFamily(r).filter((e) => e.tMs < 120_000)).toEqual([]);
  });
  test('the prior feeds no fatigue statistic: no blink event before the reference, blinks once it exists', () => {
    const r = play(driver(0, { over: (t) => (t >= 120 ? { speedKmh: 60 } : null) }), 240);
    const refAt = r.seconds.find((s) => s.earRef !== null)!.tMs;
    expect(refAt).toBeGreaterThan(120_000);
    expect(kinds(r, 'blink').filter((e) => e.tMs < refAt - 1000)).toEqual([]);
    expect(kinds(r, 'blink').filter((e) => e.tMs > refAt + 1000).length).toBeGreaterThan(10);
  });
  test('replaced as soon as a reference exists: priorMode off from the first second with a reference', () => {
    const r = play(driver(0, { over: (t) => (t >= 60 ? { speedKmh: 60 } : null) }), 150);
    expect(r.seconds.some((s) => s.earRef !== null)).toBe(true);
    for (const s of r.seconds) expect(s.priorMode).toBe(s.earRef === null);
  });
});

describe('C6-2: no false Critical on the prior (S-PRIOR-READ, squint; NC-C6-P2)', () => {
  /** A lap phone at −40° with the lid following the gaze (EAR ≈ 0.075, between the closed and the open EAR), stopped. */
  const reader = driver(0, { over: () => ({ gaze: rel(0, -40), head: { yaw: 0.4, pitch: -1.2 - 20 } }) });
  test('S-PRIOR-READ: 10 min reading a lap phone at a stop from the start (lid coupled): 0 sleep Criticals', () => {
    const r = play(reader, 600, { lidGaze: true });
    expect(r.seconds.every((s) => s.priorMode)).toBe(true);
    expect(sleepFamily(r)).toEqual([]);
    expect(criticals(r)).toEqual([]);
  });
  // C6 round 2 (R1-P): prior closures count deep time only, so the control raises the deep EAR with the closed one.
  test('NC-C6-P2 (config level): with a closed EAR of 0.15 (deep 0.1) the same reading raises sleep Criticals', () => {
    const cfg = JSON.parse(JSON.stringify(C)) as DmsConfig;
    cfg.closure.prior = { ...cfg.closure.prior, closedEar: 0.15, openEar: 0.18, deepEar: 0.1 };
    expect(validateDmsConfig(cfg)).toEqual([]);
    const r = play(reader, 120, { lidGaze: true, cfg });
    expect(criticals(r).length).toBeGreaterThan(0);
  });
  test('S-PRIOR-SQUINT: an open EAR of 0.11 for 5 min in a queue (blinks): 0 sleep events, the eyes read open between blinks', () => {
    const r = play(driver(7, { scale: 0.11 / 0.3 }), 300);
    expect(sleepFamily(r)).toEqual([]);
  });
  test('S-PRIOR-SQUINT then moving (NC-C6-R): a low open eye is not held closed after a blink; the reference is derived', () => {
    // An open EAR of 0.11 sits between the prior's closed (0.06) and open (0.12) EAR: without prior.reopenMs the first
    // blink would leave the eye "closed" until the reference exists, which holds the baseline collectors, sets the
    // fatigue gate (a closure ≥ 500 ms) and reads every gaze as off the road.
    const r = play(driver(7, { scale: 0.11 / 0.3, over: (t) => (t >= 60 ? { speedKmh: 60 } : null) }), 150);
    expect(Math.max(...r.seconds.map((s) => s.closedMs))).toBeLessThanOrEqual(1000);
    const got = r.seconds.find((s) => s.earRef !== null);
    expect(got).toBeDefined();
    expect(got!.tMs).toBeLessThanOrEqual(120_000);
    expect(Math.abs(got!.earRef! / 0.11 - 1)).toBeLessThanOrEqual(0.05);
    expect(sleepFamily(r)).toEqual([]);
  });
});

describe('C6-2: eye sizes (S-PRIOR-SMALL, S-PRIOR-LARGE)', () => {
  for (const [name, openEar] of [
    ['S-PRIOR-SMALL', 0.2],
    ['S-PRIOR-LARGE', 0.35],
  ] as const) {
    test(`${name}: an open EAR of ${openEar}, 3 min of blinks, then a closure to 0.04 for 3.5 s: F2, and nothing before`, () => {
      const scale = openEar / 0.3;
      const r = play(driver(7, { scale, shut: [180, 183.5], shutEar: 0.04 }), 190);
      expect(sleepFamily(r).filter((e) => e.tMs < 180_000)).toEqual([]);
      expect(kinds(r, 'sleep')).toHaveLength(1);
    });
  }
});

describe('C6 round 2 (review-C6 R1-P): prior-mode closures count deep time only (NC-C6-P3)', () => {
  /** Stopped from the start, no reference: 8 s bouts reading a lap phone at `pitch`, 2 s looking up, the lid coupled. */
  const steepReader = (pitch: number) => driver(0, { over: (t) => (t >= 5 && (t - 5) % 10 < 8 ? { gaze: rel(0, pitch) } : null) });
  test.each([-45, -50])('S-PRIOR-READ%i: 3 min of 8 s bouts at a stop, the lid at its floor (EAR ≈ 0.051, between the deep and the closed EAR): 0 sleep events', (pitch) => {
    const r = play(steepReader(pitch), 185, { lidGaze: true });
    expect(r.seconds.every((s) => s.priorMode)).toBe(true);
    // the reading lid is a prior closure (EAR < 0.06) most of every bout: the rule under test is reached
    expect(r.seconds.filter((s) => s.closedMs > 1500).length).toBeGreaterThan(60);
    expect(sleepFamily(r)).toEqual([]);
    expect(criticals(r)).toEqual([]);
  });
  /** Stopped, no reference: cycles of `shutS` at EAR 0.03, then 1.0 s at EAR 0.09 (above the closed EAR). */
  const flutter = (shutS: number) => (t: number, r: () => number): DriverState => {
    const k = (t - 10) % (shutS + 1);
    const openness = t < 10 ? blinkOpenness(t) : k < shutS ? 0.03 / 0.3 : 0.09 / 0.3;
    return { gaze: onRoad(r), speedKmh: 0, openness };
  };
  // The boundary is F1's 1.5 s of deep time (15 fps: 1.53 s); 1.7 s and 1.3 s keep the frame phase off it.
  test('S-PRIOR-FLUTTER (reopenMs pinned): 1.7 s shut, 1.0 s at EAR 0.09: F1 on every cycle, never F2 (the flutter ends the closure)', () => {
    const r = play(flutter(1.7), 10 + 2.7 * 20 + 1);
    expect(kinds(r, 'microsleep')).toHaveLength(20);
    expect(kinds(r, 'sleep')).toEqual([]);
  });
  test('S-PRIOR-FLUTTER: 1.3 s shut, 1.0 s at EAR 0.09: no F1 (the deep run is under 1.5 s; the reopen tail is not deep)', () => {
    const r = play(flutter(1.3), 10 + 2.3 * 20 + 1);
    expect(sleepFamily(r)).toEqual([]);
  });
});


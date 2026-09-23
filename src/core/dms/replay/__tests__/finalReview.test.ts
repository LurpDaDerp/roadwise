// The final whole-DMS review, engine half (final-review-engine.md): each finding's failing scenario, run
// through the façade. I1 bridges frozen by a camera stop; I2 the blind cap armed by the absence of frames;
// I3 (U-23) the lost cap; I4 an O(1) snapshot; I5 camera-off time in the summary; m3 what zones and
// dispersion learn from; m5 D4 after a gate close; m6 one minute per frame after a pause.
import { DEFAULT_DMS_CONFIG, type DmsConfig } from '../../engine/config';
import { createDmsEngine, learnableGaze, type DmsEngine } from '../../engine/engine';
import type { EngineFrame } from '../../engine/types';
import { frame } from '../../engine/__fixtures__/synth';
import { DEFAULT_INIT } from '../run';
import { onRoad, rel, synthDrive, type DriverFn, type SynthItem } from '../synth';

declare const __dirname: string;
// eslint-disable-next-line @typescript-eslint/no-require-imports -- the root tsconfig has no Node types
const fs = require('node:fs') as { readFileSync: (f: string, e: 'utf8') => string };
// eslint-disable-next-line @typescript-eslint/no-require-imports -- ditto
const path = require('node:path') as { join: (...p: string[]) => string };

const C = DEFAULT_DMS_CONFIG as DmsConfig;

interface Out {
  cmds: { action: string; kind: string; tMs: number; tier: number; cause?: string }[];
  events: { kind: string; tMs: number; durMs?: number }[];
}
function collect(engine: DmsEngine, out: Out) {
  const d = engine.drain();
  out.cmds.push(...d.commands);
  out.events.push(...d.events);
}
/** Items through the engine; `frameAt` may replace or drop (null) a frame; rows always go through. */
function feed(engine: DmsEngine, items: readonly SynthItem[], out: Out, frameAt: (f: EngineFrame) => EngineFrame | null = (f) => f) {
  for (const it of items) {
    if (it.row) engine.pushRow(it.row.row, it.row.ex, it.frame.tMs);
    const f = frameAt(it.frame);
    if (f !== null) engine.pushFrame(f);
    collect(engine, out);
  }
}
const newOut = (): Out => ({ cmds: [], events: [] });
/** Eyes shut from 100 s at 60 km/h (F1 at 101 s, F2 at 103 s). */
const asleepAt100: DriverFn = (t, r) => ({ gaze: onRoad(r), openness: t >= 100 ? 0.1 : 1, speedKmh: 60 });

describe('I1: a C-26 bridge frozen by a camera stop never turns the stop into closure', () => {
  // The eyes shut at 99.3 s (F1 at 100.3 s), the head drops from 100 s; the face is lost at 100.8 s (the bridge); frames stop at
  // 101.5 s for 60 s (rows continue at 60 km/h); the first frame back is TRACKING with the eyes closed (a
  // blink), open again 0.2 s later.
  const noddingOff: DriverFn = (t, r) => {
    if (t < 99.3) return { gaze: onRoad(r), speedKmh: 60 };
    if (t < 100) return { gaze: onRoad(r), openness: 0.1, speedKmh: 60 }; // F1 at 100.3 s, head level
    if (t < 100.8) {
      const pitch = -30 * Math.min(1, (t - 100) / 0.6);
      return { gaze: rel(0, pitch), head: { yaw: 0.8, pitch: -1.2 + pitch }, openness: 0.1, speedKmh: 60 };
    }
    if (t < 101.5) return { gaze: onRoad(r), face: false, speedKmh: 60 };
    if (t < 161.53) return { gaze: onRoad(r), speedKmh: 60 };
    return { gaze: onRoad(r), openness: t < 161.73 ? 0.1 : 1, speedKmh: 60 };
  };
  const run = () => {
    const engine = createDmsEngine(C, DEFAULT_INIT);
    const out = newOut();
    const items = synthDrive({ fps: 15, seconds: 170, seed: 11, source: 'geometric', driver: noddingOff });
    feed(engine, items, out, (f) => (f.tMs >= 101_500 && f.tMs < 161_530 ? null : f));
    return out;
  };
  test('the bridge ran (the scenario is the reviewer’s)', () => {
    const out = run();
    expect(out.events.some((e) => (e.kind === 'microsleep' || e.kind === 'sleep') && e.tMs < 101_600)).toBe(true);
  });
  test('the first frames back raise no F event, no long blink and no long episode', () => {
    const out = run();
    const after = out.events.filter((e) => e.tMs >= 161_500);
    expect(after.filter((e) => ['microsleep', 'sleep', 'unresponsive'].includes(e.kind))).toEqual([]);
    expect(after.filter((e) => e.kind === 'blink' && (e.durMs ?? 0) >= 1000)).toEqual([]);
    expect(out.events.filter((e) => e.kind === 'episode_end' && (e.durMs ?? 0) > 12_000)).toEqual([]);
    expect(out.cmds.filter((c) => c.action === 'start' && c.tMs >= 161_500)).toEqual([]);
  });
});

describe('I2: the blind cap is armed by the absence of frames, not by the cameraOff call', () => {
  const sleepThenOff = (o: { cameraOff: boolean; inFlight: boolean }) => {
    const engine = createDmsEngine(C, DEFAULT_INIT);
    const out = newOut();
    const items = synthDrive({ fps: 15, seconds: 104.2, seed: 14, source: 'geometric', driver: asleepAt100 });
    const cut = 104_000;
    feed(engine, items.filter((it) => it.frame.tMs <= cut), out);
    const last = items.filter((it) => it.frame.tMs <= cut).at(-1)!;
    const lastRow = [...items].reverse().find((i) => i.row !== undefined)!.row!;
    let lastFrameT = last.frame.tMs;
    if (o.cameraOff) engine.cameraOff(lastFrameT, 'dark');
    if (o.inFlight) {
      const f = items.find((it) => it.frame.tMs > cut)!.frame; // captured before native stopped
      engine.pushFrame(f);
      lastFrameT = f.tMs;
    }
    collect(engine, out);
    for (let k = 1; k <= 300; k++) {
      const tMs = cut + k * 1000;
      engine.pushRow({ ...lastRow.row, ts: lastRow.row.ts + (tMs - 104_000) }, { ...lastRow.ex, tripElapsedS: tMs / 1000 }, tMs);
      collect(engine, out);
    }
    return { out, lastFrameT };
  };
  test('an in-flight frame after cameraOff: stop and one monitoring_paused (dark) about 60 s after the last frame', () => {
    const { out, lastFrameT } = sleepThenOff({ cameraOff: true, inFlight: true });
    const paused = out.cmds.filter((c) => c.kind === 'monitoring_paused');
    expect(paused.map((c) => c.cause)).toEqual(['dark']);
    expect(paused[0]!.tMs - lastFrameT).toBeGreaterThanOrEqual(60_000 - 1);
    expect(paused[0]!.tMs - lastFrameT).toBeLessThanOrEqual(61_000);
    // the Critical's stop comes with it
    expect(out.cmds.some((c) => c.action === 'stop' && c.tier === 3 && c.tMs === paused[0]!.tMs)).toBe(true);
  });
  test('frames just stop, with no cameraOff at all: the same, cause fault', () => {
    const { out } = sleepThenOff({ cameraOff: false, inFlight: false });
    expect(out.cmds.filter((c) => c.kind === 'monitoring_paused').map((c) => c.cause)).toEqual(['fault']);
  });
});

describe('I3 (U-23): a Critical with no TRACKING face is bounded by criticalLostMaxS', () => {
  const sleepThen = (after: (f: EngineFrame) => EngineFrame) => {
    const engine = createDmsEngine(C, DEFAULT_INIT);
    const out = newOut();
    const items = synthDrive({ fps: 15, seconds: 240, seed: 15, source: 'geometric', driver: asleepAt100 });
    feed(engine, items, out, (f) => (f.tMs < 104_000 ? f : after(f)));
    return out;
  };
  const lostCap = (out: Out) => ({
    // the Critical's end after the face went (earlier stops are one Critical replacing another)
    stop: out.cmds.find((c) => c.action === 'stop' && c.tier === 3 && c.tMs > 108_000),
    paused: out.cmds.filter((c) => c.kind === 'monitoring_paused'),
    last: out.cmds.filter((c) => c.tier === 3).at(-1),
  });
  test('knocked off the mount (LOST at speed): stop about 60 s after the last TRACKING frame, then monitoring_paused (face_lost)', () => {
    const r = lostCap(sleepThen((f) => frame({ tMs: f.tMs, face: false, frameLuma: 110 })));
    expect(r.stop).toBeDefined();
    expect(r.stop!.tMs).toBeGreaterThanOrEqual(164_000 - 70);
    expect(r.stop!.tMs).toBeLessThanOrEqual(165_100);
    expect(r.paused.map((c) => c.cause)).toEqual(['face_lost']);
  });
  test('slumped out of view (HEAD_ONLY at speed): the same', () => {
    const r = lostCap(sleepThen((f) => frame({ tMs: f.tMs, blur: 5 })));
    expect(r.stop).toBeDefined();
    expect(r.stop!.tMs).toBeLessThanOrEqual(165_100);
    expect(r.paused.map((c) => c.cause)).toEqual(['face_lost']);
  });
  test('negative control: asleep IN view (TRACKING, eyes shut) is never capped', () => {
    const r = lostCap(sleepThen((f) => f));
    expect(r.stop).toBeUndefined();
    expect(r.paused).toEqual([]);
    expect(r.last!.action).toBe('start'); // still sounding at the end
  });
  test('the face returning after the cap may raise a new Critical under the normal rules', () => {
    // Back at 170 s, eyes open for 1.5 s (the irises are seen again), then shut again: a new F1.
    const engine = createDmsEngine(C, DEFAULT_INIT);
    const out = newOut();
    const items = synthDrive({ fps: 15, seconds: 240, seed: 15, source: 'geometric', driver: (t, rr) => ({ gaze: onRoad(rr), openness: t >= 100 && !(t >= 170 && t < 171.5) ? 0.1 : 1, speedKmh: 60 }) });
    feed(engine, items, out, (f) => (f.tMs < 104_000 || f.tMs >= 170_000 ? f : frame({ tMs: f.tMs, face: false, frameLuma: 110 })));
    expect(out.cmds.filter((c) => c.kind === 'monitoring_paused').map((c) => c.cause)).toEqual(['face_lost']);
    const starts = out.cmds.filter((c) => c.action === 'start' && c.tMs > 170_000);
    expect(starts.length).toBeGreaterThanOrEqual(1);
  });
});

describe('I4: snapshot() is O(1) (the host and the shadow call it per frame)', () => {
  test('it never builds the alert stats', () => {
    const src = fs.readFileSync(path.join(__dirname, '..', '..', 'engine', 'engine.ts'), 'utf8');
    const body = src.slice(src.indexOf('    snapshot() {'), src.indexOf('    seedFromSetup() {'));
    expect(body).toContain('d.alerts.violations()');
    expect(body).not.toMatch(/\.stats\(\)/);
  });
  test('with a long alert log, 20 000 snapshots cost less than 2 000 log copies', () => {
    const engine = createDmsEngine(C, DEFAULT_INIT);
    const out = newOut();
    // Many would-be alerts: a 3.4 s centre-stack glance every 12 s for 40 min.
    const items = synthDrive({ fps: 15, seconds: 2400, seed: 3, source: 'geometric', driver: (t, r) => ({ gaze: t >= 100 && (t - 100) % 12 < 3.4 ? rel(30, -20) : onRoad(r), speedKmh: 60 }) });
    feed(engine, items, out);
    expect(engine.alertLog().length).toBeGreaterThanOrEqual(150);
    const t0 = performance.now();
    for (let i = 0; i < 20_000; i++) engine.snapshot();
    const snapMs = performance.now() - t0;
    const t1 = performance.now();
    for (let i = 0; i < 2_000; i++) engine.alertLog();
    const statsMs = performance.now() - t1;
    expect(snapMs).toBeLessThan(statsMs);
  });
});

describe('I5: camera-off time at speed reaches the summary', () => {
  test('10 min tracked, then 20 min at thermal L3 (camera off, rows at 60 km/h)', () => {
    const engine = createDmsEngine(C, DEFAULT_INIT);
    const out = newOut();
    const items = synthDrive({ fps: 15, seconds: 1800, seed: 17, source: 'geometric', driver: (t, r) => ({ gaze: onRoad(r), speedKmh: 60 }) });
    let off = false;
    for (const it of items) {
      if (!off && it.frame.tMs >= 600_000) {
        off = true;
        engine.setHost({ thermalLevel: 3 });
        engine.cameraOff(it.frame.tMs, 'heat');
      }
      if (it.row) engine.pushRow(it.row.row, it.row.ex, it.frame.tMs);
      if (!off) engine.pushFrame(it.frame);
      collect(engine, out);
    }
    const s = engine.summary();
    expect(s.thermalMinutes['3']).toBeGreaterThan(19.5);
    expect(s.thermalMinutes['3']).toBeLessThan(20.5);
    expect(s.cameraOffS.heat).toBeGreaterThan(1190);
    expect(s.trackingCoverage!).toBeGreaterThan(0.3);
    expect(s.trackingCoverage!).toBeLessThan(0.36);
    expect(s.cameraSession).toBe('limited');
  });
  test('a gate close counts as gate, a stall with no cause as stall', () => {
    const engine = createDmsEngine(C, DEFAULT_INIT);
    const out = newOut();
    const items = synthDrive({ fps: 15, seconds: 400, seed: 18, source: 'geometric', driver: (t, r) => ({ gaze: onRoad(r), speedKmh: 60 }) });
    for (const it of items) {
      const t = it.frame.tMs;
      if (t === items.find((x) => x.frame.tMs >= 200_000)!.frame.tMs) engine.stopAlerts(t);
      if (it.row) engine.pushRow(it.row.row, it.row.ex, t);
      if (t < 100_000 || (t >= 150_000 && t < 200_000)) engine.pushFrame(it.frame);
      collect(engine, out);
    }
    const s = engine.summary();
    expect(s.cameraOffS.stall).toBeGreaterThan(45);
    expect(s.cameraOffS.gate).toBeGreaterThan(195);
  });
});

describe('m3: zones and dispersion learn only from the configured gaze path', () => {
  test('learnableGaze: a gaze from the configured path; never a head, held or fallback direction', () => {
    const p = (source: string, gazeFrom: 'net' | 'geometric' | null) => ({ source, gazeFrom, gazeRel: { yaw: 1, pitch: 2 } }) as never;
    expect(learnableGaze(p('gaze', 'geometric'), 'geometric')).toEqual({ yaw: 1, pitch: 2 });
    expect(learnableGaze(p('gaze', 'net'), 'net')).toEqual({ yaw: 1, pitch: 2 });
    expect(learnableGaze(p('head', null), 'geometric')).toBeNull();
    expect(learnableGaze(p('held', null), 'geometric')).toBeNull();
    expect(learnableGaze(p('gaze', 'geometric'), 'net')).toBeNull();
  });
});

describe('m5: a gate close clears D4’s pending state and the escalation corroboration', () => {
  test('a D1 warning, the gate closes (no frames for 2 min), the driver comes back looking at the phone: no D4 on return', () => {
    const engine = createDmsEngine(C, DEFAULT_INIT);
    const out = newOut();
    const items = synthDrive({ fps: 15, seconds: 240, seed: 19, source: 'geometric', driver: (t, r) => ({ gaze: t >= 100 ? rel(0, -40) : onRoad(r), speedKmh: 60 }) });
    let closedAt: number | null = null;
    let resumeAt: number | null = null;
    for (const it of items) {
      const t = it.frame.tMs;
      if (it.row) engine.pushRow(it.row.row, it.row.ex, t);
      if (closedAt === null || t >= closedAt + 120_000) {
        if (closedAt !== null && resumeAt === null) resumeAt = t;
        engine.pushFrame(it.frame);
      }
      collect(engine, out);
      if (closedAt === null && out.cmds.some((c) => c.action === 'start' && c.kind === 'distraction')) {
        closedAt = t;
        engine.stopAlerts(t);
        collect(engine, out);
      }
    }
    expect(closedAt).not.toBeNull();
    expect(resumeAt).not.toBeNull();
    // D4 would fire about 3 s of observed off-road time after the return; a new D1 (and its own D4) takes longer.
    expect(out.cmds.filter((c) => c.kind === 'unresponsive' && c.action === 'start' && c.tMs < resumeAt! + 4_000)).toEqual([]);
  });
});

describe('m6: after a pause, at most one minute closes per frame', () => {
  test('frames to 300 s, none until 900 s, then frames again: one fatigue minute at the resume, then one a minute', () => {
    const engine = createDmsEngine(C, DEFAULT_INIT);
    const out = newOut();
    const items = synthDrive({ fps: 15, seconds: 1000, seed: 20, source: 'geometric', driver: (t, r) => ({ gaze: onRoad(r), speedKmh: 60 }) });
    feed(engine, items, out, (f) => (f.tMs > 300_000 && f.tMs < 900_000 ? null : f));
    const minutes = out.events.filter((e) => e.kind === 'fatigue_minute' && e.tMs >= 900_000).map((e) => e.tMs);
    for (let i = 1; i < minutes.length; i++) expect(minutes[i]! - minutes[i - 1]!).toBeGreaterThanOrEqual(59_000);
    const s = engine.summary();
    const tier0 = s.tier0.minutes.filter((m) => m.tMs >= 900_000).map((m) => m.tMs);
    for (let i = 1; i < tier0.length; i++) expect(tier0[i]! - tier0[i - 1]!).toBeGreaterThanOrEqual(59_000);
  });
});

describe('n2: the summary says how much of a net build’s gaze was the net', () => {
  test('a net configuration reports the share by path; a geometric one reports null', () => {
    const NET = { ...C, gazeSource: 'net' } as DmsConfig;
    const net = createDmsEngine(NET, DEFAULT_INIT);
    const geo = createDmsEngine(C, DEFAULT_INIT);
    const items = synthDrive({ fps: 15, seconds: 200, seed: 22, source: 'net', driver: (t, r) => ({ gaze: onRoad(r), speedKmh: 60 }) });
    const out = newOut();
    feed(net, items, out, (f) => (f.tMs > 150_000 ? { ...f, net: null } : f));
    feed(geo, items, newOut());
    const share = net.summary().gazeFromShare!;
    expect(share.net).toBeGreaterThan(0.5);
    expect(share.geometric).toBeGreaterThan(0.1);
    expect(geo.summary().gazeFromShare).toBeNull();
  });
});

describe('final review round 2 (I1 residual): a stop SHORTER than the bridge cap adds no closure time either', () => {
  // The re-review's probe: the eyes shut and the head drops at 100 s, the face is lost at 100.8 s (the bridge),
  // frames stop at 101.5 s for N s, and the first frame back is TRACKING with the eyes still shut (a blink),
  // open 0.2 s later. About 1.5 s of closure was observed or bridged: at most F1 (microsleep) is legitimate.
  const probe = (stopS: number, lostOnReturnS = 0) => {
    const back = 101.5 + stopS;
    const drv: DriverFn = (t, r) => {
      if (t < 100) return { gaze: onRoad(r), speedKmh: 60 };
      if (t < 100.8) {
        const pitch = -30 * Math.min(1, (t - 100) / 0.6);
        return { gaze: rel(0, pitch), head: { yaw: 0.8, pitch: -1.2 + pitch }, openness: 0.1, speedKmh: 60 };
      }
      if (t < 101.5 || (t >= back && t < back + lostOnReturnS)) return { gaze: onRoad(r), face: false, speedKmh: 60 };
      return { gaze: onRoad(r), openness: t < back + lostOnReturnS + 0.2 ? 0.1 : 1, speedKmh: 60 };
    };
    const engine = createDmsEngine(C, DEFAULT_INIT);
    const out = newOut();
    const items = synthDrive({ fps: 15, seconds: back + lostOnReturnS + 3, seed: 11, source: 'geometric', driver: drv });
    feed(engine, items, out, (f) => (f.tMs >= 101_500 && f.tMs < back * 1000 ? null : f));
    return { out, backMs: back * 1000 };
  };
  test.each([3, 5, 9])('a %d s stop: no sleep or unresponsive from the unobserved time (a microsleep may be legitimate)', (stopS) => {
    const { out, backMs } = probe(stopS);
    const after = out.events.filter((e) => e.tMs >= backMs - 1);
    expect(after.filter((e) => e.kind === 'sleep' || e.kind === 'unresponsive')).toEqual([]);
    expect(out.cmds.filter((c) => c.tMs >= backMs - 1 && c.action === 'start' && (c.kind === 'sleep' || c.kind === 'unresponsive'))).toEqual([]);
  });
  test.each([3, 5, 9])('a %d s stop, the face still lost for 0.3 s after it (a bridged gap frame): the episode’s measured length excludes the stop', (stopS) => {
    const { out } = probe(stopS, 0.3);
    const ends = out.events.filter((e) => e.kind === 'episode_end');
    for (const e of ends) expect(e.durMs!).toBeLessThan(3_000);
  });
});

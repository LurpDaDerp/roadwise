// Task C4 (design rev2 §2.3.2, rev4 §2.3.2a, rev5 §3, amendments W1–W3): posture, the dual-centre state and
// probation; a stop as a gap; a driver change and a knocked mount across a stop. Every drive runs through the
// engine façade with motion evidence and the face geometry (the box follows the head, the IOD is projected).
import { angularDistanceDeg } from '../../engine/angles';
import { DEFAULT_DMS_CONFIG, type DmsConfig } from '../../engine/config';
import { createDmsEngine, type DmsEvent, type DmsSnapshot } from '../../engine/engine';
import type { DmsAlertCommand } from '../../engine/alerts';
import type { AnglePair } from '../../engine/types';
import { DEFAULT_INIT } from '../run';
import { blinkOpenness, onRoad, rel, synthDrive, type DriverFn, type DriverState } from '../synth';

const C = DEFAULT_DMS_CONFIG as DmsConfig;

/** Attentive at 60 km/h on a straight road, natural blinks, with `over` on top. */
function drv(over: (t: number, r: () => number) => Partial<DriverState> | null): DriverFn {
  return (t, r) => {
    const base: DriverState = { gaze: onRoad(r), openness: blinkOpenness(t), speedKmh: 60 };
    const o = over(t, r);
    return o === null ? base : { ...base, ...o };
  };
}

interface Run {
  events: DmsEvent[];
  commands: DmsAlertCommand[];
  /** a snapshot every frame (time, the primary centre, distraction, speed) */
  frames: { tMs: number; centre: AnglePair | null; head: AnglePair | null; distraction: DmsSnapshot['distraction']; speed: number | null; calReason: DmsSnapshot['calReason'] }[];
}

function play(driver: DriverFn, seconds: number, o: { fps?: number; source?: 'geometric' | 'net'; cfg?: DmsConfig; lidGaze?: boolean; seed?: number } = {}): Run {
  const source = o.source ?? 'geometric';
  const cfg = { ...(o.cfg ?? C), gazeSource: source } as DmsConfig;
  const items = synthDrive({ fps: o.fps ?? 15, seconds, seed: o.seed ?? 11, source, driver, motion: true, faceGeometry: true, lidGaze: o.lidGaze });
  const engine = createDmsEngine(cfg, DEFAULT_INIT);
  const run: Run = { events: [], commands: [], frames: [] };
  for (const it of items) {
    if (it.row !== undefined) engine.pushRow(it.row.row, it.row.ex, it.frame.tMs);
    engine.pushFrame(it.frame);
    const out = engine.drain();
    run.events.push(...out.events);
    run.commands.push(...out.commands);
    const s = engine.snapshot();
    run.frames.push({ tMs: it.frame.tMs, centre: s.centre.gaze, head: s.centre.head, distraction: s.distraction, speed: s.ruleSpeedKmh, calReason: s.calReason });
  }
  return run;
}

const ev = (r: Run, kind: string) => r.events.filter((e) => e.kind === kind) as (DmsEvent & { cause?: string; demoteMirrors?: boolean })[];
const centreAt = (r: Run, tMs: number) => [...r.frames].reverse().find((f) => f.tMs <= tMs)!;
const d1After = (r: Run, tMs: number) => r.commands.filter((c) => c.kind === 'distraction' && c.action === 'start' && c.tMs >= tMs);
const within = (t: number, a: number, b: number) => t >= a && t < b;
/** The driver-frame shift of a posture step as the centre sees it (driver frame, degrees). */
const add = (a: AnglePair, b: AnglePair): AnglePair => ({ yaw: a.yaw + b.yaw, pitch: a.pitch + b.pitch });

describe('S-P3 / S-P6 / S-P10 / S-P15: translation steps commit with bias ≤ 1.5° within 90 s, 0 false D1 (NC-R2a)', () => {
  const STEPS: [string, AnglePair, { dx: number; dy: number }, number][] = [
    ['S-P3', { yaw: 3, pitch: 0 }, { dx: 0.04, dy: 0 }, 1.06],
    ['S-P6', { yaw: 6, pitch: 0 }, { dx: 0.05, dy: 0 }, 1.07],
    ['S-P10', { yaw: 8, pitch: -6 }, { dx: 0.06, dy: 0.02 }, 1.08],
    ['S-P15', { yaw: 12, pitch: -9 }, { dx: 0.08, dy: 0.03 }, 1.1],
  ];
  const cases = STEPS.flatMap(([n, shift, box, iodScale]) => ([15, 8] as const).map((fps) => [n, fps, shift, box, iodScale] as const));
  test.each(cases)('%s at %i fps (geometric, σ 4°)', (_, fps, shift, box, iodScale) => {
    const r = play(drv((t) => (t >= 110 ? { posture: { shift, box, iodScale } } : null)), 230, { fps });
    const commit = ev(r, 'posture_commit');
    expect(commit.length).toBeGreaterThanOrEqual(1);
    expect(commit[0]!.tMs).toBeLessThanOrEqual(200_000);
    const before = centreAt(r, 109_000).centre!;
    const after = centreAt(r, commit[0]!.tMs + 1).centre!;
    expect(angularDistanceDeg(after, add(before, shift))).toBeLessThanOrEqual(1.5);
    expect(d1After(r, 105_000)).toEqual([]);
    expect(ev(r, 'posture_revert')).toEqual([]);
  });
  test('S-P6 with the gaze net (σ 2.5°)', () => {
    const r = play(drv((t) => (t >= 110 ? { posture: { shift: { yaw: 6, pitch: 0 }, box: { dx: 0.05, dy: 0 }, iodScale: 1.07 } } : null)), 230, { source: 'net' });
    const commit = ev(r, 'posture_commit');
    expect(commit.length).toBeGreaterThanOrEqual(1);
    const before = centreAt(r, 109_000).centre!;
    expect(angularDistanceDeg(centreAt(r, commit[0]!.tMs + 1).centre!, add(before, { yaw: 6, pitch: 0 }))).toBeLessThanOrEqual(1.5);
  });
});

describe('S-SEAT, S-R: a seat moved back and a recline', () => {
  test('S-SEAT: committed ≤ 90 s, mirrors demoted, no driver change', () => {
    const r = play(drv((t) => (t >= 110 ? { posture: { shift: { yaw: 2, pitch: 4 }, box: { dx: 0, dy: 0.06 }, iodScale: 0.9 } } : null)), 230);
    const commit = ev(r, 'posture_commit');
    expect(commit.length).toBeGreaterThanOrEqual(1);
    expect(commit[0]!.tMs).toBeLessThanOrEqual(200_000);
    expect(commit[0]!.demoteMirrors).toBe(true);
    expect(ev(r, 'driver_change')).toEqual([]);
  });
  test('S-R: a recline (pitch −8°, box down 0.05): the head centre follows at the commit; no nods', () => {
    const r = play(drv((t) => (t >= 110 ? { posture: { shift: { yaw: 0, pitch: -8 }, box: { dx: 0, dy: 0.05 } } } : null)), 230);
    const commit = ev(r, 'posture_commit');
    expect(commit.length).toBeGreaterThanOrEqual(1);
    const h0 = centreAt(r, 109_000).head!;
    const h1 = centreAt(r, commit[0]!.tMs + 1).head!;
    expect(Math.abs(h1.pitch - h0.pitch - -8)).toBeLessThanOrEqual(1.5);
    expect(r.events.filter((e) => e.kind === 'nod' || e.kind === 'microsleep_nod')).toEqual([]);
  });
});

describe('no false posture (K1): a held head turn, a slump, stares on the road', () => {
  test('S-TURN20: a 20° head turn held 8 s is no posture step', () => {
    const r = play(drv((t) => (within(t, 110, 118) ? { gaze: rel(20, 0), head: { yaw: 20 * 0.9, pitch: -1.2 } } : null)), 140);
    expect(ev(r, 'posture_dual')).toEqual([]);
  });
  test('S-SLUMP: the head settles 5° lower with no translation: a head_slump, the centre unchanged, no posture', () => {
    const r = play(drv((t, rr) => (t >= 110 ? { gaze: { yaw: onRoad(rr).yaw, pitch: onRoad(rr).pitch - 5 }, head: { yaw: 0.8, pitch: -1.2 - 5 } } : null)), 140);
    expect(ev(r, 'head_slump').length).toBeGreaterThanOrEqual(1);
    expect(ev(r, 'posture_dual')).toEqual([]);
  });
  test('S-STARE-ONROAD: a 10 s read at (15°, −8°) every 60 s for 10 min: no posture, the centre moves ≤ 1°, 0 D1', () => {
    const r = play(drv((t) => (t >= 110 && (t - 110) % 60 < 10 ? { gaze: rel(15, -8) } : null)), 710);
    expect(ev(r, 'posture_dual')).toEqual([]);
    expect(angularDistanceDeg(centreAt(r, 109_000).centre!, centreAt(r, 709_000).centre!)).toBeLessThanOrEqual(1);
    expect(d1After(r, 105_000)).toEqual([]);
  });
});

describe('S-P6-CURVE: a posture step in a 4°/s curve', () => {
  // The step lands 5 s into a 30 s curve: no admission in the curve (not straight), so the candidate is found
  // after it, within the 60 s search (a curve longer than about 50 s after the step drops the dual state; the
  // slow path, T5, then follows).
  test('committed after the curve, bias ≤ 1.5°', () => {
    const shift = { yaw: 6, pitch: 0 };
    const r = play(drv((t) => ({ ...(within(t, 105, 135) ? { turnDegS: 4 } : {}), ...(t >= 110 ? { posture: { shift, box: { dx: 0.05, dy: 0 }, iodScale: 1.07 } } : {}) })), 300);
    const commit = ev(r, 'posture_commit');
    expect(commit.length).toBeGreaterThanOrEqual(1);
    expect(angularDistanceDeg(centreAt(r, commit[0]!.tMs + 1).centre!, add(centreAt(r, 104_000).centre!, shift))).toBeLessThanOrEqual(1.5);
  });
});

describe('S-WRONG-COMMIT (NC-R3a): a commit onto a stare is reverted in probation', () => {
  test('a translation with no angle change, a 90 s stare 12° off, then normal driving: reverted within 5 min of the commit', () => {
    const r = play(drv((t) => ({ ...(t >= 110 ? { posture: { box: { dx: 0.05, dy: 0 } } } : {}), ...(within(t, 110, 200) ? { gaze: rel(12, -4) } : {}) })), 560);
    const commit = ev(r, 'posture_commit');
    expect(commit.length).toBeGreaterThanOrEqual(1);
    const revert = ev(r, 'posture_revert').filter((e) => e.tMs > commit[0]!.tMs);
    expect(revert.length).toBeGreaterThanOrEqual(1);
    expect(revert[0]!.tMs - commit[0]!.tMs).toBeLessThanOrEqual(300_000);
    expect(angularDistanceDeg(centreAt(r, 559_000).centre!, centreAt(r, 109_000).centre!)).toBeLessThanOrEqual(1.5);
  });
});

describe('a stop is a gap for posture (rev4 §2.3.2a)', () => {
  test('S-RED-POSTURE (NC-R4a): a seat change at a 40 s light: the dual state after the move-off, committed ≤ 90 s, D1 never off', () => {
    const shift = { yaw: 6, pitch: 0 };
    const r = play(drv((t) => ({ ...(within(t, 100, 140) ? { speedKmh: 0 } : {}), ...(t >= 110 ? { posture: { shift, box: { dx: 0.05, dy: 0 }, iodScale: 1.07 } } : {}) })), 260);
    const dual = ev(r, 'posture_dual');
    expect(dual.map((e) => e.cause)).toEqual(['stop']);
    const commit = ev(r, 'posture_commit');
    expect(commit.length).toBeGreaterThanOrEqual(1);
    expect(commit[0]!.tMs).toBeLessThanOrEqual(140_000 + 90_000);
    const offMoving = r.frames.filter((f) => f.tMs >= 142_000 && f.speed !== null && f.speed >= 20 && f.distraction === 'off');
    expect(offMoving).toEqual([]);
  });
  test('S-STOP-REACH (NC-P5): a 10 s lean to the glovebox at a light: no dual, no commit, no demotion', () => {
    const r = play(
      drv((t) => ({
        ...(within(t, 100, 140) ? { speedKmh: 0 } : {}),
        ...(within(t, 110, 120) ? { gaze: rel(35, -25), head: { yaw: 28, pitch: -18 }, posture: { box: { dx: 0.15, dy: 0.05 }, iodScale: 0.9 } } : {}),
      })),
      200
    );
    expect(ev(r, 'posture_dual')).toEqual([]);
    expect(ev(r, 'posture_commit')).toEqual([]);
  });
});

describe('a driver change across a stop (rev5 V2, W1, W2)', () => {
  /** A 40 s stop (100–140 s) with the face lost 110–120 s, then `who` from 120 s. */
  const swap = (who: Partial<DriverState>) =>
    drv((t) => ({ ...(within(t, 100, 140) ? { speedKmh: 0 } : {}), ...(within(t, 110, 120) ? { face: false } : t >= 120 ? who : {}) }));
  test.each([
    ['×0.75', 0.75],
    ['×1.3', 1.3],
  ])('S-STOP-SWAP (%s EAR; NC-V2): provisional 5 s after the face returns, 0 sleep Criticals, driver_change within 10 s of moving', (_, earScale) => {
    const r = play(swap({ otherDriver: true, earScale }), 200);
    const prov = ev(r, 'driver_change_provisional');
    expect(prov).toHaveLength(1);
    expect(prov[0]!.tMs).toBeGreaterThanOrEqual(124_500);
    expect(prov[0]!.tMs).toBeLessThanOrEqual(126_500);
    const dc = ev(r, 'driver_change');
    expect(dc).toHaveLength(1);
    expect(dc[0]!.tMs).toBeGreaterThanOrEqual(140_000);
    expect(dc[0]!.tMs).toBeLessThanOrEqual(151_000);
    expect(r.commands.filter((c) => c.tier === 3 && c.action === 'start')).toEqual([]);
  });
  test('S-STOP-SWAP-SAME: the same driver out and back in: nothing', () => {
    const r = play(swap({}), 200);
    expect([...ev(r, 'driver_change_provisional'), ...ev(r, 'driver_change'), ...ev(r, 'driver_change_reverted')]).toEqual([]);
  });
  test('S-STOP-SWAP-TOWN (W2): the swap, then town roads with no straight: D1 never off at ≥ 20 km/h, and a lap glance is alerted', () => {
    const r = play(
      drv((t) => ({
        ...(within(t, 100, 140) ? { speedKmh: 0 } : t >= 140 ? { speedKmh: 30, turnDegS: Math.floor(t / 7) % 2 === 0 ? 6 : -6 } : {}),
        ...(within(t, 110, 120) ? { face: false } : t >= 120 ? { otherDriver: true } : {}),
        ...(within(t, 300, 306.5) ? { gaze: rel(0, -40) } : {}),
      })),
      340
    );
    expect(ev(r, 'driver_change')).toHaveLength(1);
    const off = r.frames.filter((f) => f.tMs >= 145_000 && f.speed !== null && f.speed >= 20 && f.distraction === 'off');
    expect(off).toEqual([]);
    expect(d1After(r, 300_000).length).toBeGreaterThanOrEqual(1);
  });
  test('S-STOP-LOOKBACK (W1; NC-V3): the same driver back from a 5 s look back, leaning (IOD +16 %), reads a lap phone for the interim window, then shuts the eyes 3.5 s: F2', () => {
    const r = play(
      drv((t) => ({
        ...(within(t, 100, 160) ? { speedKmh: 0 } : {}),
        ...(within(t, 110, 115) ? { face: false } : t >= 115 ? { posture: { iodScale: 1.16 } } : {}),
        ...(within(t, 115, 126) ? { gaze: rel(0, -40), head: { yaw: 0.4, pitch: 0.2 * -43 } } : {}),
        ...(within(t, 130, 133.5) ? { openness: 0.1 } : {}),
      })),
      160,
      { lidGaze: true }
    );
    expect(ev(r, 'driver_change_provisional')).toHaveLength(1);
    expect(r.events.filter((e) => e.kind === 'sleep' && e.tMs >= 130_000 && e.tMs < 135_000)).toHaveLength(1);
  });
});

describe('a knocked mount across a stop (rev5 §3; W3)', () => {
  test('S-STOP-KNOCK: 8° at a light: a camera_bump after the move-off, into the dual state; D1 never off; no driver change', () => {
    const r = play(drv((t) => ({ ...(within(t, 100, 140) ? { speedKmh: 0 } : {}), ...(t >= 115 ? { mountShift: { yaw: 8, pitch: 0 } } : {}) })), 230);
    const bump = ev(r, 'camera_bump');
    expect(bump.map((e) => e.cause)).toEqual(['stop']);
    expect(bump[0]!.tMs).toBeGreaterThanOrEqual(140_000);
    expect(ev(r, 'driver_change')).toEqual([]);
    expect(r.frames.filter((f) => f.tMs >= 142_000 && f.speed !== null && f.speed >= 20 && f.distraction === 'off')).toEqual([]);
  });
  test('S-STOP-KNOCK-12 (W3): 12° with the face lost 4 s (the box moves 0.18, past the driver-change bound): a camera step, never a driver change', () => {
    const r = play(drv((t) => ({ ...(within(t, 100, 140) ? { speedKmh: 0 } : {}), ...(within(t, 112, 116) ? { face: false } : {}), ...(t >= 112 ? { mountShift: { yaw: 12, pitch: 0 } } : {}) })), 200);
    expect(ev(r, 'driver_change_provisional')).toEqual([]);
    expect(ev(r, 'driver_change')).toEqual([]);
    expect(ev(r, 'camera_bump').map((e) => e.cause)).toEqual(['stop']);
  });
});

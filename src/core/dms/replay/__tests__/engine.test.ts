// The engine façade (plan Task 12) and the carries it owes (T6 r1/r2, T7 m4, T9, T10, T11 r1/r2): the CSV
// format, a drive's own alert manager and summary, stopAll at drive end, gazeNetEvery, the warm-start
// prior (and a mismatched mount), and the request flags that keep invariantViolations at 0.
import { DEFAULT_DMS_CONFIG, type DmsConfig } from '../../engine/config';
import { createDmsEngine } from '../../engine/engine';
import type { DmsProfileV1 } from '../../engine/profile';
import { parseCsv, replayCsv, toCsv } from '../csv';
import { DEFAULT_INIT, replayItems } from '../run';
import { SCENARIOS } from '../scenarios';
import { onRoad, rel, synthDrive, type DriverFn } from '../synth';

const C = DEFAULT_DMS_CONFIG as DmsConfig;
const NET = { ...C, gazeSource: 'net' } as DmsConfig;
const scenario = (name: string) => SCENARIOS.find((s) => s.name === name)!;
const sig = (cs: readonly { action: string; kind: string }[]) => cs.map((c) => `${c.action}:${c.kind}`);

describe('the replay CSV (format v1)', () => {
  test('frames and rows survive the round trip exactly, and replaying the CSV gives the same result', () => {
    const items = synthDrive({ fps: 10, seconds: 110, seed: 3, source: 'net', driver: scenario('a 2.4 s lap glance').driver });
    const text = toCsv(items);
    expect(parseCsv(text)).toEqual(items);
    const a = replayItems(items, NET);
    const b = replayCsv(text, NET);
    expect(b.events).toEqual(a.events);
    expect(b.commands).toEqual(a.commands);
    expect(sig(b.commands)).toEqual(['start:distraction', 'stop:distraction']);
  });
  test('a wrong header is refused', () => {
    expect(() => parseCsv('tMs,face\n1,0\n')).toThrow(/header/);
  });
});

describe('a drive owns its alert manager and summary (T11 r1 carry)', () => {
  test('two drives in one session report independent counts', () => {
    const engine = createDmsEngine(C, DEFAULT_INIT);
    const one = replayItems(synthDrive({ fps: 10, seconds: 110, seed: 1, source: 'geometric', driver: scenario('a 2.4 s lap glance').driver }), C, DEFAULT_INIT, { engine });
    const two = replayItems(synthDrive({ fps: 10, seconds: 110, seed: 2, source: 'geometric', driver: scenario('attentive highway').driver }), C, DEFAULT_INIT, { engine });
    expect(one.summary.alerts.distraction.delivered).toBe(1);
    expect(two.summary.alerts.distraction.delivered).toBe(0);
    expect(two.summary.monitoredS.total).toBeLessThan(111);
    expect(two.commands).toEqual([]);
  });
  test('endDrive stops a running Critical (stopAll) before the manager is discarded', () => {
    const items = synthDrive({ fps: 15, seconds: 102, seed: 1, source: 'geometric', driver: scenario('sleep').driver });
    const r = replayItems(items, C);
    expect(sig(r.commands)).toEqual(['start:microsleep', 'stop:microsleep']);
    expect(r.commands[1]!.tMs).toBe(items.at(-1)!.frame.tMs);
  });
  test('the pending command list is merged by concatenation: drain returns a fresh, mutable array', () => {
    const engine = createDmsEngine(C, DEFAULT_INIT);
    const out = engine.drain();
    expect(Object.isFrozen(out.commands)).toBe(false);
    expect(out.commands).toEqual([]);
  });
});

describe('gazeNetEvery reaches the conditioner (T6 r1 carry)', () => {
  // The net on every 4th frame at 5 fps: an 800 ms gap. A net value is held for max(300 ms, 2 × every ×
  // the 200 ms frame interval): 400 ms with gazeNetEvery 1 (the third frame after a net frame falls back
  // to the head), 800 ms with 2 (it covers the gap).
  const run = (every: 1 | 2) => {
    const engine = createDmsEngine(NET, { ...DEFAULT_INIT, gazeNetEvery: every });
    const items = synthDrive({ fps: 5, seconds: 100, seed: 4, source: 'net', netEvery: 4, driver: scenario('attentive highway').driver });
    let head = 0;
    let gaze = 0;
    for (const it of items) {
      if (it.row) engine.pushRow(it.row.row, it.row.ex, it.frame.tMs);
      engine.pushFrame(it.frame);
      if (it.frame.tMs < 70_000 || engine.snapshot().quality !== 'tracking') continue;
      const src = engine.snapshot().source;
      if (src === 'head') head++;
      if (src === 'gaze') gaze++;
    }
    return { head, gaze };
  };
  test('with gazeNetEvery 2 the net value bridges an 800 ms gap; with 1 a quarter of the frames fall back to the head', () => {
    const two = run(2);
    const one = run(1);
    expect(two.head).toBeLessThan(0.1 * (two.head + two.gaze));
    expect(one.head).toBeGreaterThan(0.18 * (one.head + one.gaze));
  });
  test('setHost changes it mid-drive', () => {
    const engine = createDmsEngine(NET, DEFAULT_INIT);
    engine.setHost({ gazeNetEvery: 2, thermalLevel: 1, search: false });
    expect(() => engine.snapshot()).not.toThrow();
  });
});

describe('the warm-start prior (T7 m4): set only on warm_start; a mismatched mount keeps the defaults', () => {
  // A promoted learned rear mirror above the default rectangle (distance 3° from it: within bounds).
  const withMirror = (p: DmsProfileV1): DmsProfileV1 => ({ ...p, learnedZones: [{ id: 'rear_mirror', yawDeg: 24, pitchDeg: 18, halfYawDeg: 3, halfPitchDeg: 3, drives: 3 }] });
  const lookUp: DriverFn = (t, r) => ({ gaze: t >= 100 && t < 104 ? rel(24, 18) : onRoad(r), openness: 1, speedKmh: 60 });
  const zonesDuring = (profile: DmsProfileV1, other: boolean) => {
    const engine = createDmsEngine(NET, { ...DEFAULT_INIT, profile });
    const items = synthDrive({ fps: 15, seconds: 106, seed: 5, source: 'net', driver: (t, r) => ({ ...lookUp(t, r), otherDriver: other }) });
    const zones: string[] = [];
    const events: string[] = [];
    for (const it of items) {
      if (it.row) engine.pushRow(it.row.row, it.row.ex, it.frame.tMs);
      engine.pushFrame(it.frame);
      events.push(...engine.drain().events.map((e) => e.kind));
      if (it.frame.tMs >= 100_500 && it.frame.tMs < 103_500) zones.push(engine.snapshot().zone ?? 'null');
    }
    const count = (z: string) => zones.filter((x) => x === z).length;
    return { mirror: count('rear_mirror'), other: count('other'), n: zones.length, events };
  };
  test('the same mount: warm_start, and the learned mirror is used from then on', () => {
    const engine = createDmsEngine(NET, DEFAULT_INIT);
    const drive = replayItems(synthDrive({ fps: 15, seconds: 90, seed: 6, source: 'net', driver: lookUp }), NET, DEFAULT_INIT, { engine, keepOpen: true });
    const profile = engine.endDrive(90_000).profile!;
    expect(drive.summary.calibration.state).toBe('calibrated');
    const same = zonesDuring(withMirror(profile), false);
    expect(same.events).toContain('warm_start');
    expect(same.mirror).toBeGreaterThan(0.7 * same.n);
  });
  test('a mismatched mount: no warm_start, so no prior, and the default rectangles for the whole drive', () => {
    const engine = createDmsEngine(NET, DEFAULT_INIT);
    replayItems(synthDrive({ fps: 15, seconds: 90, seed: 6, source: 'net', driver: lookUp }), NET, DEFAULT_INIT, { engine, keepOpen: true });
    const profile = engine.endDrive(90_000).profile!;
    const moved = zonesDuring(withMirror(profile), true);
    expect(moved.events).not.toContain('warm_start');
    expect(moved.mirror).toBeLessThan(0.2 * moved.n);
  });
});

describe('blinks hold the gaze (the target of the plan negative control)', () => {
  test('an attentive drive: no blink frame falls back to the head, so a blink never becomes a glance', () => {
    const engine = createDmsEngine(C, DEFAULT_INIT);
    const items = synthDrive({ fps: 15, seconds: 120, seed: 8, source: 'geometric', driver: scenario('attentive highway').driver });
    let head = 0;
    let held = 0;
    for (const it of items) {
      if (it.row) engine.pushRow(it.row.row, it.row.ex, it.frame.tMs);
      engine.pushFrame(it.frame);
      if (it.frame.tMs < 70_000) continue;
      const src = engine.snapshot().source;
      if (src === 'head') head++;
      if (src === 'held') held++;
    }
    expect(held).toBeGreaterThan(30); // 12 blinks of 3 closed frames after 70 s
    expect(head).toBe(0);
  });
});

describe('escalations reach the manager (T11 I1): F3 after F1 at a known 8 km/h', () => {
  test('eyes shut at 60 km/h (F1), then slowing to 8 km/h: the F3 no-on-road clause still starts', () => {
    const slowing: DriverFn = (t, r) => ({ gaze: onRoad(r), openness: t >= 100 && t < 107 ? 0.1 : 1, speedKmh: t < 101.5 ? 60 : 8 });
    const r = replayItems(synthDrive({ fps: 15, seconds: 110, seed: 9, source: 'geometric', driver: slowing }), C);
    expect(r.events.filter((e) => e.kind === 'sleep')).toEqual([]); // F2 needs 10 km/h
    const f3 = r.commands.find((c) => c.kind === 'unresponsive' && c.action === 'start');
    expect(f3).toBeDefined();
    expect(r.invariantViolations).toBe(0);
  });
});

describe('the request flags (T11 I1/I2, round 2): the whole matrix asserts invariantViolations === 0', () => {
  test('a C-8 turn into LOST: a D1 raised on the LOST frame carries c8, so nothing is a violation', () => {
    // A fast head turn to the far lateral, then the face lost for 4 s at 60 km/h (C-8 far lateral).
    const turn: DriverFn = (t, r) =>
      t >= 100 && t < 100.2 ? { gaze: rel(-80, 0), head: rel(-70, 0), speedKmh: 60 } : t >= 100.2 && t < 104.2 ? { gaze: rel(-90, 0), face: false, speedKmh: 60 } : { gaze: onRoad(r), speedKmh: 60 };
    const r = replayItems(synthDrive({ fps: 15, seconds: 110, seed: 7, source: 'geometric', driver: turn }), C);
    expect(r.invariantViolations).toBe(0);
    expect(r.events.map((e) => e.kind)).toContain('d1_warning');
    // The warning was raised while the face was lost, so only `c8` lets it sound (rule 5, Tier 2).
    const d1 = r.events.find((e) => e.kind === 'd1_warning')!;
    expect(d1.tMs).toBeGreaterThan(100_200);
    expect(d1.tMs).toBeLessThan(104_200);
    expect(sig(r.commands)).toContain('start:distraction');
  });
});

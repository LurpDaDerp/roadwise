// The replay expectations (plan Task 12, rev0 table): one function per scenario, run on every frame rate
// and gaze source. Times are asserted within one frame period unless the comment says why not.
import type { DmsAlertCommand } from '../../engine/alerts';
import type { DmsEvent } from '../../engine/engine';
import type { ReplayResult } from '../run';
import { EVENT_S } from '../scenarios';

const RANK = { none: 0, early: 1, drowsy: 2, severe: 3 } as const;

export const kinds = (r: ReplayResult, k: string) => r.events.filter((e) => e.kind === k);
const sig = (c: readonly DmsAlertCommand[]) => c.map((x) => `${x.action}:${x.kind}`);

/** One event of kind `k`, at `atS` within one frame period (and the smoothing's one frame, where noted). */
function exactlyOneAt(r: ReplayResult, k: string, atS: number, fps: number, extraFrames = 1): DmsEvent {
  const ev = kinds(r, k);
  expect(ev).toHaveLength(1);
  const f = 1000 / fps;
  expect(Math.abs(ev[0]!.tMs - atS * 1000)).toBeLessThanOrEqual(extraFrames * f + 1e-6);
  return ev[0]!;
}

/** Below the gaze rules' fps floor (T6 review I2: 6.5, between 5 and 8) D1–D3 do not run. */
const gazeRulesRun = (fps: number) => fps >= 6.5;

const AUDIBLE_NONE = (r: ReplayResult) => {
  expect(r.commands).toEqual([]);
  for (const k of ['d1_warning', 'd2_warning', 'd3_phone_pattern', 'd4_unresponsive', 'microsleep', 'sleep', 'unresponsive', 'microsleep_nod']) expect(kinds(r, k)).toEqual([]);
};

export const EXPECT: Record<string, (r: ReplayResult, fps: number) => void> = {
  'attentive highway': (r) => {
    AUDIBLE_NONE(r);
    expect(kinds(r, 'calibrated').length).toBeGreaterThanOrEqual(1);
  },
  'mirror checks': AUDIBLE_NONE,
  'shoulder checks': AUDIBLE_NONE,
  'intersection side looks at 30 km/h in turns': AUDIBLE_NONE,
  'cluster checks': AUDIBLE_NONE,
  'a 3.0 s infotainment glance': (r, fps) => {
    if (!gazeRulesRun(fps)) return AUDIBLE_NONE(r);
    // D1 at 3.0 s (B = 3 s at ≥ 50 km/h, weight 1.0, no grace); the median-3 smoothing may move the
    // glance's first frame by one frame either way.
    const e = exactlyOneAt(r, 'd1_warning', EVENT_S + 3.0, fps);
    expect(sig(r.commands)).toEqual(['start:distraction', 'stop:distraction']);
    expect(r.commands[0]!.tMs).toBe(e.tMs);
  },
  'a 2.4 s lap glance': (r, fps) => {
    if (!gazeRulesRun(fps)) return AUDIBLE_NONE(r);
    const e = exactlyOneAt(r, 'd1_warning', EVENT_S + 2.4, fps); // lap weight 1.25: 3.0 / 1.25
    expect(sig(r.commands)).toEqual(['start:distraction', 'stop:distraction']);
    expect(r.commands[0]!.tMs).toBe(e.tMs);
  },
  'texting pattern': (r, fps) => {
    if (!gazeRulesRun(fps)) return AUDIBLE_NONE(r);
    exactlyOneAt(r, 'd3_phone_pattern', EVENT_S + 13.0, fps); // the third glance's 1.0 s of lap time
    exactlyOneAt(r, 'd1_warning', EVENT_S + 22.4, fps);
    expect(sig(r.commands)).toEqual(['once:phone_pattern', 'start:distraction', 'stop:distraction']);
  },
  'visual time-sharing': (r, fps) => {
    if (!gazeRulesRun(fps)) return AUDIBLE_NONE(r);
    // D2 at 10.0 s of centre-stack time: 8 glances of 1.2 s (9.6 s) + 0.4 s of the ninth = 117.2 s. D2
    // counts in 100 ms buckets and each glance's two edges may each move a frame with the smoothing, so
    // the tolerance is 0.35 s here, not one frame.
    const ev = kinds(r, 'd2_warning');
    expect(ev).toHaveLength(1);
    expect(Math.abs(ev[0]!.tMs - 117_200)).toBeLessThanOrEqual(350);
    expect(kinds(r, 'd1_warning')).toEqual([]);
    expect(sig(r.commands)).toEqual(['start:cumulative', 'stop:cumulative']);
  },
  microsleep: (r, fps) => {
    exactlyOneAt(r, 'microsleep', EVENT_S + 1.0, fps);
    expect(sig(r.commands)).toEqual(['start:microsleep', 'stop:microsleep']);
  },
  sleep: (r, fps) => {
    exactlyOneAt(r, 'microsleep', EVENT_S + 1.0, fps);
    exactlyOneAt(r, 'sleep', EVENT_S + 3.0, fps);
    // F3's no-on-road clause: 3.0 s of observed time from the frame after F1.
    exactlyOneAt(r, 'unresponsive', EVENT_S + 4.0, fps, 2);
    expect(sig(r.commands)).toEqual(['start:microsleep', 'stop:microsleep', 'start:sleep', 'stop:sleep', 'start:unresponsive', 'stop:unresponsive']);
  },
  'nodding off': (r) => {
    expect(kinds(r, 'nod').length).toBeGreaterThanOrEqual(7);
    for (const k of ['microsleep_nod', 'microsleep', 'sleep']) expect(kinds(r, k)).toEqual([]);
    const scored = r.events.filter((e): e is Extract<DmsEvent, { kind: 'fatigue_minute' }> => e.kind === 'fatigue_minute' && e.status === 'scored');
    expect(scored.at(-1)!.score!).toBeGreaterThan(0);
  },
  'drowsy PERCLOS ramp': (r, fps) => {
    const levels = r.events.filter((e): e is Extract<DmsEvent, { kind: 'fatigue_minute' }> => e.kind === 'fatigue_minute' && e.status === 'scored').map((e) => RANK[e.level]);
    // The levels only rise as the drowsiness builds.
    for (let i = 1; i < levels.length; i++) expect(levels[i]!).toBeGreaterThanOrEqual(levels[i - 1]!);
    expect(Math.max(...levels)).toBeGreaterThanOrEqual(RANK.drowsy);
    if (fps >= 10) {
      expect(Math.max(...levels)).toBe(RANK.severe);
      expect(kinds(r, 'yawn').length).toBeGreaterThanOrEqual(5);
    } else expect(kinds(r, 'yawn')).toEqual([]); // yawns are off below 9 fps (rev1 m7)
    for (const k of ['microsleep', 'sleep']) expect(kinds(r, k)).toEqual([]);
  },
  'falling asleep into LOST (C-26)': (r, fps) => {
    // Bridged (C-26) with the head down: the gate's deep run counts through the loss.
    const f1 = exactlyOneAt(r, 'microsleep', EVENT_S + 1.5, fps);
    const f2 = exactlyOneAt(r, 'sleep', EVENT_S + 3.0, fps);
    expect([f1, f2].every((e) => 'bridged' in e && e.bridged === true)).toBe(true);
    expect(sig(r.commands).slice(0, 3)).toEqual(['start:microsleep', 'stop:microsleep', 'start:sleep']);
  },
  sunglasses: (r) => {
    // T6 r2 carry: a lens through the whole engine → HEAD_ONLY, with no closure (and no blink) at all.
    AUDIBLE_NONE(r);
    expect(kinds(r, 'blink')).toEqual([]);
    expect(r.summary.monitoredS.tracking).toBe(0);
    expect(r.summary.monitoredS.head_only).toBeGreaterThan(0.95 * r.summary.monitoredS.total);
  },
  'camera bump': (r) => {
    AUDIBLE_NONE(r);
    const bump = kinds(r, 'camera_bump');
    expect(bump).toHaveLength(1);
    expect(bump[0]!.tMs).toBeGreaterThanOrEqual(150_000);
    expect(bump[0]!.tMs).toBeLessThan(160_000);
    expect(kinds(r, 'calibrated').some((e) => e.tMs > bump[0]!.tMs)).toBe(true);
  },
  'driver change': (r) => {
    AUDIBLE_NONE(r);
    const dc = kinds(r, 'driver_change');
    expect(dc).toHaveLength(1);
    expect(dc[0]!.tMs).toBeGreaterThanOrEqual(190_000);
    expect(dc[0]!.tMs).toBeLessThan(200_000);
    expect(kinds(r, 'calibrated').some((e) => e.tMs > dc[0]!.tMs)).toBe(true);
  },
  'driver absent': (r) => {
    AUDIBLE_NONE(r);
    expect(r.summary.monitoredS.tracking).toBe(0);
    expect(r.summary.attentionScore).toBeNull();
    // Nothing but the calibrator giving up and the (learning) fatigue minutes.
    expect(r.events.filter((e) => e.kind !== 'fatigue_minute').map((e) => e.kind)).toEqual(['uncalibrated']);
  },
};

/** What holds for every run: no façade invariant broken, sounds that start also stop, a JSON-safe summary. */
export function common(r: ReplayResult): void {
  expect(r.invariantViolations).toBe(0);
  const open = new Map<string, number>();
  for (const c of r.commands) {
    expect([1, 2, 3]).toContain(c.tier);
    if (c.action === 'start') open.set(c.kind, (open.get(c.kind) ?? 0) + 1);
    if (c.action === 'stop') open.set(c.kind, (open.get(c.kind) ?? 0) - 1);
  }
  for (const v of open.values()) expect(v).toBe(0);
  expect(JSON.stringify(JSON.parse(JSON.stringify(r.summary)))).toBe(JSON.stringify(r.summary));
  const walk = (x: unknown): boolean => (typeof x === 'number' ? Number.isFinite(x) : x === null || typeof x !== 'object' ? true : Object.values(x as object).every(walk));
  expect(walk(r.summary)).toBe(true);
}

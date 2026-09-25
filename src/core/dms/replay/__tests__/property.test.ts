// Seeded property tests (plan Task 12, rev1; final review m8): random drives at a random fps from
// {5, 8, 10, 15, 30} with random glances, closures, nods, nod-offs into LOST (C-26 bridges), LOST runs, C-8
// turns, lenses, face absence, frame gaps, speed profiles with GNSS loss and tunnels (no speed, the IMU
// moving), and stretches with no frames while rows go on: the camera off (cameraOff at the start) or the gate
// closed (stopAlerts). For every drive:
//   - the D1 buffer f stays in [0, 1];
//   - nothing Tier 1/2 is audible below 20 km/h, and nothing at all below 10 km/h except a Critical
//     (Task C2: the sleep family at every speed; D4 never fires while STOPPED, a known speed below 10);
//   - rule 5 at REQUEST time (T12 review m2): no D1, D2 or phone-pattern request from a LOST frame is
//     accepted unless it carries c8 (a fatigue burst may play on a LOST frame: ruled acceptable);
//   - a gap frame adds no time: no D1 or D2 on a gap frame, and the closure time (`closedMs`) on a gap frame
//     is never more than on the frame before it, bridged or not (T12 review I1; final review m1, and round 2's
//     I1 residual: the invariant "bridged F events are allowed" hid that bug). An F event may still fire on a
//     gap frame from a state change with no time added (the looking-down gate lifting, the speed gate);
//   - nothing starts while the gate is closed, and nothing Tier 1/2 while the camera is off;
//   - a Critical's LIFETIME is bounded (final review m8), not only paired with a stop at the drive's end:
//       · it stops within criticalLostMaxS + 1 s of the later of its start and the last TRACKING frame (U-23);
//       · within criticalBlindMaxS + 1 s of the last frame (I2);
//       · a D4-origin one within criticalEndAfterS + 1 s of a known speed < 10 km/h (rows with a fix); Task C2:
//         a sleep-origin one is never ended by a stop, so only its clear and the caps bound it;
//   - every start has its stop by the end of the drive, and every tier is 1–3;
//   - the façade never breaks the alert contract (invariantViolations 0: rule 5 and escalations);
//   - a replay equals itself (determinism), and the summary has no NaN.
// C2 round 1 (review-C2 F1): half the drives carry motion evidence (sensor stops, ambiguous stillness,
// tunnels, evidence gaps), and the user's rule is asserted directly:
//   - no sleep-family request (F1, F2, microsleep_nod) is ever suppressed for speed;
//   - no D4-origin Critical starts while the engine is STOPPED;
//   - a sleep-origin Critical stops only on its clear (a TRACKING frame with the eyes open), a cap, the gate
//     closing, or a replacement; never on a stop.
//
// The default run: 20 drives × 2 min. DMS_FULL=1 (a test-only switch, read only by the replay test files,
// never by the app, eas.json or any build): 200 drives × 10 min. The seeds are fixed and are in each test's
// name, so a failure names its drive.
import type { DmsAlertCommand } from '../../engine/alerts';
import { DEFAULT_DMS_CONFIG, type DmsConfig } from '../../engine/config';
import { createDmsEngine, type DmsEngine } from '../../engine/engine';
import { common } from '../__fixtures__/expectations';
import { randomDrive, type RandomDrive } from '../random';
import { DEFAULT_INIT } from '../run';

const FULL = process.env.DMS_FULL === '1';
const N = FULL ? 200 : 20;
const SECONDS = FULL ? 600 : 120;
const C = DEFAULT_DMS_CONFIG as DmsConfig;
const SEEDS = Array.from({ length: N }, (_, i) => 1000 + i);
const A = C.alerts;

interface Step {
  tMs: number;
  frame: boolean;
  gap: boolean;
  quality: string | null;
  speed: number | null;
  buffer: number;
  closedMs: number;
  /** C2: the running Critical's origin after this step */
  origin: 'sleep' | 'd4' | null;
  /** C2 round 1: the engine's STOPPED state after this step */
  stopped: boolean;
  commands: DmsAlertCommand[];
  events: { kind: string; tMs: number }[];
  off: RandomOff | null;
}
type RandomOff = RandomDrive['offs'][number];

/** One drive through the engine: rows always, frames except during an off stretch; the off's call at its start. */
function play(d: RandomDrive, engine: DmsEngine, onStep?: (s: Step) => void): DmsAlertCommand[] {
  const commands: DmsAlertCommand[] = [];
  let started: RandomOff | null = null;
  for (const it of d.items) {
    const t = it.frame.tMs;
    const off = d.offs.find((o) => t >= o.fromMs && t < o.toMs) ?? null;
    if (off !== null && started !== off) {
      started = off;
      if (off.kind === 'camera') engine.cameraOff(t, off.cause);
      else engine.stopAlerts(t);
    }
    if (it.row !== undefined) engine.pushRow(it.row.row, it.row.ex, t);
    if (off === null) engine.pushFrame(it.frame);
    const s = engine.snapshot();
    const out = engine.drain();
    commands.push(...out.commands);
    onStep?.({ tMs: t, frame: off === null, gap: off === null && s.gap, quality: off === null ? s.quality : null, speed: s.ruleSpeedKmh, buffer: s.bufferFraction, closedMs: s.closedMs, origin: s.criticalOrigin, stopped: s.stopped, commands: [...out.commands], events: [...out.events], off });
  }
  return commands;
}

test.each(SEEDS)('random drive, seed %d', (seed) => runSeed(seed, SECONDS));

// Task C7 (review-C2 Round 1, R1-a): the two DMS_FULL seeds that pin NC-E2 (1009) and NC-C2h (1164) run at 600 s in
// the default suite too, so both negative controls bite without DMS_FULL.
if (!FULL) test.each([1009, 1164])('random drive, seed %d at 600 s (the pinned DMS_FULL seeds)', (seed) => runSeed(seed, 600));

function runSeed(seed: number, seconds: number): void {
  const d = randomDrive(seed, seconds);
  const cfg = { ...C, gazeSource: d.source } as DmsConfig;
  const engine = createDmsEngine(cfg, DEFAULT_INIT);
  // Known-low runs from the rows (a fix, < 10 km/h), for the Critical lifetime bound.
  const rowAt = new Map(d.items.filter((it) => it.row !== undefined).map((it) => [it.frame.tMs, it.row!.row]));
  let critical: { since: number } | null = null;
  let lastTracking = Number.NEGATIVE_INFINITY;
  let lastFrame = Number.NEGATIVE_INFINITY;
  let knownLowSince: number | null = null;
  let prevClosedMs = 0;
  let prevOrigin: 'sleep' | 'd4' | null = null;
  /** C7 (review-C2 Round 1, R1-a): TRACKING with the eyes open continuously since this time */
  let openSince: number | null = null;
  const commands = play(d, engine, (s) => {
    if (s.frame && s.quality === 'tracking' && s.closedMs === 0) openSince ??= s.tMs;
    else if (s.frame) openSince = null;
    // C2 round 1 (b): no D4-origin Critical starts while STOPPED.
    const started3 = s.commands.some((c) => c.tier === 3 && c.action === 'start');
    if (started3 && s.origin === 'd4') expect({ seed, tMs: s.tMs, d4AtStop: s.stopped }).toEqual({ seed, tMs: s.tMs, d4AtStop: false });
    // C2 round 1 (c): a sleep-origin Critical stops only on its clear, a cap, the gate closing, or a replacement.
    const stops3 = s.commands.filter((c) => c.tier === 3 && c.action === 'stop');
    if (prevOrigin === 'sleep' && stops3.length > 0 && !started3 && s.off === null) {
      const capped = engine.alertLog().some((e) => e.tMs === s.tMs && (e.why === 'blind_cap' || e.why === 'lost_cap'));
      // R1-a: the clear must have HELD for tier3ClearS (the eyes open on TRACKING frames for the last 1 s).
      const clear = openSince !== null && s.tMs - openSince >= A.tier3ClearS * 1000 - 100;
      expect({ seed, tMs: s.tMs, sleepStopExplained: capped || clear }).toEqual({ seed, tMs: s.tMs, sleepStopExplained: true });
    }
    prevOrigin = s.origin;
    expect(s.buffer).toBeGreaterThanOrEqual(0);
    expect(s.buffer).toBeLessThanOrEqual(1);
    if (s.gap) {
      const onGap = s.events.filter((e) => ['d1_warning', 'd2_warning'].includes(e.kind));
      expect({ seed, tMs: s.tMs, onGap }).toEqual({ seed, tMs: s.tMs, onGap: [] });
      // The gap adds no closure time (round 2): at most the previous frame's.
      expect({ seed, tMs: s.tMs, added: s.closedMs > prevClosedMs + 1e-6 }).toEqual({ seed, tMs: s.tMs, added: false });
    }
    if (s.frame) prevClosedMs = s.closedMs;
    if (s.frame) lastFrame = s.tMs;
    if (s.quality === 'tracking') lastTracking = s.tMs;
    const row = rowAt.get(s.tMs);
    if (row !== undefined) knownLowSince = row.gnssValid && row.speed >= 0 && row.speed * 3.6 < A.criticalEndBelowKmh ? (knownLowSince ?? s.tMs) : null;
    for (const c of s.commands) {
      if (c.tier === 3 && c.action === 'start') critical = { since: c.tMs };
      if (c.tier === 3 && c.action === 'stop') critical = null;
      if (c.action === 'stop') continue;
      // Nothing starts while the gate is closed; nothing Tier 1/2 while the camera is off.
      if (s.off?.kind === 'gate') expect({ seed, c, gate: true }).toEqual({ seed, c: expect.objectContaining({ kind: 'monitoring_paused' }), gate: true });
      else if (s.off?.kind === 'camera' && c.tier < 3) expect({ seed, c }).toEqual({ seed, c: expect.objectContaining({ kind: 'monitoring_paused' }) });
      const speed = s.speed;
      if (c.tier < 3 && c.kind !== 'monitoring_paused') {
        expect({ seed, c, speed }).toEqual({ seed, c, speed: expect.any(Number) });
        expect(speed!).toBeGreaterThanOrEqual(20);
      }
    }
    // C2: D4 never fires while STOPPED (a known speed below 10: its accounting is frozen, rev4 §2.1.10).
    if (knownLowSince !== null) {
      const d4 = s.events.filter((e) => e.kind === 'd4_unresponsive');
      expect({ seed, tMs: s.tMs, d4 }).toEqual({ seed, tMs: s.tMs, d4: [] });
    }
    if (critical !== null) {
      // The lifetime bounds: never sounding past a cap by more than a second (and one row tick).
      const slack = 1000 + 1000;
      const since = Math.max(critical.since, lastTracking);
      expect({ seed, tMs: s.tMs, lostFor: s.tMs - since <= A.criticalLostMaxS * 1000 + slack }).toEqual({ seed, tMs: s.tMs, lostFor: true });
      expect({ seed, tMs: s.tMs, blindFor: s.tMs - Math.max(critical.since, lastFrame) <= A.criticalBlindMaxS * 1000 + slack }).toEqual({ seed, tMs: s.tMs, blindFor: true });
      if (knownLowSince !== null && s.origin === 'd4') {
        const lowFor = s.tMs - Math.max(knownLowSince, critical.since);
        expect({ seed, tMs: s.tMs, lowFor: lowFor <= (A.criticalEndAfterS + 3) * 1000 + slack }).toEqual({ seed, tMs: s.tMs, lowFor: true });
      }
    }
  });
  // C2 round 1 (a): no sleep-family request is ever suppressed for speed.
  const sleepSpeed = engine.alertLog().filter((e) => (e.kind === 'microsleep' || e.kind === 'sleep' || e.kind === 'microsleep_nod') && e.outcome === 'suppressed' && e.why === 'speed');
  expect({ seed, sleepSpeed }).toEqual({ seed, sleepSpeed: [] });
  const violations = engine.snapshot().invariantViolations;
  const accepted = engine.alertLog().filter((e) => (e.kind === 'distraction' || e.kind === 'cumulative' || e.kind === 'phone_pattern') && e.quality === 'lost' && e.outcome !== 'suppressed');
  expect({ seed, accepted: accepted.filter((e) => e.c8 !== true) }).toEqual({ seed, accepted: [] });
  const end = engine.endDrive(d.items.at(-1)!.frame.tMs);
  commands.push(...engine.drain().commands);
  common({ events: [], commands, summary: end.summary, invariantViolations: violations, engine });
  // Determinism: the same drive replays to the same result.
  const again = createDmsEngine(cfg, DEFAULT_INIT);
  const commands2 = play(d, again);
  again.endDrive(d.items.at(-1)!.frame.tMs);
  commands2.push(...again.drain().commands);
  expect(commands2).toEqual(commands);
}

test('the random drives cover the new stretches (final review m8)', () => {
  const drives = SEEDS.map((s) => randomDrive(s, SECONDS));
  expect(drives.some((d) => d.offs.some((o) => o.kind === 'camera'))).toBe(true);
  expect(drives.some((d) => d.offs.some((o) => o.kind === 'gate'))).toBe(true);
  // a tunnel: a row with no fix while the IMU moves
  expect(drives.some((d) => d.items.some((it) => it.row !== undefined && !it.row.row.gnssValid && it.row.ex.imuMoving))).toBe(true);
  // a C-26 bridge happens in at least one drive
  const bridged = drives.some((d) => {
    const engine = createDmsEngine({ ...C, gazeSource: d.source } as DmsConfig, DEFAULT_INIT);
    let seen = false;
    play(d, engine, (s) => (seen ||= s.events.some((e) => (e.kind === 'microsleep' || e.kind === 'sleep') && (e as { bridged?: boolean }).bridged === true)));
    return seen;
  });
  expect(bridged).toBe(true);
});

test('C2 round 1 (review-C2 F1): half the drives carry motion evidence, with sensor stops, ambiguous stillness, tunnels and evidence gaps', () => {
  const drives = SEEDS.map((s) => randomDrive(s, SECONDS));
  const withMotion = drives.filter((d) => d.motion);
  expect(withMotion.length).toBeGreaterThanOrEqual(Math.floor(N / 4));
  expect(withMotion.length).toBeLessThan(N);
  const rows = withMotion.flatMap((d) => d.items.filter((it) => it.row !== undefined).map((it) => it.row!.ex.motion));
  expect(rows.some((m) => m?.stop === 'sensor')).toBe(true);
  expect(rows.some((m) => m?.ambiguousStill === true)).toBe(true);
  expect(rows.some((m) => m?.moving === 'weak' && m.vLowKmh !== null)).toBe(true);
  expect(rows.some((m) => m === undefined)).toBe(true); // an evidence gap
  // the new states are reached through the engine
  const states = new Set<string>();
  for (const d of withMotion.slice(0, 6)) {
    const engine = createDmsEngine({ ...C, gazeSource: d.source } as DmsConfig, DEFAULT_INIT);
    for (const it of d.items) {
      if (it.row !== undefined) engine.pushRow(it.row.row, it.row.ex, it.frame.tMs);
      engine.pushFrame(it.frame);
      engine.drain();
      states.add(engine.snapshot().speedState);
    }
  }
  // C7 (review-C2 Round 1, R1-b): evidence gaps reach 5 s, over rowStaleMs (3 s), so `unknown` is reached too.
  expect([...states]).toEqual(expect.arrayContaining(['stopped', 'moving_known', 'ambiguous', 'moving_after_stop', 'unknown']));
});

// Seeded property tests (plan Task 12, rev1; final review m8): random drives at a random fps from
// {5, 8, 10, 15, 30} with random glances, closures, nods, nod-offs into LOST (C-26 bridges), LOST runs, C-8
// turns, lenses, face absence, frame gaps, speed profiles with GNSS loss and tunnels (no speed, the IMU
// moving), and stretches with no frames while rows go on: the camera off (cameraOff at the start) or the gate
// closed (stopAlerts). For every drive:
//   - the D1 buffer f stays in [0, 1];
//   - nothing Tier 1/2 is audible below 20 km/h, and nothing at all below 10 km/h except a Critical
//     (a new one needs ≥ 10 km/h; below it only an escalation of a running episode, T11 I1);
//   - rule 5 at REQUEST time (T12 review m2): no D1, D2 or phone-pattern request from a LOST frame is
//     accepted unless it carries c8 (a fatigue burst may play on a LOST frame: ruled acceptable);
//   - no D1, D2, F1 or F2 on a gap frame (T12 review I1: unobserved time never counts, and a gap frame adds
//     no closure time; final review m1), unless the F event is bridged: a C-26 bridge runs through a short
//     gap and is ended at bridgeMaxS on any frame (final review I1, m8);
//   - nothing starts while the gate is closed, and nothing Tier 1/2 while the camera is off;
//   - a Critical's LIFETIME is bounded (final review m8), not only paired with a stop at the drive's end:
//       · it stops within criticalLostMaxS + 1 s of the later of its start and the last TRACKING frame (U-23);
//       · within criticalBlindMaxS + 1 s of the last frame (I2);
//       · within criticalEndAfterS + 1 s of a known speed < 10 km/h (rows with a fix);
//   - every start has its stop by the end of the drive, and every tier is 1–3;
//   - the façade never breaks the alert contract (invariantViolations 0: rule 5 and escalations);
//   - a replay equals itself (determinism), and the summary has no NaN.
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
    onStep?.({ tMs: t, frame: off === null, gap: off === null && s.gap, quality: off === null ? s.quality : null, speed: s.ruleSpeedKmh, buffer: s.bufferFraction, commands: [...out.commands], events: [...out.events], off });
  }
  return commands;
}

test.each(SEEDS)('random drive, seed %d', (seed) => {
  const d = randomDrive(seed, SECONDS);
  const cfg = { ...C, gazeSource: d.source } as DmsConfig;
  const engine = createDmsEngine(cfg, DEFAULT_INIT);
  // Known-low runs from the rows (a fix, < 10 km/h), for the Critical lifetime bound.
  const rowAt = new Map(d.items.filter((it) => it.row !== undefined).map((it) => [it.frame.tMs, it.row!.row]));
  let critical: { since: number } | null = null;
  let lastTracking = Number.NEGATIVE_INFINITY;
  let lastFrame = Number.NEGATIVE_INFINITY;
  let knownLowSince: number | null = null;
  const commands = play(d, engine, (s) => {
    expect(s.buffer).toBeGreaterThanOrEqual(0);
    expect(s.buffer).toBeLessThanOrEqual(1);
    if (s.gap) {
      // A C-26 bridge runs on the frame clock through a short gap, and the conditioner ends it at bridgeMaxS on
      // any frame (final review I1), so a BRIDGED F1/F2 on a gap frame is within the cap by construction.
      const onGap = s.events.filter((e) => ['d1_warning', 'd2_warning', 'microsleep', 'sleep'].includes(e.kind) && (e as { bridged?: boolean }).bridged !== true);
      expect({ seed, tMs: s.tMs, onGap }).toEqual({ seed, tMs: s.tMs, onGap: [] });
    }
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
      if (c.tier === 3 && (speed === null || speed < 10)) {
        // Below 10 km/h (or with no speed) only an escalation may start a Critical: always `unresponsive`.
        expect({ seed, c }).toEqual({ seed, c: expect.objectContaining({ kind: 'unresponsive' }) });
      }
      if (c.tier < 3 && c.kind !== 'monitoring_paused') {
        expect({ seed, c, speed }).toEqual({ seed, c, speed: expect.any(Number) });
        expect(speed!).toBeGreaterThanOrEqual(20);
      }
    }
    if (critical !== null) {
      // The lifetime bounds: never sounding past a cap by more than a second (and one row tick).
      const slack = 1000 + 1000;
      const since = Math.max(critical.since, lastTracking);
      expect({ seed, tMs: s.tMs, lostFor: s.tMs - since <= A.criticalLostMaxS * 1000 + slack }).toEqual({ seed, tMs: s.tMs, lostFor: true });
      expect({ seed, tMs: s.tMs, blindFor: s.tMs - Math.max(critical.since, lastFrame) <= A.criticalBlindMaxS * 1000 + slack }).toEqual({ seed, tMs: s.tMs, blindFor: true });
      if (knownLowSince !== null) {
        const lowFor = s.tMs - Math.max(knownLowSince, critical.since);
        expect({ seed, tMs: s.tMs, lowFor: lowFor <= (A.criticalEndAfterS + 3) * 1000 + slack }).toEqual({ seed, tMs: s.tMs, lowFor: true });
      }
    }
  });
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
});

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

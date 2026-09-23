// Seeded property tests (plan Task 12, rev1): random drives at a random fps from {5, 8, 10, 15, 30} with
// random glances, closures, nods, LOST runs, C-8 turns, lenses, face absence, frame gaps, speed profiles
// and GNSS loss. For every drive:
//   - the D1 buffer f stays in [0, 1];
//   - nothing Tier 1/2 is audible below 20 km/h, and nothing at all below 10 km/h except a Critical
//     (a new one needs ≥ 10 km/h; below it only an escalation of a running episode, T11 I1);
//   - rule 5 at REQUEST time (T12 review m2): no D1, D2 or phone-pattern request from a LOST frame is
//     accepted unless it carries c8 (a fatigue burst may play on a LOST frame: ruled acceptable);
//   - no D1, D2, F1 or F2 on a gap frame (T12 review I1: unobserved time never counts);
//   - every start has its stop by the end of the drive, and every tier is 1–3;
//   - the façade never breaks the alert contract (invariantViolations 0: rule 5 and escalations);
//   - a replay equals itself (determinism), and the summary has no NaN.
//
// The default run: 20 drives × 2 min. DMS_FULL=1 (a test-only switch, read only by the replay test files,
// never by the app, eas.json or any build): 200 drives × 10 min. The seeds are fixed and are in each test's
// name, so a failure names its drive.
import type { DmsAlertCommand } from '../../engine/alerts';
import { DEFAULT_DMS_CONFIG, type DmsConfig } from '../../engine/config';
import { createDmsEngine } from '../../engine/engine';
import { common } from '../__fixtures__/expectations';
import { randomDrive } from '../random';
import { DEFAULT_INIT, replayItems } from '../run';

const FULL = process.env.DMS_FULL === '1';
const N = FULL ? 200 : 20;
const SECONDS = FULL ? 600 : 120;
const C = DEFAULT_DMS_CONFIG as DmsConfig;
const SEEDS = Array.from({ length: N }, (_, i) => 1000 + i);

test.each(SEEDS)('random drive, seed %d', (seed) => {
  const d = randomDrive(seed, SECONDS);
  const cfg = { ...C, gazeSource: d.source } as DmsConfig;
  const engine = createDmsEngine(cfg, DEFAULT_INIT);
  const commands: DmsAlertCommand[] = [];
  for (const it of d.items) {
    if (it.row !== undefined) engine.pushRow(it.row.row, it.row.ex, it.frame.tMs);
    engine.pushFrame(it.frame);
    const s = engine.snapshot();
    expect(s.bufferFraction).toBeGreaterThanOrEqual(0);
    expect(s.bufferFraction).toBeLessThanOrEqual(1);
    const out = engine.drain();
    if (s.gap) {
      const onGap = out.events.filter((e) => ['d1_warning', 'd2_warning', 'microsleep', 'sleep'].includes(e.kind));
      expect({ seed, tMs: it.frame.tMs, onGap }).toEqual({ seed, tMs: it.frame.tMs, onGap: [] });
    }
    for (const c of out.commands) {
      commands.push(c);
      if (c.action === 'stop') continue;
      const speed = s.ruleSpeedKmh;
      if (c.tier === 3 && (speed === null || speed < 10)) {
        // Below 10 km/h (or with no speed) only an escalation may start a Critical: always `unresponsive`.
        expect({ seed, c }).toEqual({ seed, c: expect.objectContaining({ kind: 'unresponsive' }) });
      }
      if (c.tier < 3) {
        expect({ seed, c, speed }).toEqual({ seed, c, speed: expect.any(Number) });
        expect(speed!).toBeGreaterThanOrEqual(20);
      }
    }
  }
  const violations = engine.snapshot().invariantViolations;
  const accepted = engine.alertLog().filter((e) => (e.kind === 'distraction' || e.kind === 'cumulative' || e.kind === 'phone_pattern') && e.quality === 'lost' && e.outcome !== 'suppressed');
  expect({ seed, accepted: accepted.filter((e) => e.c8 !== true) }).toEqual({ seed, accepted: [] });
  const end = engine.endDrive(d.items.at(-1)!.frame.tMs);
  commands.push(...engine.drain().commands);
  common({ events: [], commands, summary: end.summary, invariantViolations: violations, engine });
  // Determinism: the same drive replays to the same result.
  const a = replayItems(d.items, cfg);
  const b = replayItems(d.items, cfg);
  expect(JSON.stringify({ e: b.events, c: b.commands, s: b.summary })).toBe(JSON.stringify({ e: a.events, c: a.commands, s: a.summary }));
  expect(a.commands).toEqual(commands);
});

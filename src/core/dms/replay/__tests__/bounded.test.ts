// Bounded memory and the performance guard (plan Task 12).
//
// Default run: a 10 min drive whose every growing buffer stays within its cap, checked each minute (no
// timing assertion: a timing check under a loaded full test run would be flaky).
// DMS_FULL=1 (a test-only switch, read only by the replay test files, never by the app, eas.json or any
// build) adds the 2 h bounded-memory run and the 54,000-frame performance guard (30 min at 30 fps).
import { DEFAULT_DMS_CONFIG, type DmsConfig } from '../../engine/config';
import { createDmsEngine, type DmsEngine } from '../../engine/engine';
import { randomDrive } from '../random';
import { DEFAULT_INIT } from '../run';
import { SCENARIOS } from '../scenarios';
import { synthDrive, type SynthItem } from '../synth';

const FULL = process.env.DMS_FULL === '1';
const C = DEFAULT_DMS_CONFIG as DmsConfig;

function pushAll(engine: DmsEngine, items: readonly SynthItem[], every: (tMs: number) => void): void {
  let nextCheck = 60_000;
  for (const it of items) {
    if (it.row !== undefined) engine.pushRow(it.row.row, it.row.ex, it.frame.tMs);
    engine.pushFrame(it.frame);
    engine.drain();
    if (it.frame.tMs >= nextCheck) {
      every(it.frame.tMs);
      nextCheck += 60_000;
    }
  }
}

function assertBounded(engine: DmsEngine): void {
  for (const [name, { size, cap }] of Object.entries(engine.sizes())) expect({ name, ok: size <= cap }).toEqual({ name, ok: true });
}

test('a 10 min drive: every growing buffer stays within its cap, checked each minute', () => {
  const engine = createDmsEngine(C, DEFAULT_INIT);
  // Events every minute: the mirror-check driver keeps the glance and alert logs busy.
  const items = synthDrive({ fps: 15, seconds: 600, seed: 11, source: 'geometric', driver: SCENARIOS.find((s) => s.name === 'mirror checks')!.driver });
  let checks = 0;
  pushAll(engine, items, () => {
    assertBounded(engine);
    checks++;
  });
  expect(checks).toBe(9);
  // The seed ring holds seconds, not the drive.
  expect(engine.sizes().seedRing.size).toBeLessThanOrEqual(4 * 15 + 2);
});

(FULL ? test : test.skip)('DMS_FULL: a 2 h drive stays bounded (random events throughout)', () => {
  const engine = createDmsEngine(C, DEFAULT_INIT);
  const d = randomDrive(4242, 7200);
  pushAll(engine, d.items, () => assertBounded(engine));
  assertBounded(engine);
  const sizes = engine.sizes();
  expect(sizes.fatigueTimeline.size).toBeLessThanOrEqual(1440);
  expect(sizes.alertLog.size).toBeLessThanOrEqual(1024);
}, 600_000);

(FULL ? test : test.skip)('DMS_FULL: the performance guard, 54,000 frames (30 min at 30 fps): p95 of a 100 ms batch ≤ 3 ms', () => {
  const engine = createDmsEngine(C, DEFAULT_INIT);
  const items = synthDrive({ fps: 30, seconds: 1800, seed: 12, source: 'geometric', driver: SCENARIOS.find((s) => s.name === 'attentive highway')!.driver });
  expect(items).toHaveLength(54_000);
  const batches: number[] = [];
  for (let i = 0; i < items.length; i += 3) {
    const t0 = performance.now();
    for (const it of items.slice(i, i + 3)) {
      if (it.row !== undefined) engine.pushRow(it.row.row, it.row.ex, it.frame.tMs);
      engine.pushFrame(it.frame);
    }
    engine.drain();
    batches.push(performance.now() - t0);
  }
  batches.sort((a, b) => a - b);
  const p95 = batches[Math.floor(batches.length * 0.95)]!;
  // The plan's budget is for Hermes on a phone (p95 ≤ 3 ms per batch); Node on the dev machine is the guard.
  expect(p95).toBeLessThanOrEqual(3);
}, 600_000);

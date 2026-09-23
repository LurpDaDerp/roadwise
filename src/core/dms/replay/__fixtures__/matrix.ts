// The replay matrix runner shared by the scenario test files (split three ways so Jest runs them in
// parallel: the Task 12 suites have a 30 s wall-time budget in the default run).
//
// DMS_FULL=1 is a test-only switch, read only by the replay test files (never by the app, eas.json or any
// build): it runs 5 seeds and the long scenario lengths. The default runs seed 1.
import { DEFAULT_DMS_CONFIG, type DmsConfig } from '../../engine/config';
import { runScenario } from '../run';
import { REPLAY_FPS, SCENARIOS } from '../scenarios';
import { common, EXPECT } from './expectations';

export const FULL = process.env.DMS_FULL === '1';
const SEEDS = FULL ? [1, 2, 3, 4, 5] : [1];
const C = DEFAULT_DMS_CONFIG as DmsConfig;

/** Declares the matrix (every fps × both gaze sources × the seeds) for the named scenarios. */
export function matrix(names: readonly string[]): void {
  for (const name of names) expect(SCENARIOS.some((s) => s.name === name)).toBe(true);
  describe.each(SCENARIOS.filter((s) => names.includes(s.name)).map((s) => [s.name, s] as const))('%s', (name, sc) => {
    test.each(REPLAY_FPS.flatMap((fps) => (['geometric', 'net'] as const).flatMap((source) => SEEDS.map((seed) => [fps, source, seed] as const))))('%d fps, %s, seed %d', (fps, source, seed) => {
      const r = runScenario(sc, fps, source, seed, C, FULL);
      common(r);
      EXPECT[name]!(r, fps);
    });
  });
}

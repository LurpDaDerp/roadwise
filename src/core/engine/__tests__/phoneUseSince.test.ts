// The snapshot's `phoneUseSince` (drive-screen design §5.2): the confirmed phone episode's first use
// row while it is open and the drive records; null before confirmation, for parking-lot use, during
// a call, once the episode closes, and outside recording. The halo's distraction ramp reads it.
import { createDetectors } from '@/core/detectors';
import { limit, mph, seq, T0 } from '@/core/detectors/__fixtures__/rows';
import { createEngine } from '@/core/engine/machine';
import type { DetectorContext, FeatureRow } from '@/core/engine/types';

type Ctx = Omit<DetectorContext, 'warmupEndsAt'>;
const ANDROID: Ctx = { callActive: false, switchSignal: 'reliable', lockDelayMs: null, platform: 'android' };

const front = { speed: mph(35), appForeground: true, screenOn: true, locked: false } as const;
const tapped = { ...front, handlingScore: 0.9, gravityStability: 0.95, orientationDelta: 0.05 };
const parked = { ...front, speed: 0 };
const parkedTapped = { ...tapped, speed: 0 };

/** Run the rows; returns `phoneUseSince` after each row (relative seconds from T0), then after the end. */
async function sinceByRow(rows: FeatureRow[], ctx: () => Ctx = () => ANDROID) {
  let n = 0;
  const engine = createEngine({
    now: () => T0,
    newId: () => `id${(n += 1)}`,
    limits: { lookup: () => limit(mph(35)), prefetch: () => {} },
    createDetectors: () => createDetectors(() => `e${(n += 1)}`),
    ctx,
    onAlert: () => {},
    onCheckpoint: async () => {},
    onFinalize: async () => {},
  });
  const rel = (v: number | null) => (v === null ? null : (v - T0) / 1000);
  expect(engine.snapshot().phoneUseSince).toBeNull(); // idle
  await engine.dispatch({ type: 'start', ts: T0, continues: true });
  const out: (number | null)[] = [];
  for (const r of rows) {
    await engine.dispatch({ type: 'row', row: r });
    out.push(rel(engine.snapshot().phoneUseSince));
  }
  await engine.dispatch({ type: 'end', ts: rows.at(-1)!.ts + 1000 });
  const after = rel(engine.snapshot().phoneUseSince);
  return { out, after };
}

test('null until the third use row, then the first use row, for as long as the episode is open', async () => {
  const { out, after } = await sinceByRow(seq([10, front], [20, tapped], [10, front]));
  expect(out.slice(0, 12)).toEqual(Array(12).fill(null)); // rows 0-11: no use, then two unconfirmed use rows
  expect(out.slice(12, 30)).toEqual(Array(18).fill(10)); // confirmed on the 3rd use row: since row 10
  // two quiet rows close it
  const closedAt = out.findIndex((v, i) => i >= 30 && v === null);
  expect(closedAt).toBeGreaterThanOrEqual(30);
  expect(closedAt).toBeLessThanOrEqual(32);
  expect(out.slice(closedAt)).toEqual(Array(out.length - closedAt).fill(null));
  expect(after).toBeNull(); // idle again after the end
});

test('parking-lot use (the car has never moved) never shows', async () => {
  const { out } = await sinceByRow(seq([5, parked], [20, parkedTapped], [5, parked]));
  expect(out.every((v) => v === null)).toBe(true);
});

test('no use rows during a call: nothing shows', async () => {
  const { out } = await sinceByRow(seq([10, front], [20, tapped], [5, front]), () => ({ ...ANDROID, callActive: true }));
  expect(out.every((v) => v === null)).toBe(true);
});

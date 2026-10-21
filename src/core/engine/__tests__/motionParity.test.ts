// Motion access changes nothing but the walking end (product spec v3 "Ending on its own"): the same
// drives replayed through the real engine with no activity reports (motion not allowed), with only
// reports that are not on foot or not sure of it (allowed, never walking), and with the walk to the
// car reported before the first row (allowed, a drive that then reaches driving speed) end with the
// same closed session and publish the same snapshots. The drives are every replay trace plus the
// automatic end's idle tail and a manual end after standing still.
import type { MotionActivity } from '@drive-sense';

import { createDetectors } from '@/core/detectors';
import { limit, mph, row } from '@/core/detectors/__fixtures__/rows';
import type { EngineEvent, EngineSnapshot, TripSession } from '@/core/engine/engine.types';
import { createEngine } from '@/core/engine/machine';
import type { FeatureRow, LimitSample } from '@/core/engine/types';
import { TRACE_BUILDERS } from '@/core/replay/synth';
import { limitAt } from '@/core/replay/trace';

interface Scenario {
  name: string;
  rows: FeatureRow[];
  limitFor: (ts: number) => LimitSample;
  callActive: boolean;
  /** epoch ms of the manual end after the last row, or null to let the drive end by itself. */
  endAt: number | null;
}

const LAT = 47.6062;
const LNG = -122.3321;
const M_PER_DEG_LNG = ((6371008.8 * Math.PI) / 180) * Math.cos((LAT * Math.PI) / 180);
const T0 = 1_700_000_000_000;

/** `n` rows at `mps` from `t0`, `x0` metres east, then parked. */
function lifecycle(name: string, driveRows: number, parkedRows: number, endAt: number | null): Scenario {
  const rows: FeatureRow[] = [];
  let x = 0;
  for (let i = 0; i < driveRows + parkedRows; i += 1) {
    const mps = i < driveRows ? mph(30) : 0;
    rows.push(row({ ts: T0 + i * 1000, lat: LAT, lng: LNG + x / M_PER_DEG_LNG, speed: mps }));
    x += mps;
  }
  return { name, rows, limitFor: () => limit(mph(35)), callActive: false, endAt };
}

const scenarios: Scenario[] = [
  ...Object.entries(TRACE_BUILDERS).map(([name, build]) => {
    const t = build();
    return { name, rows: t.rows, limitFor: (ts: number) => limitAt(t.limits, ts), callActive: t.callActive === true, endAt: t.rows.at(-1)!.ts + 1000 };
  }),
  // The 15 min idle end, cut at the last movement.
  lifecycle('idle end', 60, 905, null),
  // A manual end 5 min after the last movement: cut.
  lifecycle('manual end after standing still', 60, 300, T0 + 360_000),
];

/** A deterministic PRNG (mulberry32), so a failure replays exactly. */
function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Reports that are not on foot, or not sure of it: every type but a confident walk or run, low walks and runs, EXITs. */
const NOT_ON_FOOT: readonly Omit<MotionActivity, 'ts'>[] = [
  ...(['automotive', 'stationary', 'cycling', 'unknown'] as const).flatMap((type) => (['low', 'medium', 'high'] as const).map((confidence) => ({ type, confidence }))),
  { type: 'walking', confidence: 'low' },
  { type: 'running', confidence: 'low' },
  { type: 'walking', confidence: 'high', exit: true },
  { type: 'running', confidence: 'high', exit: true },
];

type Variant = 'none' | 'notOnFoot' | 'walkToCar';

function events(s: Scenario, variant: Variant, seed: number): EngineEvent[] {
  const start = s.rows[0]!.ts;
  const out: EngineEvent[] = [{ type: 'start', ts: start, origin: 'manual', continues: false }];
  if (variant === 'walkToCar') out.push({ type: 'motion', activity: { type: 'walking', confidence: 'high', ts: start - 45_000 }, ts: start });
  const next = rng(seed);
  for (const r of s.rows) {
    out.push({ type: 'row', row: r });
    if (variant === 'notOnFoot' && next() < 0.2) {
      const pick = NOT_ON_FOOT[Math.floor(next() * NOT_ON_FOOT.length)]!;
      out.push({ type: 'motion', activity: { ...pick, ts: r.ts - Math.floor(next() * 30_000) }, ts: r.ts + 500 });
    }
  }
  if (s.endAt !== null) out.push({ type: 'end', ts: s.endAt });
  return out;
}

async function replay(s: Scenario, list: EngineEvent[]): Promise<{ finalized: Readonly<TripSession>[]; snapshots: EngineSnapshot[] }> {
  const finalized: Readonly<TripSession>[] = [];
  const snapshots: EngineSnapshot[] = [];
  let n = 0;
  let current = s.rows[0]!.ts;
  const engine = createEngine({
    now: () => current,
    newId: () => `id${(n += 1)}`,
    limits: { lookup: () => s.limitFor(current), prefetch: () => {} },
    createDetectors: () => createDetectors(() => `e${(n += 1)}`),
    ctx: () => ({}),
    onAlert: () => {},
    onCheckpoint: async () => {},
    onFinalize: async (closed) => {
      finalized.push(closed);
    },
    onCancel: async () => {},
  });
  engine.subscribe((snap) => snapshots.push(snap));
  for (const e of list) {
    if (e.type === 'row') current = e.row.ts;
    await engine.dispatch(e);
  }
  return { finalized, snapshots };
}

describe.each(scenarios)('$name', (s) => {
  test('ends with the same closed session and snapshots with and without motion access', async () => {
    const without = await replay(s, events(s, 'none', 1));
    expect(without.finalized).toHaveLength(1);
    expect(without.finalized[0]!.droveAt).not.toBeNull();
    for (const [variant, seed] of [
      ['notOnFoot', 7],
      ['notOnFoot', 1234],
      ['walkToCar', 1],
    ] as const) {
      const withMotion = await replay(s, events(s, variant, seed));
      expect(withMotion.finalized).toEqual(without.finalized);
      expect(withMotion.snapshots).toEqual(without.snapshots);
    }
  });
});

test('the replay covers every trace and both automatic-end scenarios, and the reports really interleave', () => {
  expect(scenarios.length).toBe(Object.keys(TRACE_BUILDERS).length + 2);
  const list = events(scenarios[0]!, 'notOnFoot', 7);
  expect(list.filter((e) => e.type === 'motion').length).toBeGreaterThan(20);
  expect(scenarios.find((s) => s.name === 'idle end')!.endAt).toBeNull();
});

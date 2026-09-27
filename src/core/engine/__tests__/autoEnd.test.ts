// DMS calib T14 (rev4 §2.13; rev5 §1, §4.1; controller amendment R5-1): the automatic ends of a recording trip, through
// the machine, with the drive host's per-row evidence. 1 Hz rows from T0; every end's trim and cause checked.
import { CONSTANTS } from '@scoring';
import { createArbiter } from '@/core/alerts/arbiter';
import { createDetectors } from '@/core/detectors';
import { T0, counterIds, limit, mph, row } from '@/core/detectors/__fixtures__/rows';
import { AUTO_END, validateAutoEnd } from '@/core/engine/autoEnd';
import type { RowEvidence, TripSession } from '@/core/engine/engine.types';
import { createEngine } from '@/core/engine/machine';
import { MOTION_CONSTANTS } from '@/core/engine/motionEvidence';
import type { FeatureRow } from '@/core/engine/types';

const { GAP_MERGE_S } = CONSTANTS;
const at = (s: number) => T0 + s * 1000;
const MIN = 60;

/** The host's evidence: a GNSS stop below 10 km/h (as the motion evidence reads it), nothing else by default. */
function ev(r: Partial<FeatureRow>, over: Partial<RowEvidence> = {}): RowEvidence {
  const speed = r.speed ?? 15;
  const known = (r.gnssValid ?? true) && speed >= 0;
  return {
    stop: known && speed * 3.6 < MOTION_CONSTANTS.STOP_KMH ? 'gnss' : null,
    vehicleMotion: false,
    ambiguousStill: false,
    mountLostS: 0,
    driverPresent: null,
    ...over,
  };
}

function harness() {
  const finalized: Readonly<TripSession>[] = [];
  const engine = createEngine({
    now: () => 0,
    newId: (() => {
      let n = 0;
      return () => `trip-${(n += 1)}`;
    })(),
    limits: { lookup: () => limit(mph(35)), prefetch: () => {} },
    createDetectors: () => createDetectors(counterIds()),
    createArbiter: () => createArbiter({ tripIndex: 10 }),
    onAlert: () => {},
    onCheckpoint: async () => {},
    onFinalize: async (s) => {
      finalized.push(s);
    },
    ctx: () => ({ night: false, precipitation: false, lockReliable: true, lockLagged: false }),
  });
  let s = 0;
  const statusAt: string[] = [];
  /** `n` rows from second `s`, each `rowOver(i)` with evidence `evOver(i)`; returns the second the status first became `until`, or null. */
  async function drive(n: number, rowOver: (i: number) => Partial<FeatureRow>, evOver: (i: number) => Partial<RowEvidence> = () => ({}), until?: string): Promise<number | null> {
    for (let k = 0; k < n; k++, s++) {
      const o = rowOver(s);
      const r = row({ ts: at(s), lat: 37.7749 + (o.lat ?? 0), lng: -122.4194 + (o.lng ?? 0), ...o, ...(o.lat !== undefined ? { lat: 37.7749 + o.lat } : {}), ...(o.lng !== undefined ? { lng: -122.4194 + o.lng } : {}) });
      await engine.dispatch({ type: 'row', row: r, evidence: ev(r, evOver(s)) });
      statusAt[s] = engine.snapshot().status;
      if (until !== undefined && engine.snapshot().status === until) {
        s++;
        return s - 1;
      }
    }
    return null;
  }
  return {
    engine,
    finalized,
    drive,
    now: () => s,
    statusAt,
    async start() {
      await engine.dispatch({ type: 'manualStart', mode: 'mounted', passenger: false, ts: at(0) });
    },
    async end() {
      await engine.dispatch({ type: 'end', ts: at(s) });
    },
    async tick(sec: number) {
      await engine.dispatch({ type: 'tick', ts: at(sec) });
    },
  };
}

const FAST = () => ({ speed: 15 });
const PARKED = () => ({ speed: 0 });
/** walking with the phone in the hand: 1.3 m/s, gait (0.2 g), handled; the position moves ~1.3 m a second */
const WALK_HAND = (i: number) => ({ speed: 1.3, accRms: 0.2, handlingScore: 0.5, lng: (i * 1.3) / 88_000 });
/** in a pocket: gait, no handling */
const WALK_POCKET = (i: number) => ({ speed: 1.3, accRms: 0.2, handlingScore: 0, lng: (i * 1.3) / 88_000 });

describe('T14 constants (rev4 §2.13.7, rev5 §1)', () => {
  test('the defaults validate; each rule catches its violation', () => {
    const motion = { deepStillG: MOTION_CONSTANTS.DEEP_STILL_G, mountQuietG: MOTION_CONSTANTS.MOUNT_QUIET_G };
    expect(validateAutoEnd(AUTO_END, motion)).toEqual([]);
    expect(validateAutoEnd({ ...AUTO_END, STANDSTILL_END_UNKNOWN_S: 500 }, motion).join()).toMatch(/STANDSTILL_END_UNKNOWN_S/);
    expect(validateAutoEnd({ ...AUTO_END, PEDESTRIAN_END_S: 60 }, motion).join()).toMatch(/PEDESTRIAN_END_S/);
    expect(validateAutoEnd({ ...AUTO_END, WALK_RMS_G: 0.35 }, motion).join()).toMatch(/WALK_RMS_G/);
    expect(validateAutoEnd(AUTO_END, { ...motion, mountQuietG: 0.2 }).join()).toMatch(/MOUNT_QUIET_G/);
    expect(validateAutoEnd({ ...AUTO_END, HANDLING_MIN_S: 400 }, motion).join()).toMatch(/HANDLING_MIN_S/);
  });
});

describe('T14: the standstill, graded by presence (rev4 §2.13.2–3; NC-S1, NC-W8)', () => {
  test('S-END-CROSSING (NC-S1): a 14 min standstill with the driver present never ends', async () => {
    const h = harness();
    await h.start();
    await h.drive(60, FAST);
    expect(await h.drive(14 * MIN, PARKED, () => ({ driverPresent: true }), 'ending')).toBeNull();
  });

  test('S-END-CLOSURE: present for 35 min: ending at 30 min (standstill_present), a resume at 36 min merges; trimmed to the stop', async () => {
    const h = harness();
    await h.start();
    await h.drive(60, FAST);
    const e = await h.drive(35 * MIN, PARKED, () => ({ driverPresent: true }), 'ending');
    expect(e).toBe(60 + AUTO_END.STANDSTILL_END_PRESENT_S - 1);
    expect(h.engine.snapshot().endCause).toBe('standstill_present');
    await h.drive(36 * MIN + 60 - h.now(), PARKED, () => ({ driverPresent: true }));
    expect(h.engine.snapshot().status).toBe('ending');
    await h.drive(10, FAST);
    expect(h.engine.snapshot()).toMatchObject({ status: 'recording', clientTripId: 'trip-1' });
    await h.end();
    expect(h.finalized[0]!.gaps[0]!.fromTs).toBe(at(60)); // the stop's start
  });

  test('S-END-EMPTY: left mounted, the driver gone (absent from 3 min): ending at 10 min; single spikes and multipath runs never break it (NC-W8)', async () => {
    for (const variant of ['plain', 'spikes', 'multipath'] as const) {
      const h = harness();
      await h.start();
      await h.drive(60, FAST);
      const noise = (i: number): Partial<FeatureRow> => {
        const k = i - 60;
        if (variant === 'spikes' && k > 0 && k % 90 === 0) return { speed: 1.2 };
        if (variant === 'multipath' && k > 0 && k % 120 < 4) return { speed: 1.0 };
        return { speed: 0 };
      };
      const e = await h.drive(12 * MIN, noise, (i) => ({ driverPresent: i - 60 < 60 ? true : i - 60 < 180 ? null : false }), 'ending');
      expect(e).toBe(60 + AUTO_END.STANDSTILL_END_EMPTY_S - 1);
      expect(h.engine.snapshot().endCause).toBe('standstill_empty');
    }
  });

  test('S-END-NOCAM: no DMS (presence unknown), a GNSS standstill: ending at 20 min', async () => {
    const h = harness();
    await h.start();
    await h.drive(60, FAST);
    expect(await h.drive(25 * MIN, PARKED, () => ({}), 'ending')).toBe(60 + AUTO_END.STANDSTILL_END_UNKNOWN_S - 1);
    expect(h.engine.snapshot().endCause).toBe('standstill_unknown');
  });

  test('S-END-NAP (stated): a reclined nap, the face out of view, no exit evidence: presence null, ending at 20 min', async () => {
    const h = harness();
    await h.start();
    await h.drive(60, FAST);
    const e = await h.drive(25 * MIN, PARKED, (i) => ({ driverPresent: i - 60 < 90 ? true : null }), 'ending');
    expect(e).toBe(60 + AUTO_END.STANDSTILL_END_UNKNOWN_S - 1);
  });

  test('a real move breaks the standstill: 5 rows ≥ 0.5 m/s, 3 with 10 m of displacement, 25 m of drift, or one strong row', async () => {
    const cases: [string, (k: number) => Partial<FeatureRow>, (k: number) => Partial<RowEvidence>][] = [
      ['5 rows', (k) => ({ speed: k >= 300 && k < 305 ? 1.0 : 0 }), () => ({})],
      ['3 rows + 12 m', (k) => ({ speed: k >= 300 && k < 303 ? 1.0 : 0, lng: k >= 300 ? 12 / 88_000 : 0 }), () => ({})],
      ['30 m', (k) => ({ speed: 0, lng: k >= 300 ? 30 / 88_000 : 0 }), () => ({})],
      ['a strong row', () => ({ speed: 0 }), (k) => ({ vehicleMotion: k === 300 })],
    ];
    for (const [, rowAt, evAt] of cases) {
      const h = harness();
      await h.start();
      await h.drive(60, FAST);
      // absent all along: 10 min from the standstill's start, unless broken at 300 s (then 10 min from there)
      const e = await h.drive(20 * MIN, (i) => rowAt(i - 60), (i) => ({ driverPresent: false, ...evAt(i - 60) }), 'ending');
      expect(e).toBeGreaterThan(60 + 300 + AUTO_END.STANDSTILL_END_EMPTY_S - 10);
    }
  });

  test('a deep still (U-4) with nobody known in the seat: 10 min (standstill_deep); a face keeps it to 30', async () => {
    const h = harness();
    await h.start();
    await h.drive(60, FAST);
    expect(await h.drive(15 * MIN, PARKED, () => ({ stop: 'deep' }), 'ending')).toBe(60 + AUTO_END.STANDSTILL_END_DEEP_S - 1);
    expect(h.engine.snapshot().endCause).toBe('standstill_deep');
    const h2 = harness();
    await h2.start();
    await h2.drive(60, FAST);
    expect(await h2.drive(15 * MIN, PARKED, () => ({ stop: 'deep', driverPresent: true }), 'ending')).toBeNull();
  });
});

describe('T14: no fix (rev4 §2.13.3; NC-S2)', () => {
  test('S-END-TUNNEL (NC-S2): a smooth no-fix tunnel of 25 min (AMBIGUOUS_STILL) never ends', async () => {
    const h = harness();
    await h.start();
    await h.drive(60, FAST);
    expect(await h.drive(25 * MIN, () => ({ gnssValid: false, speed: -1 }), () => ({ ambiguousStill: true, stop: null }), 'ending')).toBeNull();
  });

  test('AMBIGUOUS_STILL only for 30 min: ending (no_fix_ambiguous), trimmed to where it began', async () => {
    const h = harness();
    await h.start();
    await h.drive(60, FAST);
    const e = await h.drive(35 * MIN, () => ({ gnssValid: false, speed: -1 }), () => ({ ambiguousStill: true, stop: null }), 'ending');
    expect(e).toBe(60 + AUTO_END.NO_FIX_AMBIGUOUS_END_S - 1);
    expect(h.engine.snapshot().endCause).toBe('no_fix_ambiguous');
    await h.end();
    expect(h.finalized[0]!.endedAt).toBe(at(60));
  });

  test('S-END-RESUME-NOFIX: ending in a garage (sensor stop, absent), then driving out with no fix: the first strong row resumes', async () => {
    const h = harness();
    await h.start();
    await h.drive(60, FAST);
    await h.drive(11 * MIN, () => ({ gnssValid: false, speed: -1 }), () => ({ stop: 'sensor', driverPresent: false }), 'ending');
    expect(h.engine.snapshot().status).toBe('ending');
    await h.drive(3, () => ({ gnssValid: false, speed: -1 }), () => ({ stop: null }));
    expect(h.engine.snapshot().status).toBe('ending');
    await h.drive(1, () => ({ gnssValid: false, speed: -1 }), () => ({ stop: null, vehicleMotion: true }));
    expect(h.engine.snapshot()).toMatchObject({ status: 'recording', clientTripId: 'trip-1' });
  });
});

describe('T14: the pedestrian end (rev5 §1; NC-W5, NC-W9)', () => {
  test('S-END-CARRY (NC-W5): no motion permission, walked 10 min holding the phone: ending at 5 min, trimmed to the parking time', async () => {
    const h = harness();
    await h.start();
    await h.drive(60, FAST);
    await h.drive(30, PARKED);
    const e = await h.drive(10 * MIN, (i) => WALK_HAND(i - 90), () => ({}), 'ending');
    // 5 min of slow rows since the last movement (the 30 s parked count: gait is 90 % of the window)
    expect(e).toBe(60 + AUTO_END.PEDESTRIAN_END_S - 1);
    expect(h.engine.snapshot().endCause).toBe('pedestrian');
    await h.end();
    expect(h.finalized[0]).toMatchObject({ endedAt: at(60), durationS: 60, endCause: 'pedestrian' });
  });

  test('S-END-POCKET: in a pocket (gait, no handling, the mount lost ≥ 60 s): ending at 5 min', async () => {
    const h = harness();
    await h.start();
    await h.drive(60, FAST);
    const e = await h.drive(10 * MIN, (i) => WALK_POCKET(i - 60), (i) => ({ mountLostS: Math.max(0, i - 60) }), 'ending');
    expect(e).toBe(60 + AUTO_END.PEDESTRIAN_END_S - 1);
  });

  test('S-JAM-CRAWL: 30 min at 1–2 m/s, mounted (quiet, no gait): no end', async () => {
    const h = harness();
    await h.start();
    await h.drive(60, FAST);
    expect(await h.drive(30 * MIN, (i) => ({ speed: 1 + (i % 7) / 7, accRms: 0.04, lng: (i * 1.5) / 88_000 }), () => ({}), 'ending')).toBeNull();
  });

  test('S-JAM-HANDLED: a cupholder, no DMS, a 12 min crawl, one 20 s pick-up at 4 min: no end', async () => {
    const h = harness();
    await h.start();
    await h.drive(60, FAST);
    const crawl = (i: number): Partial<FeatureRow> => {
      const k = i - 60;
      const pick = k >= 240 && k < 260;
      return { speed: 1 + (k % 5) / 5, accRms: pick ? 0.2 : 0.05, handlingScore: pick ? 0.6 : 0, lng: (k * 1.5) / 88_000 };
    };
    expect(await h.drive(12 * MIN, crawl, () => ({}), 'ending')).toBeNull();
  });

  test('S-JAM-SAG (NC-W9): a mount sagging on a bumpy 12 min crawl (the mount lost, accRms 0.06–0.09): no end', async () => {
    const h = harness();
    await h.start();
    await h.drive(60, FAST);
    const crawl = (i: number): Partial<FeatureRow> => ({ speed: 1 + ((i - 60) % 5) / 5, accRms: 0.06 + ((i % 4) * 0.01), lng: ((i - 60) * 1.5) / 88_000 });
    expect(await h.drive(12 * MIN, crawl, (i) => ({ mountLostS: Math.max(0, i - 120) }), 'ending')).toBeNull();
  });

  test('a driver in the seat, or an automotive update, vetoes it', async () => {
    const h = harness();
    await h.start();
    await h.drive(60, FAST);
    expect(await h.drive(8 * MIN, (i) => WALK_HAND(i - 60), () => ({ driverPresent: true }), 'ending')).toBeNull();
    const h2 = harness();
    await h2.start();
    await h2.drive(60, FAST);
    await h2.drive(200, (i) => WALK_HAND(i - 60));
    await h2.engine.dispatch({ type: 'activity', automotive: true, walking: false, ts: at(h2.now()) });
    // the window must clear the automotive update: no end until 300 s after it
    const e = await h2.drive(8 * MIN, (i) => WALK_HAND(i - 60), () => ({}), 'ending');
    expect(e).toBeGreaterThanOrEqual(260 + AUTO_END.PEDESTRIAN_END_S - 1);
  });

  test('S-OLDROW-PED: old rows without accRms are never a pedestrian end', async () => {
    const h = harness();
    await h.start();
    await h.drive(60, FAST);
    expect(await h.drive(20 * MIN, (i) => ({ ...WALK_HAND(i - 60), accRms: undefined }), () => ({}), 'ending')).toBeNull();
  });
});

describe('T14: the catch-all (controller amendment R5-1; NC-W10)', () => {
  test('S-END-CARRY-OLD (NC-W10): old rows, no permission, carried away walking: ending 60 min after the last movement, trimmed to it', async () => {
    const h = harness();
    await h.start();
    await h.drive(60, FAST);
    const e = await h.drive(70 * MIN, (i) => ({ ...WALK_HAND(i - 60), accRms: undefined }), () => ({ stop: null }), 'ending');
    expect(e).toBe(58 + AUTO_END.NO_MOVEMENT_END_S); // the row that ends 60 min after the last fast row (second 59)
    expect(h.engine.snapshot().endCause).toBe('no_movement');
    await h.end();
    expect(h.finalized[0]!.endedAt).toBe(at(60));
  });

  test('S-JAM-60: a crawl at 1–2 m/s for over an hour ends at 60 min (reversible): the traffic moving again merges it', async () => {
    const h = harness();
    await h.start();
    await h.drive(60, FAST);
    const crawl = (i: number): Partial<FeatureRow> => ({ speed: 1 + (i % 7) / 7, accRms: 0.04, lng: (i * 1.5) / 88_000 });
    const e = await h.drive(65 * MIN, crawl, () => ({}), 'ending');
    expect(e).toBe(58 + AUTO_END.NO_MOVEMENT_END_S);
    expect(h.engine.snapshot().endCause).toBe('no_movement');
    await h.drive(3 * MIN, crawl);
    await h.drive(10, FAST);
    expect(h.engine.snapshot()).toMatchObject({ status: 'recording', clientTripId: 'trip-1' });
  });
});

describe('T14: the trim and the end cause (rev4 §2.13.5; NC-W7)', () => {
  test('a present 30 min standstill ends at its start; a walking end at the walk start; a pedestrian end at the last movement', async () => {
    const h = harness();
    await h.start();
    await h.drive(60, FAST);
    await h.drive(31 * MIN, PARKED, () => ({ driverPresent: true }), 'ending');
    await h.end();
    expect(h.finalized[0]).toMatchObject({ endedAt: at(60), endCause: 'standstill_present' });

    // NC-W7: the walking end trims to the walk's start (the host's walkStartTs), not the confirmation
    const w = harness();
    await w.start();
    await w.drive(60, FAST);
    await w.drive(40, PARKED);
    await w.drive(25, (i) => WALK_HAND(i - 100));
    await w.engine.dispatch({ type: 'activity', automotive: false, walking: true, ts: at(w.now()), walkStartTs: at(100) });
    expect(w.engine.snapshot().endCause).toBe('walking');
    await w.tick(w.now() + GAP_MERGE_S);
    expect(w.finalized[0]).toMatchObject({ endedAt: at(60), endCause: 'walking' });
  });

  test('End while recording is `manual`; End in an automatic `ending` keeps its cause', async () => {
    const h = harness();
    await h.start();
    await h.drive(10, FAST);
    await h.end();
    expect(h.finalized[0]!.endCause).toBe('manual');
    const g = harness();
    await g.start();
    await g.drive(60, FAST);
    await g.drive(11 * MIN, PARKED, () => ({ driverPresent: false }), 'ending');
    await g.end();
    expect(g.finalized[0]!.endCause).toBe('standstill_empty');
  });
});

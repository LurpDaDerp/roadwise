// Glances and D1–D4 (plan §M5): the angle-weighted buffer, VATS with its reset, the phone pattern and
// the unresponsive escalation, with speed gates, freezes and sensitivity. Every alert edge is tested one
// frame either side at 15 fps, with 5 and 30 fps copies for the headline edge.
import { DEFAULT_DMS_CONFIG, type DmsConfig, type ZoneId } from '../config';
import { createAttention, distractionGates, type AttentionEvent, type AttentionInput, type DistractionGates } from '../attention';
import { createContextTracker } from '../context';
import type { Sensitivity } from '../types';

const C = DEFAULT_DMS_CONFIG as DmsConfig;
const ALL: DistractionGates = { d1: true, d2: true, d3: true };

interface Seg {
  zone: ZoneId | null;
  frames: number;
  speed?: number | null;
  /** default: the speed is known when it is not null */
  speedKnown?: boolean;
  freeze?: boolean;
  headYawSpeedDegS?: number;
}

/** Runs segments at `fps` and returns every event, with the buffer after each frame. */
function run(segs: Seg[], opts: { fps?: number; sensitivity?: Sensitivity; gates?: DistractionGates } = {}) {
  const fps = opts.fps ?? 15;
  const dt = 1 / fps;
  const a = createAttention(C, opts.sensitivity ?? 'normal');
  const events: AttentionEvent[] = [];
  const buffer: number[] = [];
  let i = 0;
  for (const s of segs) {
    for (let k = 0; k < s.frames; k++, i++) {
      const input: AttentionInput = {
        tMs: i * 1000 * dt,
        dtS: i === 0 ? 0 : dt,
        zone: s.zone,
        headYawSpeedDegS: s.headYawSpeedDegS ?? 0,
        ruleSpeedKmh: s.speed === undefined ? 60 : s.speed,
        speedKnown: s.speedKnown ?? s.speed !== null,
        freeze: s.freeze ?? false,
        gates: opts.gates ?? ALL,
      };
      const out = a.onFrame(input);
      events.push(...out.events);
      buffer.push(out.bufferFraction);
    }
  }
  return { events, buffer, kinds: events.map((e) => e.kind) };
}
const warned = (segs: Seg[], o?: Parameters<typeof run>[1]) => run(segs, o).kinds.includes('d1_warning');
const road = (frames: number, over: Partial<Seg> = {}): Seg => ({ zone: 'road_centre', frames, ...over });

describe('D1 single-glance alert times (§M5), one frame either side', () => {
  // At 15 fps a frame is 1/15 s: n frames off-road drain n/15 s.
  test.each([
    ['centre_stack', 60, 45], // 3.0 s
    ['other', 60, 45],
    ['lap', 60, 36], // 2.4 s
    ['rear_mirror', 60, 60], // 4.0 s
    ['cluster', 60, 60],
    ['far_lateral', 60, 30], // 2.0 s
    ['centre_stack', 30, 90], // 6.0 s at 20–50 km/h
    ['lap', 30, 72], // 4.8 s
    ['driver_mirror', 30, 105], // 7.0 s
    ['far_lateral', 30, 60], // 4.0 s
  ] as [ZoneId, number, number][])('%s at %i km/h warns at frame %i, not one before', (zone, speed, n) => {
    expect(warned([road(3, { speed }), { zone, frames: n - 1, speed }])).toBe(false);
    expect(warned([road(3, { speed }), { zone, frames: n, speed }])).toBe(true);
  });
  test.each([
    [5, 15],
    [30, 90],
  ])('the centre-stack edge at %i fps', (fps, n) => {
    expect(warned([road(3), { zone: 'centre_stack', frames: n - 1 }], { fps })).toBe(false);
    expect(warned([road(3), { zone: 'centre_stack', frames: n }], { fps })).toBe(true);
  });
  test('a shoulder check (a far-lateral glance starting with the head > 100°/s): 3.0 s, and 5.0 s at 20–50', () => {
    expect(warned([road(3), { zone: 'far_lateral', frames: 44, headYawSpeedDegS: 150 }])).toBe(false);
    expect(warned([road(3), { zone: 'far_lateral', frames: 45, headYawSpeedDegS: 150 }])).toBe(true);
    expect(warned([road(3, { speed: 30 }), { zone: 'far_lateral', frames: 75, headYawSpeedDegS: 150, speed: 30 }])).toBe(true);
    expect(warned([road(3, { speed: 30 }), { zone: 'far_lateral', frames: 74, headYawSpeedDegS: 150, speed: 30 }])).toBe(false);
  });
  test('a far-lateral glance within 2 s of a mirror glance is a shoulder check too (C-18)', () => {
    const segs: Seg[] = [road(3), { zone: 'driver_mirror', frames: 10 }, road(15), { zone: 'far_lateral', frames: 44 }];
    expect(run(segs).kinds).not.toContain('d1_warning');
    const late: Seg[] = [road(3), { zone: 'driver_mirror', frames: 10 }, road(40), { zone: 'far_lateral', frames: 31 }];
    expect(run(late).kinds).toContain('d1_warning'); // 2.67 s later: plain far lateral, 2.0 s
  });
});

describe('refill, glance ends and re-arm', () => {
  test('a 90 ms return neither refills nor ends the glance (ADDW in-out-back-in)', () => {
    // 2.0 s of stack, one road frame (67 ms), then 1.0 s more of stack: 3.0 s in all → warns.
    const r = run([road(3), { zone: 'centre_stack', frames: 30 }, road(1), { zone: 'centre_stack', frames: 15 }]);
    expect(r.kinds).toContain('d1_warning');
    expect(r.kinds.filter((k) => k === 'glance_end')).toHaveLength(0);
  });
  test('the refill starts only after 100 ms on the road, at 1 s per second', () => {
    const r = run([road(3), { zone: 'centre_stack', frames: 30 }, road(2), road(15)]);
    const after2 = r.buffer[3 + 30 + 1]!; // two road frames: 133 ms, the first 100 ms held
    const drained = r.buffer[3 + 29]!;
    expect(after2 - drained).toBeCloseTo((0.1333 - 0.1) / 3, 3);
    expect(r.kinds).toContain('glance_end');
  });
  test('after a warning D1 re-arms only once the buffer is back to 50 %', () => {
    // 24 road frames = 1.6 s, 1.5 s of it refilled → exactly 50 %: re-armed, so the next glance
    // (starting from 50 %) warns again after 1.5 s.
    const r = run([road(3), { zone: 'centre_stack', frames: 45 }, road(24), { zone: 'centre_stack', frames: 45 }]);
    expect(r.kinds).toContain('d1_rearmed');
    expect(r.kinds.filter((k) => k === 'd1_warning')).toHaveLength(2);
    // 20 road frames: 1.23 s refilled → 41 %: not re-armed, so the next empty buffer is silent.
    const r2 = run([road(3), { zone: 'centre_stack', frames: 45 }, road(20), { zone: 'centre_stack', frames: 45 }]);
    expect(r2.kinds).not.toContain('d1_rearmed');
    expect(r2.kinds.filter((k) => k === 'd1_warning')).toHaveLength(1);
  });
  test('a change of B mid-glance keeps the fraction', () => {
    const r = run([road(3), { zone: 'centre_stack', frames: 15, speed: 60 }, { zone: 'centre_stack', frames: 1, speed: 30 }]);
    const before = r.buffer[3 + 14]!;
    const after = r.buffer[3 + 15]!;
    expect(before).toBeCloseTo(1 - 1 / 3, 3); // 1 s of 3
    expect(before - after).toBeCloseTo(1 / 15 / 6, 6); // the next frame drains against B = 6
  });
});

describe('gates and freezes', () => {
  test('below 20 km/h the buffer never drains; below 10 there are no alerts at all', () => {
    expect(warned([road(3, { speed: 19 }), { zone: 'centre_stack', frames: 200, speed: 19 }])).toBe(false);
    const r = run([road(3, { speed: 19 }), { zone: 'centre_stack', frames: 200, speed: 19 }]);
    expect(Math.min(...r.buffer)).toBe(1);
  });
  test('unknown speed (null) counts as below 10', () => {
    expect(warned([road(3, { speed: null }), { zone: 'centre_stack', frames: 200, speed: null }])).toBe(false);
  });
  test('occlusion (no zone) and a freeze (SEARCH, handling) hold the buffer', () => {
    const r = run([road(3), { zone: 'centre_stack', frames: 15 }, { zone: null, frames: 60 }, { zone: 'centre_stack', frames: 5, freeze: true }]);
    const at = r.buffer[3 + 14]!;
    expect(r.buffer[r.buffer.length - 1]).toBeCloseTo(at, 12);
    expect(r.kinds).not.toContain('d1_warning');
  });
  test('the D1 gate off: no drain', () => {
    expect(warned([road(3), { zone: 'centre_stack', frames: 100 }], { gates: { d1: false, d2: false, d3: false } })).toBe(false);
  });
  test('distractionGates: D1 needs a centre, the fps floor and no IMU-absent hold; D2 also calibration and no warm-up or resume check; D3 no warm-up', () => {
    const base = { hasCentre: true, warmup: false, calibState: 'calibrated' as const, resumeCheck: false, fpsOk: true, imuAbsentHold: false };
    expect(distractionGates(base)).toEqual({ d1: true, d2: true, d3: true });
    expect(distractionGates({ ...base, hasCentre: false })).toEqual({ d1: false, d2: false, d3: false });
    expect(distractionGates({ ...base, imuAbsentHold: true })).toEqual({ d1: false, d2: false, d3: false });
    expect(distractionGates({ ...base, fpsOk: false })).toEqual({ d1: false, d2: false, d3: false });
    expect(distractionGates({ ...base, warmup: true })).toEqual({ d1: true, d2: false, d3: false });
    expect(distractionGates({ ...base, calibState: 'seeded' })).toEqual({ d1: true, d2: true, d3: true });
    expect(distractionGates({ ...base, calibState: 'provisional' })).toEqual({ d1: true, d2: true, d3: true }); // T8 review m1
    expect(distractionGates({ ...base, calibState: 'uncalibrated' })).toEqual({ d1: true, d2: false, d3: true });
    expect(distractionGates({ ...base, resumeCheck: true })).toEqual({ d1: true, d2: false, d3: false });
  });
  test('sensitivity: low scales B by 1.15, capped at 3.5 s (≥ 50) — 3.45 s at 60 km/h; 6.0 s at 20–50', () => {
    expect(warned([road(3), { zone: 'centre_stack', frames: 51 }], { sensitivity: 'low' })).toBe(false); // 3.40 s
    expect(warned([road(3), { zone: 'centre_stack', frames: 52 }], { sensitivity: 'low' })).toBe(true); // 3.47 s ≥ 3.45
    expect(warned([road(3, { speed: 30 }), { zone: 'centre_stack', frames: 89, speed: 30 }], { sensitivity: 'low' })).toBe(false);
    expect(warned([road(3, { speed: 30 }), { zone: 'centre_stack', frames: 90, speed: 30 }], { sensitivity: 'low' })).toBe(true);
  });
});

describe('D2 (VATS, rev1 I1)', () => {
  const cycles = (off: number, on: number, n: number, zone: ZoneId = 'centre_stack', over: Partial<Seg> = {}): Seg[] => {
    const out: Seg[] = [road(3)];
    for (let i = 0; i < n; i++) out.push({ zone, frames: off, ...over }, road(on));
    return out;
  };
  test('1.5 s off / 2.5 s on never warns (each return resets)', () => {
    expect(run(cycles(22, 38, 12)).kinds).not.toContain('d2_warning');
  });
  test('1.5 s off / 1.9 s on warns when the sum reaches 10.0 s', () => {
    const r = run(cycles(22, 28, 8));
    const w = r.events.find((e) => e.kind === 'd2_warning')!;
    expect(w).toBeDefined();
    expect(r.kinds.filter((k) => k === 'd2_warning')).toHaveLength(1);
  });
  test('a return of 29 frames (1.93 s) does not reset; 30 frames (2.0 s) does', () => {
    expect(run(cycles(22, 29, 8)).kinds).toContain('d2_warning');
    expect(run(cycles(22, 30, 8)).kinds).not.toContain('d2_warning');
  });
  test('mirrors, the cluster and shoulder checks never count', () => {
    expect(run(cycles(22, 28, 10, 'rear_mirror')).kinds).not.toContain('d2_warning');
    expect(run(cycles(22, 28, 10, 'cluster')).kinds).not.toContain('d2_warning');
    expect(run(cycles(22, 28, 10, 'far_lateral', { headYawSpeedDegS: 150 })).kinds).not.toContain('d2_warning');
  });
  test('D2 off by its gate', () => {
    expect(run(cycles(22, 28, 10), { gates: { d1: true, d2: false, d3: true } }).kinds).not.toContain('d2_warning');
  });
});

describe('D3 phone pattern', () => {
  const lapGlances = (n: number, gapFrames: number): Seg[] => {
    const out: Seg[] = [road(3)];
    for (let i = 0; i < n; i++) out.push({ zone: 'lap', frames: 15 }, road(gapFrames)); // 1.0 s each
    return out;
  };
  test('three 1.0 s lap glances within 30 s → one advisory; none again within 10 min', () => {
    const r = run(lapGlances(3, 60));
    expect(r.kinds.filter((k) => k === 'd3_phone_pattern')).toHaveLength(1);
    const r2 = run(lapGlances(9, 60));
    expect(r2.kinds.filter((k) => k === 'd3_phone_pattern')).toHaveLength(1);
  });
  test('glances whose starts are more than 30 s apart do not count together', () => {
    expect(run(lapGlances(3, 240)).kinds).not.toContain('d3_phone_pattern');
  });
  test('0.93 s of lap in a glance does not count', () => {
    const out: Seg[] = [road(3)];
    for (let i = 0; i < 3; i++) out.push({ zone: 'lap', frames: 14 }, road(60));
    expect(run(out).kinds).not.toContain('d3_phone_pattern');
  });
});

describe('D4 unresponsive', () => {
  test('no return to the road within 3.0 s of a D1 warning → Critical; a return in time → none', () => {
    const w = 45; // the warning frame
    expect(run([road(3), { zone: 'centre_stack', frames: w + 45 }]).kinds).toContain('d4_unresponsive');
    expect(run([road(3), { zone: 'centre_stack', frames: w + 44 }]).kinds).not.toContain('d4_unresponsive');
    expect(run([road(3), { zone: 'centre_stack', frames: w + 30 }, road(1), { zone: 'centre_stack', frames: 30 }]).kinds).not.toContain('d4_unresponsive');
  });
});

describe('LOST after a fast turn (C-8), as the zone classifier reports it', () => {
  test('far lateral drains at 1.5× (2.0 s at 60 km/h); occlusion (null) freezes', () => {
    expect(warned([road(3), { zone: 'far_lateral', frames: 30 }])).toBe(true);
    expect(warned([road(3), { zone: null, frames: 300 }])).toBe(false);
  });
});

describe('the tunnel rules end to end (rev1 I6): the context tracker feeding the rules', () => {
  const raw = (ts: number, speed: number, gnssValid: boolean) => ({
    ts, speed, course: 90, gnssValid, aLonMax: 0.02, aLonMin: -0.02, aLatMax: 0.03, aLatMin: -0.03, yawRateMax: 0.03, jerkMax: 0.05, gravityStability: 0.99, orientationDelta: 0.01, handlingScore: 0,
  });
  function drive(imuMoving: boolean) {
    const t = createContextTracker(C);
    const a = createAttention(C, 'normal');
    const kinds: string[] = [];
    // 5 s known at 72 km/h on the road, then 60 s without GNSS glancing at the stack.
    for (let i = 0; i < 65 * 15; i++) {
      const tMs = (i * 1000) / 15;
      if (i % 15 === 0) t.onRow(raw(tMs, tMs < 5000 ? 20 : -1, tMs < 5000), tMs, { imuMoving, localMinutes: 720, tripElapsedS: tMs / 1000 });
      const st = t.at(tMs);
      const out = a.onFrame({ tMs, dtS: i === 0 ? 0 : 1 / 15, zone: tMs < 60_000 ? 'road_centre' : 'centre_stack', headYawSpeedDegS: 0, ruleSpeedKmh: st.ruleSpeedKmh, speedKnown: st.speedKnown, freeze: false, gates: { d1: !st.imuAbsentHold, d2: true, d3: true } });
      kinds.push(...out.events.map((e) => e.kind));
    }
    return kinds;
  }
  test('60 s without GNSS while the IMU shows motion: D1 still drains at the last B (3.0 s at 72 km/h)', () => {
    expect(drive(true)).toContain('d1_warning');
  });
  test('60 s without GNSS and the IMU still: after 10 s the car counts as below 10 km/h (no alert)', () => {
    expect(drive(false)).not.toContain('d1_warning');
  });
});

describe('T8 review round 1', () => {
  test('I2: a D1 warning then 4 s of occlusion → no D4 (no alert from a LOST frame)', () => {
    expect(run([road(3), { zone: 'centre_stack', frames: 45 }, { zone: null, frames: 60 }]).kinds).not.toContain('d4_unresponsive');
  });
  test('I2: a warning, 1 s off-road, 2 s occluded, 2 s off-road → D4 once 3.0 s are OBSERVED off-road', () => {
    const r = run([road(3), { zone: 'centre_stack', frames: 45 }, { zone: 'centre_stack', frames: 15 }, { zone: null, frames: 30 }, { zone: 'centre_stack', frames: 30 }]);
    const d4 = r.events.find((e) => e.kind === 'd4_unresponsive');
    expect(d4).toBeDefined();
    // 1.0 s + 2.0 s observed: the 30th frame of the last segment, at (3 + 45 + 15 + 30 + 29) / 15 s.
    expect(d4!.tMs).toBeCloseTo(((3 + 45 + 15 + 30 + 29) * 1000) / 15, 6);
    expect(run([road(3), { zone: 'centre_stack', frames: 45 }, { zone: 'centre_stack', frames: 15 }, { zone: null, frames: 30 }, { zone: 'centre_stack', frames: 29 }]).kinds).not.toContain('d4_unresponsive');
  });
  test('I2: a warning, then a C-8 far-lateral loss (evidence) → D4', () => {
    expect(run([road(3), { zone: 'centre_stack', frames: 45 }, { zone: 'far_lateral', frames: 45 }]).kinds).toContain('d4_unresponsive');
  });
  test('m2: D3 is held by SEARCH or handling', () => {
    const out: Seg[] = [road(3)];
    for (let i = 0; i < 3; i++) out.push({ zone: 'lap', frames: 15, freeze: true }, road(60));
    expect(run(out).kinds).not.toContain('d3_phone_pattern');
  });
});

describe('T8 round-1 review R1-I1: a pending D4 persists below the alerting speed', () => {
  const warn: Seg[] = [road(3), { zone: 'centre_stack', frames: 45 }]; // D1 warning at 60 km/h
  test('decelerating to 8 km/h while still looking away → D4 fires at 3.0 s observed', () => {
    expect(run([...warn, { zone: 'centre_stack', frames: 45, speed: 8 }]).kinds).toContain('d4_unresponsive');
  });
  test('unknown speed never clears it → fires', () => {
    expect(run([...warn, { zone: 'centre_stack', frames: 45, speed: null }]).kinds).toContain('d4_unresponsive');
  });
  test('a KNOWN 5 km/h held for 5 s clears it', () => {
    const r = run([...warn, { zone: null, frames: 75, speed: 5 }, { zone: 'centre_stack', frames: 60, speed: 5 }]);
    expect(r.kinds).not.toContain('d4_unresponsive');
  });
  test('4 s at 8, one frame at 12, 2 s at 8: the low run restarts, so it is not cleared', () => {
    const r = run([...warn, { zone: null, frames: 60, speed: 8 }, { zone: null, frames: 1, speed: 12 }, { zone: null, frames: 30, speed: 8 }, { zone: 'centre_stack', frames: 45, speed: 8 }]);
    expect(r.kinds).toContain('d4_unresponsive');
  });
  test('nothing new STARTS below 10 km/h', () => {
    expect(run([road(3, { speed: 8 }), { zone: 'centre_stack', frames: 200, speed: 8 }]).kinds).not.toContain('d4_unresponsive');
  });
});

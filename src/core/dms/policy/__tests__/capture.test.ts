// The capture policy (plan "Budgets": capture states, caps, speed classes and unknown speed; Task 13 with
// rev1 I6/m9/m11 and rev2 R1-m1). Driven by a simulated host: rows at 1 Hz, evaluations every 100 ms.
import type { ThermalName } from '../../../../../modules/dms-vision/src/constants';
import { capturePolicySchema } from '../../../../../modules/dms-vision/src/wire';
import { createCapturePolicy, nativePolicy, STATE_TABLE, THERMAL_LADDER, type PolicyInput, type PolicyMotion, type PolicyOutput } from '../capture';
import { ABSENT, LOW_LIGHT, STOP_KMH, validatePolicyConstants } from '../constants';
import { createGate } from '../gate';

type Q = 'tracking' | 'head_only' | 'lost';
interface Seg {
  s: number;
  gate?: boolean;
  /** km/h; null = unknown (no fix); undefined = no row at all (stale rows) */
  speed?: number | null;
  noRows?: boolean;
  imuMoving?: boolean;
  handling?: boolean;
  quality?: Q;
  thermal?: ThermalName;
  lowPower?: boolean;
  battery?: number | null;
  charging?: boolean | null;
  setup?: boolean;
  /** the engine reports LOST because of low light (frame luma < 25) */
  lowLight?: boolean;
  /** Task C3: the engine reports LOST with no face box at all (not low light) */
  noFace?: boolean;
  /** Task C3: the row's motion evidence; undefined = none on the row (older paths, or missing) */
  motion?: PolicyMotion;
  /** C3 round 2: consecutive empty-seat probes that failed to resume (the host's count) */
  probeFailures?: number;
  gazeNetEvery?: 1 | 2;
}
interface Tick {
  t: number;
  out: PolicyOutput;
}

/** Runs segments; each keeps the previous segment's values unless it sets them. */
function sim(segs: Seg[], policy = createCapturePolicy()): Tick[] {
  const ticks: Tick[] = [];
  let t = 0;
  let cur: Required<Omit<Seg, 's' | 'speed' | 'noRows' | 'motion'>> & { speed: number | null; noRows: boolean; motion: PolicyMotion | undefined } = {
    gate: true,
    speed: 60,
    noRows: false,
    imuMoving: true,
    handling: false,
    quality: 'tracking',
    thermal: 'nominal',
    lowPower: false,
    battery: 80,
    charging: false,
    setup: false,
    lowLight: false,
    noFace: false,
    probeFailures: 0,
    motion: undefined,
    gazeNetEvery: 1,
  };
  let row: PolicyInput['row'] = null;
  let q: Q = 'tracking';
  let qSince = 0;
  for (const seg of segs) {
    cur = { ...cur, ...seg, noRows: seg.noRows ?? false, motion: 'motion' in seg ? seg.motion : cur.motion } as typeof cur;
    const end = t + seg.s * 1000;
    for (; t < end - 1e-6; t += 100) {
      if (t % 1000 === 0 && !cur.noRows) row = { tMs: t, speedKmh: cur.speed, imuMoving: cur.imuMoving, handling: cur.handling, ...(cur.motion === undefined ? {} : { motion: cur.motion }) };
      if (cur.quality !== q) {
        q = cur.quality;
        qSince = t;
      }
      const out = policy.next({
        tMs: t,
        gateOpen: cur.gate,
        row,
        quality: q,
        qualityForMs: t - qSince,
        thermal: cur.thermal,
        lowPower: cur.lowPower,
        batteryLevel: cur.battery,
        charging: cur.charging,
        setup: cur.setup,
        lostLowLight: cur.lowLight,
        lostNoFace: cur.noFace,
        absentProbeFailures: cur.probeFailures,
        gazeNetEvery: cur.gazeNetEvery,
      });
      ticks.push({ t, out });
    }
  }
  return ticks;
}
/** The output at time `s` seconds (the last evaluation at or before it). */
const at = (ticks: Tick[], s: number) => [...ticks].reverse().find((x) => x.t <= s * 1000 + 1e-6)!.out;
const last = (ticks: Tick[]) => ticks.at(-1)!.out;

describe('the state table (plan Budgets, as data)', () => {
  test('every state: its camera, its fps and its gaze net', () => {
    expect(STATE_TABLE).toEqual({
      OFF: { camera: false, fps: 0, gazeNet: false },
      PAUSED: { camera: false, fps: 0, gazeNet: false },
      SEARCH: { camera: true, fps: 5, gazeNet: false },
      SLEEP_WATCH: { camera: true, fps: 5, gazeNet: false },
      FULL: { camera: true, fps: 15, gazeNet: true },
      HEAD_ONLY_RUN: { camera: true, fps: 10, gazeNet: false },
      SETUP: { camera: true, fps: 15, gazeNet: true },
    });
  });
  test('the thermal ladder: 15 → 8 → landmarks only → off → dim', () => {
    expect(THERMAL_LADDER.map((l) => [l.level, l.fpsCap, l.gazeNet, l.dim])).toEqual([
      [0, 15, true, false],
      [1, 8, true, false],
      [2, 8, false, false],
      [3, 0, false, false],
      [4, 0, false, true],
    ]);
  });
});

describe('each state is reached', () => {
  test('gate closed → OFF (no session, fps 0)', () => {
    expect(last(sim([{ s: 3, gate: false }]))).toMatchObject({ action: 'off', state: 'OFF', fps: 0, gazeNet: false, reason: 'gate' });
  });
  test('≥ 20 km/h, TRACKING → FULL at 15 fps with the net, every gazeNetEvery frame', () => {
    expect(last(sim([{ s: 5, gazeNetEvery: 2 }]))).toMatchObject({ action: 'run', state: 'FULL', fps: 15, gazeNet: true, gazeNetEvery: 2 });
  });
  test('10–20 km/h → SLEEP_WATCH at 5 fps, no net', () => {
    expect(last(sim([{ s: 5, speed: 15 }]))).toMatchObject({ action: 'run', state: 'SLEEP_WATCH', fps: 5, gazeNet: false });
  });
  test('LOST > 2 s at ≥ 10 km/h → SEARCH at 5 fps (not at 1.9 s)', () => {
    const t = sim([{ s: 5 }, { s: 3, quality: 'lost' }]);
    expect(at(t, 6.9).state).toBe('FULL');
    expect(at(t, 7.1)).toMatchObject({ state: 'SEARCH', fps: 5, gazeNet: false });
  });
  test('phone handling → SEARCH', () => {
    expect(last(sim([{ s: 5 }, { s: 2, handling: true }])).state).toBe('SEARCH');
  });
  test('HEAD_ONLY ≥ 5 s at ≥ 20 km/h → HEAD_ONLY_RUN at 10 fps (not at 4.9 s)', () => {
    const t = sim([{ s: 5 }, { s: 6, quality: 'head_only' }]);
    expect(at(t, 9.9).state).toBe('FULL');
    expect(at(t, 10.1)).toMatchObject({ state: 'HEAD_ONLY_RUN', fps: 10, gazeNet: false });
  });
  test('SETUP (C2) at 15 fps with the net, for at most 120 s', () => {
    const t = sim([{ s: 130, speed: 0, setup: true }]);
    expect(at(t, 10)).toMatchObject({ state: 'SETUP', fps: 15, gazeNet: true, setupMode: true });
    expect(at(t, 119.9).state).toBe('SETUP');
    expect(at(t, 120.1).state).not.toBe('SETUP');
    expect(at(t, 120.1).setupMode).toBe(false);
  });
  test('the low-light suspend (T13 r1 m1, U-21): LOST in low light at ≥ 20 km/h for 60 s → PAUSED (reason low_light), not at 59 s', () => {
    const t = sim([{ s: 5 }, { s: 62, quality: 'lost', lowLight: true }]);
    expect(at(t, 5 + 59).state).not.toBe('PAUSED');
    expect(at(t, 5 + 60.5)).toMatchObject({ action: 'pause', state: 'PAUSED', reason: 'low_light', fps: 0 });
  });
});

describe('C3 (rev4 §2.1.4): no pause at a stop: SLEEP_WATCH at 5 fps, a cadence change, never a restart', () => {
  const noPause = (t: Tick[]) => t.every((x) => x.out.action === 'run');
  test('S-RED (NC-P1): a 45 s GNSS red light is STOPPED from its first row below 10 km/h, SLEEP_WATCH at 5 fps, never paused; 15 fps on the second row at ≥ 20', () => {
    const t = sim([{ s: 5, speed: 30 }, { s: 45, speed: 0 }, { s: 5, speed: 30 }]);
    expect(noPause(t)).toBe(true);
    expect(at(t, 4.9).stopped).toBe(false);
    expect(at(t, 5.05)).toMatchObject({ state: 'SLEEP_WATCH', fps: 5, gazeNet: false, stopped: true, action: 'run' });
    expect(at(t, 49.9)).toMatchObject({ state: 'SLEEP_WATCH', stopped: true });
    expect(at(t, 50.05)).toMatchObject({ stopped: false, fps: 5 });
    expect(at(t, 51.05)).toMatchObject({ state: 'FULL', fps: 15 });
  });
  test('S-STOPSIGN: a 3 s stop is STOPPED for 3 s and never paused', () => {
    const t = sim([{ s: 5, speed: 30 }, { s: 3, speed: 2 }, { s: 5, speed: 30 }]);
    expect(noPause(t)).toBe(true);
    expect(t.filter((x) => x.out.stopped).length).toBe(30);
  });
  test('S-GO-Q: 10 min of queue cycles (10 s at 20 km/h, then 3/10/20 s stops): never paused; 5 or 15 fps only', () => {
    const segs: Seg[] = [];
    for (let i = 0; segs.reduce((a, x) => a + x.s, 0) < 600; i++) segs.push({ s: 10, speed: 20 }, { s: [3, 10, 20][i % 3]!, speed: 0 });
    const t = sim(segs);
    expect(noPause(t)).toBe(true);
    expect(new Set(t.map((x) => x.out.fps))).toEqual(new Set([5, 15]));
  });
  test('a sensor stop (no fix, the evidence latched) is STOPPED: SLEEP_WATCH, no pause', () => {
    const t = sim([{ s: 5, speed: 50, motion: { stop: null, moving: 'strong', ambiguousStill: false } }, { s: 30, speed: null, imuMoving: false, motion: { stop: 'sensor', moving: null, ambiguousStill: false } }]);
    expect(at(t, 20)).toMatchObject({ state: 'SLEEP_WATCH', fps: 5, stopped: true, action: 'run' });
    expect(noPause(t)).toBe(true);
  });
  test('unknown speed never pauses, with or without IMU motion (rev2 R1-m1, kept)', () => {
    for (const imuMoving of [true, false]) {
      const t = sim([{ s: 5, speed: 30 }, { s: 3, speed: 5 }, { s: 60, speed: null, imuMoving }]);
      expect(t.every((x) => x.out.state !== 'PAUSED')).toBe(true);
    }
    expect(sim([{ s: 5, speed: 30 }, { s: 60, noRows: true }]).every((x) => x.out.state !== 'PAUSED')).toBe(true);
  });
});

describe('C3, the C1 round-1 carry: a row with no evidence holds the last evidence for rowStaleMs, then neither stopped nor moving', () => {
  const sensor: PolicyMotion = { stop: 'sensor', moving: null, ambiguousStill: false };
  test('a sensor stop is held for 3 s of rows without evidence, then not stopped (unknown)', () => {
    const t = sim([{ s: 5, speed: 50 }, { s: 5, speed: null, motion: sensor }, { s: 6, speed: null, motion: undefined }]);
    expect(at(t, 9.5).stopped).toBe(true);
    expect(at(t, 11.5).stopped).toBe(true); // the last evidence was on the row at 9 s: held to 12 s
    expect(at(t, 12.5).stopped).toBe(false);
  });
  test('absent evidence is not moving evidence: an absent pause holds through it (only a probe with a face, or real movement, resumes)', () => {
    const t = sim([{ s: 5, speed: 30 }, { s: 200, speed: null, quality: 'lost', noFace: true, motion: sensor }, { s: 10, speed: null, motion: undefined }]);
    expect(at(t, 200).reason).toBe('absent');
    expect(at(t, 214.5)).toMatchObject({ absent: true });
  });
});

describe('C3 S-ABSENT (rev4 §2.1.5, U-12): no one in the seat at a stop', () => {
  const empty: Seg = { s: 400, speed: 0, quality: 'lost', noFace: true };
  test('STOPPED with no face box for 3 min → PAUSED absent (not at 179 s); probes of 5 s every 30 s (NC-P3)', () => {
    const t = sim([{ s: 5, speed: 30 }, empty]);
    expect(at(t, 5 + 179).state).toBe('SLEEP_WATCH');
    expect(at(t, 5 + 180.5)).toMatchObject({ action: 'pause', state: 'PAUSED', reason: 'absent', absent: true });
    expect(at(t, 5 + 209.5)).toMatchObject({ state: 'PAUSED', reason: 'absent' });
    expect(at(t, 5 + 212)).toMatchObject({ action: 'run', state: 'SLEEP_WATCH', fps: 5, absent: true });
    expect(at(t, 5 + 216)).toMatchObject({ state: 'PAUSED', reason: 'absent' });
    expect(t.some((x) => x.out.cameraOff !== null)).toBe(false); // an empty seat is not the camera going off
  });
  test('a probe that sees a face resumes; so does moving evidence (a known 12 km/h, or the evidence moving)', () => {
    const face = sim([{ s: 5, speed: 30 }, { s: 212, speed: 0, quality: 'lost', noFace: true }, { s: 5, speed: 0, quality: 'tracking', noFace: false }]);
    expect(last(face)).toMatchObject({ action: 'run', state: 'SLEEP_WATCH', absent: false });
    const moved = sim([{ s: 5, speed: 30 }, { s: 190, speed: 0, quality: 'lost', noFace: true }, { s: 2, speed: 12 }]);
    expect(last(moved)).toMatchObject({ action: 'run', absent: false });
    const ev = sim([
      { s: 5, speed: 30 },
      { s: 190, speed: null, quality: 'lost', noFace: true, motion: { stop: 'sensor', moving: null, ambiguousStill: false } },
      { s: 2, motion: { stop: null, moving: 'weak', ambiguousStill: false } },
    ]);
    expect(last(ev)).toMatchObject({ action: 'run', absent: false });
  });
  test('ABSENT_REQUIRES_NO_BOX: HEAD_ONLY, LOST with a box, or LOST in the dark never arms it; moving never arms it', () => {
    expect(sim([{ s: 5, speed: 30 }, { s: 200, speed: 0, quality: 'head_only' }]).some((x) => x.out.reason === 'absent')).toBe(false);
    expect(sim([{ s: 5, speed: 30 }, { s: 200, speed: 0, quality: 'lost', noFace: false }]).some((x) => x.out.reason === 'absent')).toBe(false);
    expect(sim([{ s: 5, speed: 30 }, { s: 200, speed: 0, quality: 'lost', noFace: true, lowLight: true }]).some((x) => x.out.reason === 'absent')).toBe(false);
    expect(sim([{ s: 5, speed: 30 }, { s: 200, speed: 30, quality: 'lost', noFace: true }]).some((x) => x.out.reason === 'absent')).toBe(false);
  });
  test('a face in the 3 min restarts the count', () => {
    const t = sim([{ s: 5, speed: 30 }, { s: 100, speed: 0, quality: 'lost', noFace: true }, { s: 1, quality: 'tracking', noFace: false }, { s: 150, quality: 'lost', noFace: true }]);
    expect(t.some((x) => x.out.reason === 'absent')).toBe(false);
  });
  test('every pause stays under native model release (the probe duty keeps the models warm)', () => {
    expect(ABSENT.probeEveryMs - ABSENT.probeForMs).toBeLessThan(300_000);
    expect(LOW_LIGHT.probeEveryMs - LOW_LIGHT.probeForMs).toBeLessThan(300_000);
  });
});

describe('C3 S-HEAT-STOP and S-DARK-STOP (rev4 §2.1.5): heat and dark at a stop', () => {
  test('S-HEAT-STOP (NC-P2): thermal L3 at a light → PAUSED thermal, and the heat edge is emitted once', () => {
    const t = sim([{ s: 5, speed: 30 }, { s: 10, speed: 0 }, { s: 5, speed: 0, thermal: 'critical' }]);
    expect(at(t, 15.05)).toMatchObject({ state: 'PAUSED', reason: 'thermal' });
    expect(t.filter((x) => x.out.cameraOff !== null).map((x) => [x.t, x.out.cameraOff])).toEqual([[15_000, 'heat']]);
  });
  test('S-DARK-STOP: LOST in the dark at a light for 60 s → PAUSED low_light with the dark edge; probes of 10 s every 60 s while stopped', () => {
    const t = sim([{ s: 5, speed: 30 }, { s: 200, speed: 0, quality: 'lost', lowLight: true, noFace: true }]);
    const suspendAt = t.find((x) => x.out.reason === 'low_light')!.t / 1000;
    expect(suspendAt).toBeGreaterThanOrEqual(65);
    expect(suspendAt).toBeLessThanOrEqual(66);
    expect(t.filter((x) => x.out.cameraOff !== null).map((x) => x.out.cameraOff)).toEqual(['dark']);
    expect(at(t, suspendAt + 59)).toMatchObject({ state: 'PAUSED', reason: 'low_light' });
    expect(at(t, suspendAt + 61)).toMatchObject({ action: 'run', state: 'SLEEP_WATCH', fps: 5 });
    expect(at(t, suspendAt + 71)).toMatchObject({ state: 'PAUSED', reason: 'low_light' });
  });
  test('LOST in the dark at 15 km/h suspends too (the suspend arms at any speed)', () => {
    expect(sim([{ s: 5, speed: 15 }, { s: 70, quality: 'lost', lowLight: true }]).some((x) => x.out.reason === 'low_light')).toBe(true);
  });
});

describe('speed classes: up on 2 rows at the threshold, down on 3 rows below threshold − 2 km/h', () => {
  test('SLEEP_WATCH → FULL on the second row at 20 km/h, not the first', () => {
    const t = sim([{ s: 5, speed: 15 }, { s: 3, speed: 20 }]);
    expect(at(t, 5.5).state).toBe('SLEEP_WATCH');
    expect(at(t, 6.05).state).toBe('FULL');
  });
  test('FULL → SLEEP_WATCH on the third row below 18 km/h; 19 km/h never drops it', () => {
    const t = sim([{ s: 5, speed: 30 }, { s: 4, speed: 17 }]);
    expect(at(t, 6.5).state).toBe('FULL');
    expect(at(t, 7.05).state).toBe('SLEEP_WATCH');
    expect(sim([{ s: 5, speed: 30 }, { s: 20, speed: 19 }]).slice(50).every((x) => x.out.state === 'FULL')).toBe(true);
  });
});

describe('unknown speed (rev1 I6): speed < 0 / no fix / a row older than 3 s', () => {
  test('with IMU motion the last known class holds for 10 min, then SLEEP_WATCH', () => {
    const t = sim([{ s: 5, speed: 60 }, { s: 610, speed: null, imuMoving: true }]);
    expect(at(t, 5 + 599).state).toBe('FULL');
    expect(at(t, 5 + 601).state).toBe('SLEEP_WATCH');
  });
  test('without IMU motion the class holds 10 s, then SLEEP_WATCH', () => {
    const t = sim([{ s: 5, speed: 60 }, { s: 15, speed: null, imuMoving: false }]);
    expect(at(t, 5 + 9.5).state).toBe('FULL');
    expect(at(t, 5 + 10.5).state).toBe('SLEEP_WATCH');
  });
  test('rows that stop arriving are unknown after 3 s (the IMU motion of the last row counts)', () => {
    const t = sim([{ s: 5, speed: 60, imuMoving: false }, { s: 20, noRows: true }]);
    expect(at(t, 5 + 12).state).toBe('FULL'); // the last row at 4 s is stale from 7 s; held 10 s to 17 s
    expect(at(t, 5 + 13.5).state).toBe('SLEEP_WATCH');
  });
});

describe('the thermal ladder and its dwells (rev1 m9)', () => {
  test('fair held 59 s → still 15 fps; 61 s → 8 fps, the net still on', () => {
    const t = sim([{ s: 5 }, { s: 62, thermal: 'fair' }]);
    expect(at(t, 5 + 59)).toMatchObject({ fps: 15, thermalLevel: 0 });
    expect(at(t, 5 + 61)).toMatchObject({ fps: 8, gazeNet: true, thermalLevel: 1 });
  });
  test('serious → at once 8 fps, landmarks only (the net off)', () => {
    expect(at(sim([{ s: 5 }, { s: 1, thermal: 'serious' }]), 5.05)).toMatchObject({ state: 'FULL', fps: 8, gazeNet: false, thermalLevel: 2 });
  });
  test('critical → at once PAUSED (reason thermal); dimAdvised after 120 s (L4), not at 119 s', () => {
    const t = sim([{ s: 5 }, { s: 125, thermal: 'critical' }]);
    expect(at(t, 5.05)).toMatchObject({ action: 'pause', state: 'PAUSED', reason: 'thermal', fps: 0, thermalLevel: 3, dimAdvised: false });
    expect(at(t, 5 + 119).dimAdvised).toBe(false);
    expect(at(t, 5 + 121).dimAdvised).toBe(true);
  });
  test('a cooler state applies only after holding 60 s (59 s: still hot)', () => {
    const t = sim([{ s: 5 }, { s: 10, thermal: 'serious' }, { s: 62, thermal: 'nominal' }]);
    expect(at(t, 15 + 59)).toMatchObject({ fps: 8, gazeNet: false });
    expect(at(t, 15 + 61)).toMatchObject({ fps: 15, gazeNet: true, thermalLevel: 0 });
  });
  test('critical cooling to serious: the camera stays off 60 s, then 8 fps', () => {
    const t = sim([{ s: 5 }, { s: 10, thermal: 'critical' }, { s: 62, thermal: 'serious' }]);
    expect(at(t, 15 + 59).state).toBe('PAUSED');
    expect(at(t, 15 + 61)).toMatchObject({ state: 'FULL', fps: 8, gazeNet: false });
  });
  test('T13 r1 I1 cameraOff: once, when a run goes to PAUSED for heat; not when already paused (C3: at a stop too)', () => {
    const t = sim([{ s: 5 }, { s: 5, thermal: 'critical' }]);
    expect(t.filter((x) => x.out.cameraOff !== null).map((x) => [x.t, x.out.cameraOff])).toEqual([[5000, 'heat']]);
    const parked = sim([{ s: 10, speed: 0 }, { s: 5, thermal: 'critical' }]);
    expect(parked.filter((x) => x.out.cameraOff !== null).map((x) => x.out.cameraOff)).toEqual(['heat']);
    const already = sim([{ s: 5 }, { s: 5, thermal: 'critical' }, { s: 5, speed: 0 }]);
    expect(already.filter((x) => x.out.cameraOff !== null)).toHaveLength(1);
  });
});

describe('the caps (lowest wins)', () => {
  test.each([
    ['Low Power Mode at FULL', { lowPower: true }, 8],
    ['battery 19 % not charging', { battery: 19 }, 8],
    ['battery 19 % charging', { battery: 19, charging: true }, 15],
    ['battery 20 %', { battery: 20 }, 15],
    ['battery unknown', { battery: null, charging: null }, 15],
  ] as const)('%s → %d fps', (_n, over, fps) => {
    expect(last(sim([{ s: 5 }, { s: 2, ...over }])).fps).toBe(fps);
  });
  test('the minimum of state and caps: HEAD_ONLY_RUN (10) at L1 → 8; SLEEP_WATCH (5) in Low Power → 5', () => {
    expect(last(sim([{ s: 5 }, { s: 70, thermal: 'fair' }, { s: 6, quality: 'head_only' }]))).toMatchObject({ state: 'HEAD_ONLY_RUN', fps: 8 });
    expect(last(sim([{ s: 5, speed: 15, lowPower: true }]))).toMatchObject({ state: 'SLEEP_WATCH', fps: 5 });
  });
});

describe('the preview (Privacy 6): only in SETUP while stationary (a known < 5 km/h for ≥ 3 s)', () => {
  test('stationary 3 s → allowed (not at 2.9 s); moving → not; outside setup → never', () => {
    const t = sim([{ s: 5, speed: 0, setup: true }]);
    expect(at(t, 2.9).previewAllowed).toBe(false);
    expect(at(t, 3.1).previewAllowed).toBe(true);
    expect(last(sim([{ s: 5, speed: 12, setup: true }])).previewAllowed).toBe(false);
    expect(sim([{ s: 10, speed: 0 }]).some((x) => x.out.previewAllowed)).toBe(false);
  });
});

describe('the native policy (the wrapper validates it: capturePolicySchema)', () => {
  test('run and pause map to a valid CapturePolicy with the token; OFF maps to null (the host stops native)', () => {
    const g = createGate(() => 'tok').gateOpen({ optedIn: true, cameraBeta: true, ageBand: '18_plus', driveActive: true, mode: 'mounted', role: 'driver', appActive: true }, 'granted');
    if (!g.open) throw new Error('closed');
    const tok = g.token;
    const run = nativePolicy(last(sim([{ s: 5, gazeNetEvery: 2 }])), tok);
    expect(capturePolicySchema.parse(run)).toEqual({ gateToken: 'tok', capture: 'run', fps: 15, gazeNet: true, gazeNetEvery: 2, setupMode: false, previewAllowed: false });
    const pause = nativePolicy(last(sim([{ s: 5 }, { s: 5, thermal: 'critical' }])), tok);
    expect(capturePolicySchema.parse(pause)).toMatchObject({ capture: 'pause' });
    expect(nativePolicy(last(sim([{ s: 2, gate: false }])), tok)).toBeNull();
  });
});

describe('T13 round 1: the camera-off edge and the low-light suspend (m1, U-21 defaults)', () => {
  test('cameraOff fires once for the low-light suspend at speed (dark); a stop is no camera-off (C3: nothing pauses)', () => {
    const dark = sim([{ s: 5 }, { s: 70, quality: 'lost', lowLight: true }]);
    const edges = dark.filter((x) => x.out.cameraOff !== null);
    expect(edges.map((x) => x.out.cameraOff)).toEqual(['dark']);
    expect(edges[0]!.t).toBeGreaterThanOrEqual(65_000);
    const stopped = sim([{ s: 5, speed: 30 }, { s: 12, speed: 0 }]);
    expect(stopped.some((x) => x.out.state === 'PAUSED')).toBe(false);
    expect(stopped.some((x) => x.out.cameraOff !== null)).toBe(false);
  });
  test('while suspended, a 10 s probe every 5 min at SLEEP_WATCH (5 fps), then PAUSED again', () => {
    const t = sim([{ s: 5 }, { s: 400, quality: 'lost', lowLight: true }]);
    const suspendAt = t.find((x) => x.out.reason === 'low_light')!.t / 1000;
    expect(at(t, suspendAt + 299).state).toBe('PAUSED');
    expect(at(t, suspendAt + 301)).toMatchObject({ action: 'run', state: 'SLEEP_WATCH', fps: 5 });
    expect(at(t, suspendAt + 311)).toMatchObject({ state: 'PAUSED', reason: 'low_light' });
    expect(t.filter((x) => x.out.cameraOff !== null)).toHaveLength(1); // a probe ending is not a new camera-off edge
  });
  test('a probe that sees a face resumes', () => {
    const t = sim([{ s: 5 }, { s: 366, quality: 'lost', lowLight: true }, { s: 20, quality: 'tracking', lowLight: false }]);
    expect(at(t, 380)).toMatchObject({ action: 'run', state: 'FULL' });
  });
  test('LOST without low light never suspends', () => {
    expect(sim([{ s: 5 }, { s: 70, quality: 'lost', lowLight: false }]).some((x) => x.out.reason === 'low_light')).toBe(false);
  });
  test('the numbers are validated', () => {
    expect(LOW_LIGHT).toEqual({ suspendAfterMs: 60_000, minSpeedKmh: 0, probeEveryMs: 300_000, probeEveryStoppedMs: 60_000, probeForMs: 10_000 });
    expect(ABSENT).toEqual({ afterMs: 180_000, probeEveryMs: 30_000, probeForMs: 5_000, requiresNoBox: true, backoffAfterFailures: 3, backoffProbeEveryMs: 300_000 });
    expect(STOP_KMH).toBe(10);
    expect(validatePolicyConstants(LOW_LIGHT)).toEqual([]);
    expect(validatePolicyConstants(LOW_LIGHT, { ...ABSENT, probeForMs: 30_000 })).toEqual([expect.stringMatching(/ABSENT.probeForMs/)]);
    expect(validatePolicyConstants({ ...LOW_LIGHT, probeEveryStoppedMs: 400_000 })).toEqual([expect.stringMatching(/probeEveryStoppedMs/)]);
    expect(validatePolicyConstants({ ...LOW_LIGHT, probeForMs: 300_000 })).toEqual(expect.arrayContaining([expect.stringMatching(/LOW_LIGHT.probeForMs/)]));
    expect(validatePolicyConstants({ ...LOW_LIGHT, suspendAfterMs: 0 })).toEqual([expect.stringMatching(/suspendAfterMs/)]);
  });
});

// C3 round 2 (review-C3 round 1, C3r1-m1): a persistent probe fault backs off.
describe('C3 round 2: after 3 consecutive failed empty-seat probes, one probe every 5 min', () => {
  const probesIn = (t: Tick[], fromS: number, toS: number) => {
    let n = 0;
    let prev = false;
    for (const x of t) {
      if (x.t < fromS * 1000 || x.t >= toS * 1000) continue;
      const on = x.out.absent && x.out.action === 'run';
      if (on && !prev) n++;
      prev = on;
    }
    return n;
  };
  const empty: Seg = { s: 900, speed: 0, quality: 'lost', noFace: true };
  test('with 3 failures, the probes come every 5 min (not every 30 s); fewer failures keep 30 s', () => {
    const backedOff = sim([{ s: 5, speed: 30 }, { ...empty, probeFailures: 3 }]);
    expect(probesIn(backedOff, 190, 790)).toBe(2);
    const normal = sim([{ s: 5, speed: 30 }, { ...empty, probeFailures: 2 }]);
    expect(probesIn(normal, 190, 790)).toBeGreaterThanOrEqual(19);
  });
  test('the numbers are validated (the back-off stays under the model release)', () => {
    expect(ABSENT.backoffAfterFailures).toBe(3);
    expect(ABSENT.backoffProbeEveryMs).toBe(300_000);
    expect(validatePolicyConstants(LOW_LIGHT, { ...ABSENT, backoffProbeEveryMs: 400_000 })).toEqual([expect.stringMatching(/backoffProbeEveryMs/)]);
  });
});

// The capture policy (plan "Budgets": capture states, caps, speed classes and unknown speed; Task 13 with
// rev1 I6/m9/m11 and rev2 R1-m1). Driven by a simulated host: rows at 1 Hz, evaluations every 100 ms.
import type { ThermalName } from '../../../../../modules/dms-vision/src/constants';
import { capturePolicySchema } from '../../../../../modules/dms-vision/src/wire';
import { createCapturePolicy, nativePolicy, STATE_TABLE, THERMAL_LADDER, type PolicyInput, type PolicyOutput } from '../capture';

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
  lowLight?: boolean;
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
  let cur: Required<Omit<Seg, 's' | 'speed' | 'noRows'>> & { speed: number | null; noRows: boolean } = {
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
    gazeNetEvery: 1,
  };
  let row: PolicyInput['row'] = null;
  let q: Q = 'tracking';
  let qSince = 0;
  for (const seg of segs) {
    cur = { ...cur, ...seg, noRows: seg.noRows ?? false } as typeof cur;
    const end = t + seg.s * 1000;
    for (; t < end - 1e-6; t += 100) {
      if (t % 1000 === 0 && !cur.noRows) row = { tMs: t, speedKmh: cur.speed, imuMoving: cur.imuMoving, handling: cur.handling };
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
        lowLightSuspend: cur.lowLight,
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
      CLOSURE_WATCH: { camera: true, fps: 5, gazeNet: false },
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
  test('10–20 km/h → CLOSURE_WATCH at 5 fps, no net', () => {
    expect(last(sim([{ s: 5, speed: 15 }]))).toMatchObject({ action: 'run', state: 'CLOSURE_WATCH', fps: 5, gazeNet: false });
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
  test('the low-light suspend window → PAUSED (reason low_light)', () => {
    expect(last(sim([{ s: 5 }, { s: 1, lowLight: true }]))).toMatchObject({ action: 'pause', state: 'PAUSED', reason: 'low_light', fps: 0 });
  });
});

describe('the pause (rev1 I6, T8 review m4: a KNOWN speed only)', () => {
  test('a known speed < 10 km/h for 5 s pauses (not at 4.9 s); the first row ≥ 10 km/h resumes', () => {
    const t = sim([{ s: 5, speed: 30 }, { s: 8, speed: 4 }, { s: 2, speed: 12 }]);
    expect(at(t, 9.9).state).toBe('CLOSURE_WATCH');
    expect(at(t, 10.1)).toMatchObject({ action: 'pause', state: 'PAUSED', reason: 'stopped' });
    expect(at(t, 13.05).state).toBe('CLOSURE_WATCH');
  });
  test('unknown speed with IMU motion resumes a pause; without motion the pause holds', () => {
    const moving = sim([{ s: 8, speed: 0 }, { s: 2, speed: null, imuMoving: true }]);
    expect(at(moving, 7.9).state).toBe('PAUSED');
    expect(last(moving).action).toBe('run');
    expect(last(sim([{ s: 8, speed: 0 }, { s: 5, speed: null, imuMoving: false }])).state).toBe('PAUSED');
  });
  test('rev2 R1-m1: the pause never happens on unknown speed, with or without IMU motion', () => {
    for (const imuMoving of [true, false]) {
      const t = sim([{ s: 5, speed: 30 }, { s: 3, speed: 5 }, { s: 60, speed: null, imuMoving }]);
      expect(t.filter((x) => x.t >= 8000).every((x) => x.out.state !== 'PAUSED')).toBe(true);
    }
    expect(sim([{ s: 5, speed: 30 }, { s: 60, noRows: true }]).every((x) => x.out.state !== 'PAUSED')).toBe(true);
  });
});

describe('speed classes: up on 2 rows at the threshold, down on 3 rows below threshold − 2 km/h', () => {
  test('CLOSURE_WATCH → FULL on the second row at 20 km/h, not the first', () => {
    const t = sim([{ s: 5, speed: 15 }, { s: 3, speed: 20 }]);
    expect(at(t, 5.5).state).toBe('CLOSURE_WATCH');
    expect(at(t, 6.05).state).toBe('FULL');
  });
  test('FULL → CLOSURE_WATCH on the third row below 18 km/h; 19 km/h never drops it', () => {
    const t = sim([{ s: 5, speed: 30 }, { s: 4, speed: 17 }]);
    expect(at(t, 6.5).state).toBe('FULL');
    expect(at(t, 7.05).state).toBe('CLOSURE_WATCH');
    expect(sim([{ s: 5, speed: 30 }, { s: 20, speed: 19 }]).slice(50).every((x) => x.out.state === 'FULL')).toBe(true);
  });
});

describe('unknown speed (rev1 I6): speed < 0 / no fix / a row older than 3 s', () => {
  test('with IMU motion the last known class holds for 10 min, then CLOSURE_WATCH', () => {
    const t = sim([{ s: 5, speed: 60 }, { s: 610, speed: null, imuMoving: true }]);
    expect(at(t, 5 + 599).state).toBe('FULL');
    expect(at(t, 5 + 601).state).toBe('CLOSURE_WATCH');
  });
  test('without IMU motion the class holds 10 s, then CLOSURE_WATCH', () => {
    const t = sim([{ s: 5, speed: 60 }, { s: 15, speed: null, imuMoving: false }]);
    expect(at(t, 5 + 9.5).state).toBe('FULL');
    expect(at(t, 5 + 10.5).state).toBe('CLOSURE_WATCH');
  });
  test('rows that stop arriving are unknown after 3 s (the IMU motion of the last row counts)', () => {
    const t = sim([{ s: 5, speed: 60, imuMoving: false }, { s: 20, noRows: true }]);
    expect(at(t, 5 + 12).state).toBe('FULL'); // the last row at 4 s is stale from 7 s; held 10 s to 17 s
    expect(at(t, 5 + 13.5).state).toBe('CLOSURE_WATCH');
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
  test('stopAlerts: once, on the evaluation where L3 turns the camera off at speed (T11 m1 carry); not when already paused', () => {
    const t = sim([{ s: 5 }, { s: 5, thermal: 'critical' }]);
    expect(t.filter((x) => x.out.stopAlerts).map((x) => x.t)).toEqual([5000]);
    const parked = sim([{ s: 10, speed: 0 }, { s: 5, thermal: 'critical' }]);
    expect(parked.some((x) => x.out.stopAlerts)).toBe(false);
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
  test('the minimum of state and caps: HEAD_ONLY_RUN (10) at L1 → 8; CLOSURE_WATCH (5) in Low Power → 5', () => {
    expect(last(sim([{ s: 5 }, { s: 70, thermal: 'fair' }, { s: 6, quality: 'head_only' }]))).toMatchObject({ state: 'HEAD_ONLY_RUN', fps: 8 });
    expect(last(sim([{ s: 5, speed: 15, lowPower: true }]))).toMatchObject({ state: 'CLOSURE_WATCH', fps: 5 });
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
    const run = nativePolicy(last(sim([{ s: 5, gazeNetEvery: 2 }])), 'tok');
    expect(capturePolicySchema.parse(run)).toEqual({ gateToken: 'tok', capture: 'run', fps: 15, gazeNet: true, gazeNetEvery: 2, setupMode: false, previewAllowed: false });
    const pause = nativePolicy(last(sim([{ s: 12, speed: 0 }])), 'tok');
    expect(capturePolicySchema.parse(pause)).toMatchObject({ capture: 'pause' });
    expect(nativePolicy(last(sim([{ s: 2, gate: false }])), 'tok')).toBeNull();
  });
});

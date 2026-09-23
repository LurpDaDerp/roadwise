// Conditioning (plan §M1–§M2, §M6): smoothing per quality run, frames of reference, the gaze source
// per frame (gaze / held / head / none), openness with hysteresis, the looking-down gate.
import { DEFAULT_DMS_CONFIG, resolveDmsConfig, type DmsConfig } from '../config';
import { createConditioner, type ConditionerRefs } from '../conditioning';
import { classifyQuality } from '../quality';
import { frame, type FrameSpec } from '../__fixtures__/synth';

const C = DEFAULT_DMS_CONFIG as DmsConfig;
const REFS: ConditionerRefs = {
  driverSide: 'left',
  gazeSource: 'geometric',
  rollOffsetDeg: 0,
  gazeCentre: { yaw: 0, pitch: 0 },
  headCentre: { yaw: 0, pitch: 0 },
  openEyeEar: { r: 0.3, l: 0.3 },
  pitchReference: 0,
};

function run(specs: FrameSpec[], refs: Partial<ConditionerRefs> = {}, cfg = C) {
  const c = createConditioner(cfg);
  return specs.map((s) => {
    const f = frame(s);
    return c.step(f, classifyQuality(f, cfg), { ...REFS, ...refs });
  });
}
const at = (i: number, over: Partial<FrameSpec> = {}): FrameSpec => ({ tMs: i * 66.67, ...over });

describe('frames of reference', () => {
  test('LHD: a camera yaw of +10° (image right) is −10° in the driver frame, relative to the centre', () => {
    const [p] = run([at(0, { gaze: { yaw: 10, pitch: -3 } })], { gazeCentre: { yaw: -4, pitch: 1 } });
    expect(p!.source).toBe('gaze');
    expect(p!.gazeDrv!.yaw).toBeCloseTo(-10, 9);
    expect(p!.gazeRel!.yaw).toBeCloseTo(-6, 9);
    expect(p!.gazeRel!.pitch).toBeCloseTo(-4, 9);
  });
  test('RHD keeps the camera sign', () => {
    const [p] = run([at(0, { gaze: { yaw: 10, pitch: 0 } })], { driverSide: 'right' });
    expect(p!.gazeRel!.yaw).toBeCloseTo(10, 9);
  });
  test('the roll offset rotates the direction: under 90° of roll a camera yaw becomes a pitch', () => {
    const [p] = run([at(0, { gaze: { yaw: 10, pitch: 0 } })], { rollOffsetDeg: 90, driverSide: 'right' });
    expect(p!.gazeDrv!.yaw).toBeCloseTo(0, 9);
    expect(p!.gazeDrv!.pitch).toBeCloseTo(10, 9);
  });
  test('no centre yet → no relative gaze, but the driver-frame gaze is there', () => {
    const [p] = run([at(0, { gaze: { yaw: 5, pitch: 0 } })], { gazeCentre: null, headCentre: null });
    expect(p!.gazeRel).toBeNull();
    expect(p!.gazeDrv!.yaw).toBeCloseTo(-5, 9);
  });
});

describe('smoothing: a median of 3 per quality run', () => {
  test('a one-frame spike never reaches the output', () => {
    const yaws = [0, 0, 0, 30, 0, 0].map((y, i) => at(i, { gaze: { yaw: y, pitch: 0 } }));
    expect(run(yaws).map((p) => Math.round(p.gazeDrv!.yaw) + 0)).toEqual([0, 0, 0, 0, 0, 0]);
  });
  test('a quality change resets it (no mixing across runs)', () => {
    const specs = [
      at(0, { gaze: { yaw: 0, pitch: 0 } }),
      at(1, { gaze: { yaw: 0, pitch: 0 } }),
      at(2, { gaze: { yaw: 20, pitch: 0 }, head: { yaw: 45, pitch: 0, roll: 0 } }), // HEAD_ONLY
      at(3, { gaze: { yaw: 20, pitch: 0 } }), // TRACKING again: a fresh run
    ];
    const out = run(specs);
    expect(out[2]!.quality).toBe('head_only');
    expect(out[3]!.gazeDrv!.yaw).toBeCloseTo(-20, 9);
  });
});

describe('the gaze source per frame (§M2)', () => {
  test('HEAD_ONLY → the head relative to the head centre, with the +5° margin', () => {
    const [p] = run([at(0, { head: { yaw: 10, pitch: -2, roll: 0 }, blur: 5 })], { headCentre: { yaw: -3, pitch: 0 } });
    expect(p).toMatchObject({ quality: 'head_only', source: 'head', marginDeg: 5 });
    expect(p!.gazeRel!.yaw).toBeCloseTo(-7, 9);
    expect(p!.gazeRel!.pitch).toBeCloseTo(-2, 9);
    expect(p!.openness).toBeNull();
    expect(p!.eyesClosed).toBe(false);
  });
  test('LOST → none', () => {
    const [p] = run([at(0, { face: false })]);
    expect(p).toMatchObject({ quality: 'lost', source: 'none', gazeRel: null, eyesClosed: false });
  });
  test('eyes closed < 500 ms hold the last gaze; from 500 ms the head with the margin', () => {
    const specs: FrameSpec[] = [];
    for (let i = 0; i < 4; i++) specs.push(at(i, { gaze: { yaw: 12, pitch: 0 } }));
    for (let i = 4; i < 16; i++) specs.push(at(i, { gaze: { yaw: -30, pitch: 0 }, head: { yaw: 2, pitch: 0, roll: 0 }, ear: [0.05, 0.05] }));
    const out = run(specs);
    const closedAt = out.findIndex((p) => p.eyesClosed);
    expect(closedAt).toBe(4);
    const held = out.filter((p) => p.source === 'held');
    expect(held.length).toBeGreaterThan(0);
    for (const p of held) {
      expect(p.gazeRel!.yaw).toBeCloseTo(-12, 9);
      expect(p.closedMs).toBeLessThan(500);
    }
    const head = out.filter((p) => p.eyesClosed && p.source === 'head');
    expect(head.length).toBeGreaterThan(0);
    for (const p of head) {
      expect(p.closedMs).toBeGreaterThanOrEqual(500);
      expect(p.marginDeg).toBe(5);
      expect(p.gazeRel!.yaw).toBeCloseTo(-2, 9);
    }
  });
});

describe('openness and closure (§M6, C-22)', () => {
  test('openness = EAR / open-eye EAR per eye; closed ⇔ max(reliable) < 0.30; open again only > 0.45', () => {
    const ears: [number, number][] = [
      [0.3, 0.3],
      [0.089, 0.089], // 0.297: closed
      [0.12, 0.12], // 0.40: still closed (hysteresis)
      [0.136, 0.136], // 0.453: open
      [0.093, 0.093], // 0.31: not closed
    ];
    const out = run(ears.map((ear, i) => at(i, { ear })));
    expect(out.map((p) => p.eyesClosed)).toEqual([false, true, true, false, false]);
    expect(out[0]!.opennessR).toBeCloseTo(1, 12);
  });
  test('one closed and one open eye is open (the max); an unreliable eye is ignored', () => {
    // (A first open frame shows both irises: an eye counts for openness only with iris evidence, R1-I1.)
    const [, a] = run([at(0), at(1, { ear: [0.03, 0.3] })]);
    expect(a!.eyesClosed).toBe(false);
    const [, b] = run([at(0), at(1, { ear: [0.03, 0.3], eyeL: { sat: 0.5 } })]); // the open eye is glared out
    expect(b!.openness).toBeCloseTo(0.1, 12);
    expect(b!.eyesClosed).toBe(true);
  });
  test('past |yaw| 25° the near eye alone', () => {
    const [, p] = run([at(0), at(1, { head: { yaw: 30, pitch: 0, roll: 0 }, ear: [0.03, 0.3], eyeR: { widthPx: 40 }, eyeL: { widthPx: 20 } })]);
    expect(p!.openness).toBeCloseTo(0.1, 12);
    expect(p!.eyesClosed).toBe(true);
  });
  test('no open-eye EAR yet → no openness and no closure', () => {
    const [p] = run([at(0, { ear: [0.01, 0.01] })], { openEyeEar: null });
    expect(p!.openness).toBeNull();
    expect(p!.eyesClosed).toBe(false);
  });
});

describe('looking down (§M6 gate)', () => {
  test('relative gaze pitch below −15° once centred', () => {
    const out = run([at(0, { gaze: { yaw: 0, pitch: -16 } }), at(1, { gaze: { yaw: 0, pitch: -14 } })].map((s, i) => ({ ...s, tMs: i * 1000 })));
    expect(out.map((p) => p.lookingDown)).toEqual([true, false]);
  });
  test('before calibration, head pitch against the running-median reference (rev1 m6)', () => {
    const [p] = run([at(0, { head: { yaw: 0, pitch: -12, roll: 0 } })], { gazeCentre: null, headCentre: null, pitchReference: 4 });
    expect(p!.lookingDown).toBe(true);
    const [q] = run([at(0, { head: { yaw: 0, pitch: -10, roll: 0 } })], { gazeCentre: null, headCentre: null, pitchReference: 4 });
    expect(q!.lookingDown).toBe(false);
  });
});

describe('the net source (§M2, rev1 m11)', () => {
  const cfgNet = resolveDmsConfig({ gazeSource: 'net' });
  test('a frame without NET_RAN uses the last net value, corrected by the head change since', () => {
    const out = run(
      [
        at(0, { head: { yaw: 0, pitch: 0, roll: 0 }, net: { yaw: 8, pitch: -1 } }),
        at(1, { head: { yaw: 0, pitch: 0, roll: 0 }, net: { yaw: 8, pitch: -1 } }),
        at(2, { head: { yaw: 3, pitch: 1, roll: 0 }, net: null }),
      ],
      { gazeSource: 'net', driverSide: 'right' },
      cfgNet
    );
    expect(out[2]!.netFresh).toBe(false);
    // head smoothed over [0, 0, 3] → 0 for the median, so compare against the smoothed head change
    expect(out[2]!.netCam!.yaw).toBeCloseTo(8 + (out[2]!.headCam!.yaw - out[1]!.headCam!.yaw), 9);
    expect(out[1]!.netFresh).toBe(true);
  });
});

test('head yaw speed (driver frame, °/s)', () => {
  const out = run([0, 1, 2, 3, 4].map((i) => at(i, { head: { yaw: -i * 10, pitch: 0, roll: 0 } })));
  // camera −10°/frame at 15 fps → driver +150°/s (LHD), after the median settles
  expect(out[4]!.headYawSpeedDegS).toBeCloseTo(150, 0);
});

describe('closures as native emits them (T6 review C1)', () => {
  test('a 1.2 s closure of both eyes at 60 km/h stays TRACKING: eyesClosed, closedMs ≥ 1000, held → head', () => {
    const specs: FrameSpec[] = [];
    for (let i = 0; i < 5; i++) specs.push(at(i, { gaze: { yaw: 8, pitch: 0 } }));
    for (let i = 5; i < 5 + 19; i++) specs.push(at(i, { ear: [0.05, 0.05] })); // ≈ 1.27 s at 15 fps
    const out = run(specs);
    const closed = out.slice(5);
    expect(closed.every((p) => p.quality === 'tracking')).toBe(true);
    expect(closed.every((p) => p.eyesClosed)).toBe(true);
    expect(closed[closed.length - 1]!.closedMs).toBeGreaterThanOrEqual(1000);
    expect(closed[0]!.source).toBe('held');
    expect(closed[closed.length - 1]!.source).toBe('head');
  });
  test('a blink does not reset the head smoothing (it stays in the TRACKING run)', () => {
    const yaws = [0, 0, 0, 30, 0, 0];
    const out = run(yaws.map((y, i) => at(i, { head: { yaw: y, pitch: 0, roll: 0 }, ...(i === 3 || i === 4 ? { ear: [0.05, 0.05] as [number, number] } : {}) })));
    expect(out.map((p) => Math.round(p.headCam!.yaw) + 0)).toEqual([0, 0, 0, 0, 0, 0]);
  });
});

describe('dropouts (T6 review m2, m4)', () => {
  const cfgNet = resolveDmsConfig({ gazeSource: 'net' });
  test('the net extrapolation expires after 300 ms without NET_RAN: then the head with its margin', () => {
    const specs: FrameSpec[] = [at(0, { net: { yaw: 5, pitch: 0 } })];
    for (let i = 1; i < 8; i++) specs.push(at(i, { net: null }));
    const out = run(specs, { gazeSource: 'net' }, cfgNet);
    expect(out[4]!.netCam).not.toBeNull(); // 267 ms
    expect(out[5]!.netCam).toBeNull(); // 333 ms
    expect(out[5]!.source).toBe('head');
    expect(out[5]!.marginDeg).toBe(5);
  });
  test('the extrapolation window grows with gazeNetEvery at low rates (2 × every × interval)', () => {
    const specs: FrameSpec[] = [{ tMs: 0, net: { yaw: 5, pitch: 0 } }, { tMs: 125, net: null }, { tMs: 250, net: null }, { tMs: 375, net: null }, { tMs: 500, net: null }, { tMs: 625, net: null }];
    const out = run(specs, { gazeSource: 'net', gazeNetEvery: 2 }, cfgNet);
    expect(out[4]!.netCam).not.toBeNull(); // 500 ms = 2 × 2 × 125
    expect(out[5]!.netCam).toBeNull();
  });
  test('a closure after a HEAD_ONLY stretch never holds a gaze from before it', () => {
    const specs: FrameSpec[] = [];
    for (let i = 0; i < 4; i++) specs.push(at(i, { gaze: { yaw: 20, pitch: 0 } }));
    for (let i = 4; i < 20; i++) specs.push(at(i, { blur: 5 })); // HEAD_ONLY for ~1 s
    for (let i = 20; i < 23; i++) specs.push(at(i, { ear: [0.05, 0.05] }));
    const out = run(specs);
    expect(out.slice(20).some((p) => p.source === 'held')).toBe(false);
  });
});

describe('iris evidence in time (T6 round-1 review R1-I1)', () => {
  const LENS = { luma: 0.6, irisContrast: 2, irisIn: false };
  const frames = (n: number, from: number, over: Partial<FrameSpec>) => Array.from({ length: n }, (_, i) => at(from + i, over));
  test('a lens from the start (an iris never seen) is HEAD_ONLY throughout', () => {
    const out = run(frames(200, 0, { eyeR: LENS, eyeL: LENS, ear: [0.3, 0.3] }));
    expect(out.every((p) => p.quality === 'head_only' && p.reasons.includes('eyes_unreliable'))).toBe(true);
    expect(out.every((p) => p.openness === null)).toBe(true);
  });
  test('sunglasses put on mid-drive: TRACKING for 10 s after the last iris, then HEAD_ONLY', () => {
    const out = run([...frames(15, 0, {}), ...frames(180, 15, { eyeR: LENS, eyeL: LENS })]); // 1 s seen, then 12 s of lens
    const lastSeenT = out[14]!.tMs;
    for (const p of out.slice(15)) {
      expect({ t: p.tMs, q: p.quality }).toEqual({ t: p.tMs, q: p.tMs - lastSeenT <= 10_000 ? 'tracking' : 'head_only' });
    }
  });
  test('a 20 s closure that began while the iris was seen stays TRACKING and closed throughout (the episode hold)', () => {
    const out = run([...frames(15, 0, { gaze: { yaw: 4, pitch: 0 } }), ...frames(300, 15, { ear: [0.05, 0.05] })]);
    const closed = out.slice(15);
    expect(closed.every((p) => p.quality === 'tracking' && p.eyesClosed)).toBe(true);
    expect(closed[closed.length - 1]!.closedMs).toBeGreaterThanOrEqual(19_900);
  });
  test('the episode ends when the eye reopens: an iris-less open eye then counts the recency again', () => {
    const out = run([...frames(15, 0, {}), ...frames(200, 15, { ear: [0.05, 0.05] }), ...frames(15, 215, { eyeR: LENS, eyeL: LENS })]);
    // The reopening frame itself still ends the episode; from the next frame the last iris is > 10 s old.
    expect(out.slice(216).every((p) => p.quality === 'head_only')).toBe(true);
  });
});

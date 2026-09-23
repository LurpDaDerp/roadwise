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
    const [a] = run([at(0, { ear: [0.03, 0.3] })]);
    expect(a!.eyesClosed).toBe(false);
    const [b] = run([at(0, { ear: [0.03, 0.3], eyeL: { sat: 0.5 } })]); // the open eye is glared out
    expect(b!.openness).toBeCloseTo(0.1, 12);
    expect(b!.eyesClosed).toBe(true);
  });
  test('past |yaw| 25° the near eye alone', () => {
    const [p] = run([at(0, { head: { yaw: 30, pitch: 0, roll: 0 }, ear: [0.03, 0.3], eyeR: { widthPx: 40 }, eyeL: { widthPx: 20 } })]);
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

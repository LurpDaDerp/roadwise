// The geometric gaze (plan §M1a, rev2 R1-I1): head pose + the wire's iris offsets, computed in the
// engine. Includes the engine half of the hand-built oracle.
import { DEFAULT_DMS_CONFIG as C, resolveDmsConfig } from '../config';
import { eyeAngles, geometricGaze } from '../geometricGaze';
import { eye, frame } from '../__fixtures__/synth';

const RAD = Math.PI / 180;
const both = { r: true, l: true };

test('per eye: eyeYaw = asin(ox / K_EYE), eyePitch = asin(oy / K_EYE) × G_PITCH', () => {
  const a = eyeAngles(eye({ ox: 0.43 * Math.sin(10 * RAD), oy: 0.43 * Math.sin(-4 * RAD) }), C);
  expect(a.yaw).toBeCloseTo(10, 10);
  expect(a.pitch).toBeCloseTo(-4, 10);
  // Clamped at ±90°.
  expect(eyeAngles(eye({ ox: 1, oy: -1 }), C)).toEqual({ yaw: 90, pitch: -90 });
  // G_PITCH is engine config, tunable without a native build.
  const g = resolveDmsConfig({ geometric: { gPitch: 1.5 } });
  expect(eyeAngles(eye({ oy: 0.43 * Math.sin(4 * RAD) }), g).pitch).toBeCloseTo(6, 10);
});

test('the oracle: both irises displaced upward by 0.1 eye widths → geoPitch > headPitch; toward image right → geoYaw > headYaw', () => {
  const head = { yaw: 3, pitch: -2, roll: 0 };
  const up = frame({ tMs: 0, head, eyeR: { ox: 0, oy: 0.1 }, eyeL: { ox: 0, oy: 0.1 } });
  const g = geometricGaze(head, up, both, C)!;
  expect(g.pitch).toBeGreaterThan(head.pitch);
  expect(g.yaw).toBeCloseTo(head.yaw, 12);
  const right = frame({ tMs: 0, head, eyeR: { ox: 0.1, oy: 0 }, eyeL: { ox: 0.1, oy: 0 } });
  expect(geometricGaze(head, right, both, C)!.yaw).toBeGreaterThan(head.yaw);
});

test('geo = head + eye, averaged over reliable eyes weighted by corner width', () => {
  const head = { yaw: 5, pitch: 1, roll: 0 };
  const f = frame({
    tMs: 0,
    head,
    eyeR: { ox: 0.43 * Math.sin(10 * RAD), oy: 0, widthPx: 30 },
    eyeL: { ox: 0.43 * Math.sin(4 * RAD), oy: 0, widthPx: 10 },
  });
  const g = geometricGaze(head, f, both, C)!;
  expect(g.yaw).toBeCloseTo(5 + (10 * 30 + 4 * 10) / 40, 10);
  // Only the reliable eye counts.
  expect(geometricGaze(head, f, { r: false, l: true }, C)!.yaw).toBeCloseTo(9, 10);
  expect(geometricGaze(head, f, { r: false, l: false }, C)).toBeNull();
});

test('past |head yaw| 25° the near eye alone, and only if it is reliable', () => {
  const head = { yaw: 30, pitch: 0, roll: 0 };
  const f = frame({
    tMs: 0,
    head,
    eyeR: { ox: 0.43 * Math.sin(2 * RAD), widthPx: 35 },
    eyeL: { ox: 0.43 * Math.sin(-8 * RAD), widthPx: 15 },
  });
  expect(geometricGaze(head, f, both, C)!.yaw).toBeCloseTo(32, 10);
  expect(geometricGaze(head, f, { r: false, l: true }, C)).toBeNull(); // the far eye is never used alone
  const at25 = { yaw: 25, pitch: 0, roll: 0 };
  expect(geometricGaze(at25, f, both, C)!.yaw).toBeCloseTo(25 + (2 * 35 - 8 * 15) / 50, 10); // 25° itself still averages
});

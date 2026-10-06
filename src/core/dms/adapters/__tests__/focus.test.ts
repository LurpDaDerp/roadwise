// The scoring seam: DMS glances and drowsiness signs → DmsFocusSamples, one per take, oldest first, the queue
// bounded at 32, dropping the oldest glance and never a drowsiness sample.
import { DEFAULT_DMS_CONFIG, type DmsConfig } from '../../engine/config';
import { calibrationFactor, confidenceOf, createFocusQueue } from '../focus';

const C = DEFAULT_DMS_CONFIG as DmsConfig;
const info = { trackingShare: 1, calibration: 'calibrated' as const };

test('a non-driving glance of 2.0 s or more is a glance sample; 1.9 s, mirrors, the cluster and shoulder checks never are', () => {
  const q = createFocusQueue(C);
  q.glance({ endT: 10_000, durS: 2.5, zone: 'centre_stack', shoulderCheck: false }, info);
  q.glance({ endT: 20_000, durS: 1.9, zone: 'lap', shoulderCheck: false }, info);
  q.glance({ endT: 21_000, durS: 2.0, zone: 'lap', shoulderCheck: false }, info);
  q.glance({ endT: 30_000, durS: 4.0, zone: 'rear_mirror', shoulderCheck: false }, info);
  q.glance({ endT: 31_000, durS: 4.0, zone: 'driver_mirror', shoulderCheck: false }, info);
  q.glance({ endT: 32_000, durS: 4.0, zone: 'passenger_mirror', shoulderCheck: false }, info);
  q.glance({ endT: 40_000, durS: 4.0, zone: 'cluster', shoulderCheck: false }, info);
  q.glance({ endT: 50_000, durS: 4.0, zone: 'far_lateral', shoulderCheck: true }, info);
  expect(q.take()).toEqual({ kind: 'glance', glanceS: 2.5, q: 1, endT: 10_000, wideTurn: false, lowLight: false });
  expect(q.take()).toMatchObject({ kind: 'glance', glanceS: 2.0 }); // exactly 2 s counts (spec: "2 s or more")
  expect(q.take()).toBeNull();
});

test('a far-lateral glance is a wide turn; the phone screen, the lap and `other` are plain glances', () => {
  const q = createFocusQueue(C);
  q.glance({ endT: 1_000, durS: 3, zone: 'far_lateral', shoulderCheck: false }, info);
  q.glance({ endT: 2_000, durS: 3, zone: 'phone_screen', shoulderCheck: false }, info);
  q.glance({ endT: 3_000, durS: 3, zone: 'other', shoulderCheck: false }, info);
  expect(q.take()!.wideTurn).toBe(true);
  expect(q.take()!.wideTurn).toBe(false);
  expect(q.take()!.wideTurn).toBe(false);
});

test('q = the glance’s TRACKING share × the calibration factor (1 calibrated, 0.9 seeded, else 0.7)', () => {
  const q = createFocusQueue(C);
  q.glance({ endT: 10_000, durS: 3, zone: 'lap', shoulderCheck: false }, { trackingShare: 0.8, calibration: 'none' });
  q.glance({ endT: 20_000, durS: 3, zone: 'lap', shoulderCheck: false }, { trackingShare: 1, calibration: 'seeded' });
  q.glance({ endT: 30_000, durS: 3, zone: 'lap', shoulderCheck: false }, { trackingShare: 1.4, calibration: 'calibrated' });
  expect(q.take()!.q).toBeCloseTo(0.56, 9);
  expect(q.take()!.q).toBeCloseTo(0.9, 9);
  expect(q.take()!.q).toBe(1); // clamped share
  expect(calibrationFactor('uncalibrated')).toBe(0.7);
  expect(calibrationFactor('provisional')).toBe(0.9);
  expect(calibrationFactor('recalibrating')).toBe(0.9);
});

test('one per take, oldest first; a drowsiness sample carries its seconds, its end and the light', () => {
  const q = createFocusQueue(C);
  q.drowsiness(3, 5_000, true, info);
  q.glance({ endT: 10_000, durS: 3, zone: 'lap', shoulderCheck: false }, info);
  expect(q.take()).toEqual({ kind: 'drowsiness', glanceS: 3, q: 1, endT: 5_000, wideTurn: false, lowLight: true });
  q.drowsiness(3, 6_000, false, { trackingShare: 0.8, calibration: 'calibrated' });
  q.drowsiness(3, 7_000, false, { trackingShare: 1, calibration: 'none' });
  q.drowsiness(3, 8_000, false, { trackingShare: 1, calibration: 'calibrated', eyesDegraded: true });
  expect(q.take()!.kind).toBe('glance');
  expect(q.take()!.q).toBeCloseTo(0.8, 9); // a poorly tracked episode: below the 0.85 gate
  expect(q.take()!.q).toBeCloseTo(0.7, 9); // uncalibrated
  expect(q.take()!.q).toBe(0); // degraded eyes: never a drowsy event
  expect(confidenceOf({ trackingShare: 0.9, calibration: 'calibrated', eyesDegraded: true }, false)).toBeCloseTo(0.9, 9); // a glance is not an eye closure
});

test('bounded at 32: the oldest glance goes, never a drowsiness sample', () => {
  const q = createFocusQueue(C);
  q.drowsiness(1, 0, false, info);
  for (let i = 0; i < 40; i++) q.glance({ endT: i * 10_000, durS: 2 + (i + 1) / 100, zone: 'lap', shoulderCheck: false }, info);
  expect(q.size()).toBe(32);
  expect(q.take()!.kind).toBe('drowsiness');
  expect(q.take()!.glanceS).toBeCloseTo(2.1, 9); // 1 + 40 into 32: glances 1–9 (2.01…2.09) dropped
  for (let i = 0; i < 40; i++) q.drowsiness(1, i, false, info);
  expect(q.size()).toBeGreaterThanOrEqual(40); // drowsiness is never dropped
});

// The scoring seam: DMS glances and drowsiness signs → DmsFocusSamples, one per take, oldest first, the queue
// bounded at 32, dropping the oldest glance and never a drowsiness sample.
import { DEFAULT_DMS_CONFIG, type DmsConfig } from '../../engine/config';
import { calibrationFactor, createFocusQueue } from '../focus';

const C = DEFAULT_DMS_CONFIG as DmsConfig;
const info = { trackingShare: 1, calibration: 'calibrated' as const };

test('a non-driving glance longer than 2.0 s is a glance sample; 2.0 s, mirrors, the cluster and shoulder checks never are', () => {
  const q = createFocusQueue(C);
  q.glance({ endT: 10_000, durS: 2.5, zone: 'centre_stack', shoulderCheck: false }, info);
  q.glance({ endT: 20_000, durS: 2.0, zone: 'lap', shoulderCheck: false }, info);
  q.glance({ endT: 30_000, durS: 4.0, zone: 'rear_mirror', shoulderCheck: false }, info);
  q.glance({ endT: 31_000, durS: 4.0, zone: 'driver_mirror', shoulderCheck: false }, info);
  q.glance({ endT: 32_000, durS: 4.0, zone: 'passenger_mirror', shoulderCheck: false }, info);
  q.glance({ endT: 40_000, durS: 4.0, zone: 'cluster', shoulderCheck: false }, info);
  q.glance({ endT: 50_000, durS: 4.0, zone: 'far_lateral', shoulderCheck: true }, info);
  expect(q.take()).toEqual({ kind: 'glance', glanceS: 2.5, q: 1, endT: 10_000, wideTurn: false, lowLight: false });
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
  q.drowsiness(3, 5_000, true);
  q.glance({ endT: 10_000, durS: 3, zone: 'lap', shoulderCheck: false }, info);
  expect(q.take()).toEqual({ kind: 'drowsiness', glanceS: 3, q: 1, endT: 5_000, wideTurn: false, lowLight: true });
  expect(q.take()!.kind).toBe('glance');
});

test('bounded at 32: the oldest glance goes, never a drowsiness sample', () => {
  const q = createFocusQueue(C);
  q.drowsiness(1, 0, false);
  for (let i = 0; i < 40; i++) q.glance({ endT: i * 10_000, durS: 2 + (i + 1) / 100, zone: 'lap', shoulderCheck: false }, info);
  expect(q.size()).toBe(32);
  expect(q.take()!.kind).toBe('drowsiness');
  expect(q.take()!.glanceS).toBeCloseTo(2.1, 9); // 1 + 40 into 32: glances 1–9 (2.01…2.09) dropped
  for (let i = 0; i < 40; i++) q.drowsiness(1, i, false);
  expect(q.size()).toBeGreaterThanOrEqual(40); // drowsiness is never dropped
});

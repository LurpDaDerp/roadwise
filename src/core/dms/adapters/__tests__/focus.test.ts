// The scoring seam (plan §M10): DMS glances and drowsiness episodes → M1's CameraFocusSample, one per
// row, oldest first, the queue bounded at 32, dropping the oldest glance and never a drowsiness sample.
import { DEFAULT_DMS_CONFIG, type DmsConfig } from '../../engine/config';
import { createFocusQueue } from '../focus';

const C = DEFAULT_DMS_CONFIG as DmsConfig;
const info = { trackingShare: 1, calibrated: true, lastAlertStartT: null as number | null };

test('a non-driving glance longer than 2.0 s is a glance sample; 2.0 s, mirrors, the cluster and shoulder checks never are', () => {
  const q = createFocusQueue(C);
  q.glance({ endT: 10_000, durS: 2.5, zone: 'centre_stack', shoulderCheck: false }, info);
  q.glance({ endT: 20_000, durS: 2.0, zone: 'lap', shoulderCheck: false }, info);
  q.glance({ endT: 30_000, durS: 4.0, zone: 'rear_mirror', shoulderCheck: false }, info);
  q.glance({ endT: 40_000, durS: 4.0, zone: 'cluster', shoulderCheck: false }, info);
  q.glance({ endT: 50_000, durS: 4.0, zone: 'far_lateral', shoulderCheck: true }, info);
  expect(q.take()).toEqual({ kind: 'glance', glanceS: 2.5, q: 1, correctedWithinGrace: false });
  expect(q.take()).toBeNull();
});

test('q = the glance’s TRACKING share × (1 calibrated, else 0.7)', () => {
  const q = createFocusQueue(C);
  q.glance({ endT: 10_000, durS: 3, zone: 'lap', shoulderCheck: false }, { ...info, trackingShare: 0.8, calibrated: false });
  expect(q.take()!.q).toBeCloseTo(0.56, 9);
});

test('correctedWithinGrace: the glance ended within 1.5 s of a DMS alert start', () => {
  const q = createFocusQueue(C);
  q.glance({ endT: 10_000, durS: 3, zone: 'lap', shoulderCheck: false }, { ...info, lastAlertStartT: 8_600 });
  q.glance({ endT: 20_000, durS: 3, zone: 'lap', shoulderCheck: false }, { ...info, lastAlertStartT: 18_400 });
  expect(q.take()!.correctedWithinGrace).toBe(true);
  expect(q.take()!.correctedWithinGrace).toBe(false);
});

test('one per take, oldest first; a drowsiness sample carries its episode length', () => {
  const q = createFocusQueue(C);
  q.drowsiness(3);
  q.glance({ endT: 10_000, durS: 3, zone: 'lap', shoulderCheck: false }, info);
  expect(q.take()).toEqual({ kind: 'drowsiness', glanceS: 3, q: 1 });
  expect(q.take()!.kind).toBe('glance');
});

test('bounded at 32: the oldest glance goes, never a drowsiness sample', () => {
  const q = createFocusQueue(C);
  q.drowsiness(1);
  for (let i = 0; i < 40; i++) q.glance({ endT: i * 10_000, durS: 2 + (i + 1) / 100, zone: 'lap', shoulderCheck: false }, info);
  expect(q.size()).toBe(32);
  expect(q.take()).toEqual({ kind: 'drowsiness', glanceS: 1, q: 1 });
  expect(q.take()!.glanceS).toBeCloseTo(2.1, 9); // 1 + 40 into 32: glances 1–9 (2.01…2.09) dropped
  for (let i = 0; i < 40; i++) q.drowsiness(1);
  expect(q.size()).toBeGreaterThanOrEqual(40); // drowsiness is never dropped
});

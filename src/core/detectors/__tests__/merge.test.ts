import { mergeEvents } from '@/core/detectors/merge';
import type { DetectedEvent } from '@/core/engine/types';
import { T0 } from '../__fixtures__/rows';

const ev = (p: Partial<DetectedEvent> & Pick<DetectedEvent, 'id' | 'category'>): DetectedEvent => ({
  startedAt: T0,
  durationS: 5,
  q: 0.6,
  corrected: false,
  status: 'scored',
  measured: {},
  context: { night: false, precipitation: false },
  alertable: false,
  source: 'imu',
  ...p,
});
/** A span starting `s` seconds after T0. */
const at = (s: number, durationS: number) => ({ startedAt: T0 + s * 1000, durationS });

test('phone + overlapping camera focus → one phone event: max q, union span, source both', () => {
  const phone = ev({ id: 'p', category: 'phone', ...at(0, 5), q: 0.6, measured: { speedMps: 15 } });
  const focus = ev({
    id: 'f',
    category: 'focus',
    ...at(3, 3),
    q: 0.9,
    source: 'camera',
    alertable: true,
    measured: { glanceS: 3, focusKind: 'glance' },
  });
  const out = mergeEvents([phone, focus]);
  expect(out).toHaveLength(1);
  expect(out[0]).toMatchObject({
    id: 'p',
    category: 'phone',
    startedAt: T0,
    durationS: 6,
    q: 0.9,
    source: 'both',
    alertable: true,
    status: 'scored',
    measured: { speedMps: 15, glanceS: 3, focusKind: 'glance' },
  });
});

test('two overlapping phone events collapse into the higher-q one', () => {
  const a = ev({ id: 'p1', category: 'phone', ...at(0, 5), q: 0.6 });
  const b = ev({ id: 'p2', category: 'phone', ...at(4, 4), q: 0.9, source: 'os', alertable: true });
  expect(mergeEvents([a, b])).toEqual([{ ...b, startedAt: T0, durationS: 8, source: 'both' }]);
});

test('with equal q the earlier phone event is kept', () => {
  const a = ev({ id: 'p1', category: 'phone', ...at(0, 5) });
  const b = ev({ id: 'p2', category: 'phone', ...at(2, 5) });
  expect(mergeEvents([b, a])).toEqual([{ ...a, durationS: 7 }]);
});

test('touching intervals count as overlapping', () => {
  const a = ev({ id: 'p', category: 'phone', ...at(0, 5) });
  const f = ev({ id: 'f', category: 'focus', ...at(5, 2), source: 'camera' });
  expect(mergeEvents([a, f])).toMatchObject([{ id: 'p', durationS: 7, source: 'both' }]);
});

test('non-overlapping phone and focus events are untouched', () => {
  const a = ev({ id: 'p', category: 'phone', ...at(0, 3) });
  const f = ev({ id: 'f', category: 'focus', ...at(5, 2), source: 'camera' });
  expect(mergeEvents([a, f])).toEqual([a, f]);
});

test('other categories never merge, even when overlapping', () => {
  const p = ev({ id: 'p', category: 'phone', ...at(0, 5) });
  const b = ev({ id: 'b', category: 'braking', ...at(2, 1), q: 0.95 });
  const s = ev({ id: 's', category: 'speeding', ...at(0, 30), q: 0.9, source: 'gnss' });
  expect(mergeEvents([p, b, s])).toEqual([p, s, b]);
});

test('two focus events do not merge with each other', () => {
  const f1 = ev({ id: 'f1', category: 'focus', ...at(0, 3), source: 'camera' });
  const f2 = ev({ id: 'f2', category: 'focus', ...at(2, 3), source: 'camera' });
  expect(mergeEvents([f1, f2])).toEqual([f1, f2]);
});

test('a phone event absorbs every focus event it overlaps, whatever the input order', () => {
  const f1 = ev({ id: 'f1', category: 'focus', ...at(3, 3), q: 0.7, source: 'camera' });
  const f2 = ev({ id: 'f2', category: 'focus', ...at(5, 3), q: 0.95, source: 'camera' });
  const p = ev({ id: 'p', category: 'phone', ...at(0, 6) });
  const out = mergeEvents([f1, f2, p]);
  expect(out).toHaveLength(1);
  expect(out[0]).toMatchObject({ id: 'p', category: 'phone', startedAt: T0, durationS: 8, q: 0.95 });
});

test('status and corrected come from the kept event; alertable is recomputed from the merged q', () => {
  const stopped = ev({ id: 'p', category: 'phone', ...at(0, 5), status: 'possible', measured: { speedMps: 0 } });
  const focus = ev({ id: 'f', category: 'focus', ...at(1, 3), q: 0.9, source: 'camera', corrected: true, alertable: true });
  expect(mergeEvents([stopped, focus])).toMatchObject([
    { id: 'p', status: 'possible', corrected: false, q: 0.9, alertable: false },
  ]);
  const moving = ev({ id: 'p', category: 'phone', ...at(0, 5) });
  expect(mergeEvents([moving, focus])).toMatchObject([{ id: 'p', status: 'scored', q: 0.9, alertable: true }]);
});

test('the result is sorted by startedAt and the input is not mutated', () => {
  const later = ev({ id: 'b', category: 'braking', ...at(9, 1) });
  const earlier = ev({ id: 's', category: 'speeding', ...at(1, 10), source: 'gnss' });
  const input = [later, earlier];
  const snapshot = JSON.stringify(input);
  expect(mergeEvents(input).map((e) => e.id)).toEqual(['s', 'b']);
  expect(JSON.stringify(input)).toBe(snapshot);
});

test('an empty list stays empty', () => {
  expect(mergeEvents([])).toEqual([]);
});

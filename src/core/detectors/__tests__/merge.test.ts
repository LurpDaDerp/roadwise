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
    absorbedIds: ['f'],
    measured: { speedMps: 15, glanceS: 3, focusKind: 'glance' },
  });
});

test('two overlapping phone events collapse into the higher-q one', () => {
  const a = ev({ id: 'p1', category: 'phone', ...at(0, 5), q: 0.6 });
  const b = ev({ id: 'p2', category: 'phone', ...at(4, 4), q: 0.9, source: 'os', alertable: true });
  expect(mergeEvents([a, b])).toEqual([
    { ...b, startedAt: T0, durationS: 8, source: 'both', absorbedIds: ['p1'] },
  ]);
});

test('with equal q the earlier phone event is kept', () => {
  const a = ev({ id: 'p1', category: 'phone', ...at(0, 5) });
  const b = ev({ id: 'p2', category: 'phone', ...at(2, 5) });
  expect(mergeEvents([b, a])).toEqual([{ ...a, durationS: 7, absorbedIds: ['p2'] }]);
});

test('spans are half-open: touching intervals do not overlap, one millisecond of overlap does', () => {
  const a = ev({ id: 'p', category: 'phone', ...at(0, 5) });
  const touching = ev({ id: 'f', category: 'focus', ...at(5, 2), source: 'camera' });
  expect(mergeEvents([a, touching])).toEqual([a, touching]);
  const grazing = ev({ id: 'f', category: 'focus', startedAt: T0 + 4999, durationS: 2, source: 'camera' });
  expect(mergeEvents([a, grazing])).toMatchObject([
    { id: 'p', durationS: 6.999, source: 'both', absorbedIds: ['f'] },
  ]);
});

test('absorbed ids accumulate in absorption order, including what the absorbed event had absorbed', () => {
  const p = ev({ id: 'p', category: 'phone', ...at(0, 5), q: 0.6, absorbedIds: ['x'] });
  const p2 = ev({ id: 'p2', category: 'phone', ...at(3, 5), q: 0.9, absorbedIds: ['z'] });
  expect(mergeEvents([p, p2])).toMatchObject([{ id: 'p2', absorbedIds: ['z', 'p', 'x'] }]);
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
  expect(out[0]).toMatchObject({
    id: 'p',
    category: 'phone',
    startedAt: T0,
    durationS: 8,
    q: 0.95,
    absorbedIds: ['f1', 'f2'],
  });
});

test('only scored events merge: stopped phone use (possible) and a scored focus stay two events', () => {
  const stopped = ev({ id: 'p', category: 'phone', ...at(0, 5), status: 'possible', measured: { speedMps: 0 } });
  const focus = ev({ id: 'f', category: 'focus', ...at(1, 3), q: 0.9, source: 'camera', alertable: true });
  expect(mergeEvents([stopped, focus])).toEqual([stopped, focus]);
});

test('disputed and removed events pass through untouched', () => {
  const disputed = ev({ id: 'p', category: 'phone', ...at(0, 5), status: 'disputed' });
  const focus = ev({ id: 'f', category: 'focus', ...at(1, 3), q: 0.9, source: 'camera' });
  expect(mergeEvents([disputed, focus])).toEqual([disputed, focus]);
  const removed = ev({ id: 'p1', category: 'phone', ...at(0, 5), status: 'removed' });
  const phone = ev({ id: 'p2', category: 'phone', ...at(2, 5) });
  expect(mergeEvents([removed, phone])).toEqual([removed, phone]);
});

test('corrected comes from the kept event; alertable is recomputed from the merged q', () => {
  const phone = ev({ id: 'p', category: 'phone', ...at(0, 5) });
  const focus = ev({ id: 'f', category: 'focus', ...at(1, 3), q: 0.9, source: 'camera', corrected: true, alertable: true });
  expect(mergeEvents([phone, focus])).toMatchObject([
    { id: 'p', status: 'scored', corrected: false, q: 0.9, alertable: true, absorbedIds: ['f'] },
  ]);
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

test('drowsiness never merges with phone use: a different behaviour, not the same moment', () => {
  const phone = ev({ id: 'p', category: 'phone', ...at(0, 12), q: 0.9, measured: { speedMps: 15 } });
  const drowsy = ev({
    id: 'd',
    category: 'focus',
    ...at(5, 5),
    q: 0.9,
    source: 'camera',
    measured: { glanceS: 5, focusKind: 'drowsiness' },
  });
  expect(mergeEvents([drowsy, phone])).toEqual([phone, drowsy]);

  // The same overlap with a glance is the same moment, and still merges.
  const glance = ev({ ...drowsy, measured: { glanceS: 5, focusKind: 'glance' } });
  expect(mergeEvents([glance, phone])).toMatchObject([{ id: 'p', absorbedIds: ['d'] }]);
});

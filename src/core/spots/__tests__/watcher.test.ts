import { at } from '../__fixtures__/spots';
import { MPH_TO_MPS } from '../constants';
import type { WatchInput, WatchSpot } from '../types';
import { createSpotWatcher, nudgeLeadM } from '../watcher';

const MPH = MPH_TO_MPS;

function row(over: Partial<WatchInput> & { n?: number; e?: number } = {}): WatchInput {
  const { n = 0, e = 0, ...rest } = over;
  const p = at(n, e);
  return { ts: 0, lat: p.lat, lng: p.lng, hAcc: 5, gnssValid: true, speedMps: 35 * MPH, courseDeg: 0, recording: true, foreground: true, busy: false, speedingOver: false, ...rest };
}

function spot(id: string, n: number, e = 0, over: Partial<WatchSpot> = {}): WatchSpot {
  const p = at(n, e);
  return { id, kind: 'hard_brake', lat: p.lat, lng: p.lng, headingDeg: 0, ...over };
}

test('the lead: 12 s of road, held between 120 and 400 m', () => {
  expect([15, 25, 35, 45, 55, 65, 80].map((mph) => Math.round(nudgeLeadM(mph * MPH)))).toEqual([120, 134, 188, 241, 295, 349, 400]);
});

test('a spot ahead, heading its way, gives one nudge keyed by spot and row time', () => {
  const w = createSpotWatcher([spot('a', 150)]);
  expect(w.push(row({ ts: 1000 }))).toEqual({ key: 'a@1000', spotId: 'a', kind: 'hard_brake', at: 1000 });
});

test('once per spot per drive, at most 3 a drive, 60 s apart', () => {
  const once = createSpotWatcher([spot('a', 150)]);
  expect(once.push(row({ ts: 0 }))).not.toBeNull();
  expect(once.push(row({ ts: 120_000 }))).toBeNull();

  const four = createSpotWatcher([0, 1, 2, 3].map((k) => spot(`s${k}`, k * 2000 + 150)));
  const fired = [0, 1, 2, 3].map((k) => four.push(row({ ts: k * 61_000, n: k * 2000 })));
  expect(fired.map((x) => x?.spotId ?? null)).toEqual(['s0', 's1', 's2', null]);

  const gap = createSpotWatcher([spot('a', 150), spot('b', 2150)]);
  expect(gap.push(row({ ts: 0 }))?.spotId).toBe('a');
  expect(gap.push(row({ ts: 59_999, n: 2000 }))).toBeNull();
  expect(gap.push(row({ ts: 60_000, n: 2000 }))?.spotId).toBe('b');
});

test.each([
  ['heading 50° off', [spot('a', 150, 0, { headingDeg: 50 })], {}],
  ['35° off the course (not ahead)', [spot('a', 150 * Math.cos((35 * Math.PI) / 180), 150 * Math.sin((35 * Math.PI) / 180))], {}],
  ['60 m to the side', [spot('a', 180 * Math.cos((20 * Math.PI) / 180), 180 * Math.sin((20 * Math.PI) / 180))], {}],
  ['already inside (35 m)', [spot('a', 35)], {}],
  ['beyond the lead (200 m at 35 mph)', [spot('a', 200)], {}],
  ['behind the car', [spot('a', -150)], {}],
  ['at 9 mph', [spot('a', 100)], { speedMps: 9 * MPH }],
  ['a 25 m fix', [spot('a', 150)], { hAcc: 25 }],
  ['an invalid fix', [spot('a', 150)], { gnssValid: false }],
  ['no course', [spot('a', 150)], { courseDeg: null }],
  ['while waiting (not recording)', [spot('a', 150)], { recording: false }],
] as const)('no nudge: %s', (_, spots, over) => {
  expect(createSpotWatcher(spots).push(row(over as Partial<WatchInput>))).toBeNull();
});

test('behind RoadWise nothing shows and nothing is used up: it fires once in front', () => {
  const w = createSpotWatcher([spot('a', 150)]);
  expect(w.push(row({ ts: 0, foreground: false }))).toBeNull();
  expect(w.push(row({ ts: 1000, n: 10 }))?.spotId).toBe('a');
});

test('busy (an alert showing): nothing now, the next row fires', () => {
  const w = createSpotWatcher([spot('a', 150)]);
  expect(w.push(row({ ts: 0, busy: true }))).toBeNull();
  expect(w.push(row({ ts: 1000, n: 15 }))?.spotId).toBe('a');
});

test('a speeding spot while already over the line is spent silently and counts toward neither the 3 nor the gap', () => {
  const w = createSpotWatcher([spot('fast', 150, 0, { kind: 'speeding' }), spot('b', 2150), spot('c', 4150), spot('d', 6150)]);
  expect(w.push(row({ ts: 0, speedingOver: true }))).toBeNull();
  expect(w.push(row({ ts: 1000, n: 20 }))).toBeNull(); // spent
  expect(w.push(row({ ts: 2000, n: 2000 }))?.spotId).toBe('b'); // no gap owed
  expect(w.push(row({ ts: 63_000, n: 4000 }))?.spotId).toBe('c');
  expect(w.push(row({ ts: 124_000, n: 6000 }))?.spotId).toBe('d'); // the third shown
  // A brake spot while speeding still shows.
  const brake = createSpotWatcher([spot('a', 150)]);
  expect(brake.push(row({ speedingOver: true }))?.spotId).toBe('a');
});

test('the nearest of two qualifying spots wins', () => {
  const w = createSpotWatcher([spot('far', 160), spot('near', 100)]);
  expect(w.push(row())?.spotId).toBe('near');
  expect(w.push(row({ ts: 61_000 }))?.spotId).toBe('far');
});

import type { DriveEvent } from '@scoring';

import { drive, HOUR, NOW } from '@/features/drives/__fixtures__/drives';
import type { LocalDrive } from '@/data/queries/rows';

import { analyticsCopy } from '../copy';
import {
  pickupMomentOf,
  pickupSpeedOf,
  pickupTiming,
  pickupView,
  roadView,
  speedingByRoad,
  weatherSums,
  weatherView,
  type PickupTiming,
  type SpeedingByRoad,
  type WeatherSums,
} from '../insights';
import { bandIndex, rangeStart } from '../model';

const MIN = 60_000;
const buckets = (low: number, mid: number, high: number) => ({ low: { s: low, m: 0 }, mid: { s: mid, m: 0 }, high: { s: high, m: 0 } });

let n = 0;
function ev(over: Partial<DriveEvent>): DriveEvent {
  n += 1;
  return { id: `e${n}`, type: 'speeding', tier: 'minor', startedAt: NOW - 2 * HOUR + 5 * MIN, durationS: 10, status: 'active', measured: {}, ...over };
}
const speeding = (limitMph: number | undefined, durationS: number, over: Partial<DriveEvent> = {}) =>
  ev({ type: 'speeding', durationS, measured: limitMph === undefined ? {} : { limitMph, speedMph: limitMph + 10 }, ...over });
const pickup = (startedAt: number, speedMph: number | undefined, over: Partial<DriveEvent> = {}) =>
  ev({ type: 'phone_pickup', tier: 'moderate', startedAt, durationS: 4, measured: speedMph === undefined ? {} : { speedMph }, ...over });

// One 24-minute drive two hours ago (the fixture's), and an older one 3 days back.
const recent = drive({ clientTripId: 'r', limitBuckets: buckets(600, 300, 100) });
const old = drive({ clientTripId: 'o', startedAt: NOW - 72 * HOUR, endedAt: NOW - 72 * HOUR + 24 * MIN, limitBuckets: buckets(0, 0, 1000) });
const DAY_SINCE = rangeStart(NOW, 'day');

describe('speedingByRoad', () => {
  test('splits the seconds over the line by the limit broken, at the bucket edges 27/28 and 47/48 mph', () => {
    const events = [speeding(27, 10), speeding(28, 20), speeding(47, 30), speeding(48, 40)];
    const r = speedingByRoad([recent], events, null)!;
    expect(r.speeding).toEqual({ low: 10, mid: 50, high: 40 });
    expect(r.speedingS).toBe(100);
    expect(r.driving).toEqual({ low: 600, mid: 300, high: 100 });
  });

  test('a speeding episode counts at least 1 s, as the sheet does; one without a limit, removed ones and other types are left out', () => {
    const events = [speeding(25, 0), speeding(undefined, 30), speeding(35, 50, { status: 'removed' }), ev({ type: 'hard_brake', measured: { limitMph: 35 } })];
    expect(speedingByRoad([recent], events, null)).toEqual({ speedingS: 1, speeding: { low: 1, mid: 0, high: 0 }, driving: { low: 600, mid: 300, high: 100 } });
  });

  test('follows the range: an older drive and its events are cut, its buckets too', () => {
    const events = [speeding(65, 100, { startedAt: old.startedAt + MIN }), speeding(35, 10)];
    expect(speedingByRoad([recent, old], events, null)!.driving).toEqual({ low: 600, mid: 300, high: 1100 });
    const day = speedingByRoad([recent, old], events, DAY_SINCE)!;
    expect(day.speeding).toEqual({ low: 0, mid: 10, high: 0 });
    expect(day.driving).toEqual({ low: 600, mid: 300, high: 100 });
    // The older drive's own speeding alone: nothing in the day.
    expect(speedingByRoad([recent, old], [events[0]!], DAY_SINCE)).toBeNull();
  });

  test('no speeding: null; drives without buckets give no driving share', () => {
    expect(speedingByRoad([recent], [], null)).toBeNull();
    expect(speedingByRoad([], [speeding(35, 10)], null)).toBeNull();
    const none = drive({ clientTripId: 'r', limitBuckets: null });
    expect(speedingByRoad([none], [speeding(35, 10)], null)!.driving).toBeNull();
    // All-zero buckets say nothing either.
    expect(speedingByRoad([drive({ clientTripId: 'r', limitBuckets: buckets(0, 0, 0) })], [speeding(35, 10)], null)!.driving).toBeNull();
    // An unscored drive counts nowhere.
    expect(speedingByRoad([drive({ clientTripId: 'r', status: 'not_driving' })], [speeding(35, 10)], null)).toBeNull();
  });

  test('a drive that sped without buckets drops the driving share, so the two shares cover the same drives', () => {
    // An older drive with highway speeding and no buckets, a newer one with buckets (all street driving) and no speeding.
    const before = drive({ clientTripId: 'o', startedAt: NOW - 72 * HOUR, endedAt: NOW - 72 * HOUR + 24 * MIN, limitBuckets: null });
    const after = drive({ clientTripId: 'r', limitBuckets: buckets(1000, 0, 0) });
    const r = speedingByRoad([after, before], [speeding(65, 100, { startedAt: before.startedAt + MIN })], null)!;
    expect(r.speeding).toEqual({ low: 0, mid: 0, high: 100 });
    expect(r.driving).toBeNull();
    expect(roadView(r)).toMatchObject({ most: 'high', gap: false });
    expect(roadView(r).rows.map((x) => x.drivingPct)).toEqual([null, null, null]);
    // Speeding only on the drive with buckets: an older drive without them (and no speeding) adds nothing to either side.
    const own = speedingByRoad([after, before], [speeding(25, 50)], null)!;
    expect(own.driving).toEqual({ low: 1000, mid: 0, high: 0 });
  });
});

describe('roadView', () => {
  const r = (speeding: SpeedingByRoad['speeding'], driving: SpeedingByRoad['driving']): SpeedingByRoad => ({
    speedingS: speeding.low + speeding.mid + speeding.high,
    speeding,
    driving,
  });

  test('whole percents, streets first; the kind with half the speeding or more is named, with the gap at 15 points', () => {
    const v = roadView(r({ low: 10, mid: 70, high: 20 }, { low: 50, mid: 40, high: 10 }));
    expect(v.rows).toEqual([
      { kind: 'low', speedingPct: 10, drivingPct: 50 },
      { kind: 'mid', speedingPct: 70, drivingPct: 40 },
      { kind: 'high', speedingPct: 20, drivingPct: 10 },
    ]);
    expect(v).toMatchObject({ most: 'mid', gap: true });
    expect(roadView(r({ low: 0, mid: 55, high: 45 }, { low: 0, mid: 40, high: 60 }))).toMatchObject({ most: 'mid', gap: true });
    expect(roadView(r({ low: 0, mid: 54, high: 46 }, { low: 0, mid: 40, high: 60 }))).toMatchObject({ most: 'mid', gap: false });
    // Exactly half is most; under half nobody is.
    expect(roadView(r({ low: 50, mid: 25, high: 25 }, null))).toMatchObject({ most: 'low', gap: false });
    expect(roadView(r({ low: 40, mid: 30, high: 30 }, null))).toMatchObject({ most: null, gap: false });
    expect(roadView(r({ low: 40, mid: 30, high: 30 }, null)).rows.map((x) => x.drivingPct)).toEqual([null, null, null]);
  });

  test('the copy: labels in either unit and the headline', () => {
    const c = analyticsCopy.category.roads;
    expect(['low', 'mid', 'high'].map((k) => c.label(k as 'low', 'mi'))).toEqual(['Streets, 25 mph and under', 'Main roads, 30–45 mph', 'Highways, 50 mph and up']);
    expect(['low', 'mid', 'high'].map((k) => c.label(k as 'low', 'km'))).toEqual(['Streets, 40 km/h and under', 'Main roads, 50–70 km/h', 'Highways, 80 km/h and up']);
    expect(c.headline('mid', null)).toBe('Most of your speeding is on main roads.');
    expect(c.headline('high', 12)).toBe('Most of your speeding is on highways, even though only 12% of your driving is there.');
    expect(c.speeding(40)).toBe('40% of your speeding');
    expect(c.driving(5)).toBe('5% of your driving');
  });
});

describe('pickupTiming', () => {
  const start = recent.startedAt;
  const end = recent.endedAt!;

  test('the speed buckets: 10–25, 25–45 and 45+ mph; 16–40, 40–70 and 70+ km/h for a km driver', () => {
    expect([10, 24.9, 25, 44.9, 45, 70].map((v) => pickupSpeedOf(v, 'mi'))).toEqual(['low', 'low', 'mid', 'mid', 'high', 'high']);
    // In km/h: 39.9 / 40.1 / 69.9 / 70.1.
    expect([24.8, 24.92, 43.43, 43.56].map((v) => pickupSpeedOf(v, 'km'))).toEqual(['low', 'mid', 'mid', 'high']);
    // 71 km/h (about 44.1 mph): highway for a km driver, a main road for a mi driver.
    const mph71 = 71 / 1.609344;
    expect(pickupSpeedOf(mph71, 'km')).toBe('high');
    expect(pickupSpeedOf(mph71, 'mi')).toBe('mid');
  });

  test('the moment: first 5 min, last 5 min, in between; a drive under 10 min only first or last by the nearer end', () => {
    expect(pickupMomentOf(recent, start)).toBe('first');
    expect(pickupMomentOf(recent, start + 5 * MIN - 1)).toBe('first');
    expect(pickupMomentOf(recent, start + 5 * MIN)).toBe('middle');
    expect(pickupMomentOf(recent, end - 5 * MIN)).toBe('middle');
    expect(pickupMomentOf(recent, end - 5 * MIN + 1)).toBe('last');
    const short = { startedAt: start, endedAt: start + 9 * MIN, durationS: 540 };
    expect(pickupMomentOf(short, start + 4.5 * MIN)).toBe('first');
    expect(pickupMomentOf(short, start + 4.6 * MIN)).toBe('last');
    // No end stored: the start plus its duration.
    expect(pickupMomentOf({ startedAt: start, endedAt: null, durationS: 1440 }, start + 20 * MIN)).toBe('last');
  });

  test('counts active pickups of the range’s scored drives; under 3 is null', () => {
    const events = [pickup(start + MIN, 12), pickup(start + 2 * MIN, 30), pickup(start + 12 * MIN, 50), pickup(start + 22 * MIN, undefined)];
    const t = pickupTiming([recent], events, DAY_SINCE, 'mi')!;
    expect(t.pickups).toBe(4);
    expect(t.speed).toEqual({ low: 1, mid: 1, high: 1 });
    // The same pickups for a km driver: 30 mph is 48 km/h (mid), 50 mph 80 km/h (high).
    expect(pickupTiming([recent], events, DAY_SINCE, 'km')!.speed).toEqual({ low: 1, mid: 1, high: 1 });
    expect(pickupTiming([recent], [pickup(start + MIN, 44), pickup(start + 2 * MIN, 44), pickup(start + 3 * MIN, 44)], DAY_SINCE, 'km')!.speed).toEqual({ low: 0, mid: 0, high: 3 });
    expect(pickupTiming([recent], [pickup(start + MIN, 44), pickup(start + 2 * MIN, 44), pickup(start + 3 * MIN, 44)], DAY_SINCE, 'mi')!.speed).toEqual({ low: 0, mid: 3, high: 0 });
    expect(t.moment).toEqual({ first: 2, middle: 1, last: 1 });
    expect(t.bands.reduce((a, b) => a + b, 0)).toBe(4);
    expect(t.bands[bandIndex(start)]).toBeGreaterThan(0);
    // Removed ones and other types don't count: two left is too few.
    expect(pickupTiming([recent], [events[0]!, events[1]!, pickup(start + 3 * MIN, 30, { status: 'removed' }), speeding(35, 10)], DAY_SINCE, 'mi')).toBeNull();
    // An older drive's pickups fall outside the day.
    const olds = [1, 2, 3].map((i) => pickup(old.startedAt + i * MIN, 30));
    expect(pickupTiming([recent, old], olds, DAY_SINCE, 'mi')).toBeNull();
    expect(pickupTiming([recent, old], olds, null, 'mi')!.pickups).toBe(3);
  });
});

describe('pickupView', () => {
  const base = (over: Partial<PickupTiming>): PickupTiming => ({
    pickups: 4,
    speed: { low: 2, mid: 1, high: 1 },
    moment: { first: 1, middle: 2, last: 1 },
    bands: [0, 0, 0, 0, 0, 0, 3, 1],
    ...over,
  });

  test('first match wins: first 5 min, then last 5 min, then highway speeds, else the busiest band', () => {
    expect(pickupView(base({ moment: { first: 2, middle: 0, last: 2 } })).headline.kind).toBe('first');
    expect(pickupView(base({ moment: { first: 1, middle: 1, last: 2 }, speed: { low: 0, mid: 0, high: 4 } })).headline.kind).toBe('last');
    expect(pickupView(base({ speed: { low: 1, mid: 0, high: 1 } })).headline.kind).toBe('highway');
    // Highway share is of the pickups with a speed.
    expect(pickupView(base({ speed: { low: 1, mid: 1, high: 1 } })).headline).toEqual({ kind: 'band', band: 6 });
    expect(pickupView(base({ speed: { low: 0, mid: 0, high: 0 } })).headline.kind).toBe('band');
  });

  test('each row: the top bucket and its whole share (ties to the earlier), no speed row without speeds', () => {
    const v = pickupView(base({}));
    expect(v.speed).toEqual({ key: 'low', pct: 50 });
    expect(v.moment).toEqual({ key: 'middle', pct: 50 });
    expect(v.band).toEqual({ key: 6, pct: 75 });
    expect(pickupView(base({ speed: { low: 1, mid: 1, high: 0 }, moment: { first: 1, middle: 1, last: 1 }, pickups: 3, bands: [1, 1, 1, 0, 0, 0, 0, 0] }))).toMatchObject({
      speed: { key: 'low', pct: 50 },
      moment: { key: 'first', pct: 33 },
      band: { key: 0, pct: 33 },
    });
    expect(pickupView(base({ speed: { low: 0, mid: 0, high: 0 } })).speed).toBeNull();
  });

  test('the copy', () => {
    const c = analyticsCopy.category.pickupTiming;
    expect(c.first).toBe('Most of your pickups happen in the first 5 minutes. Set your music and route before you go.');
    expect(c.last).toBe('Most of your pickups happen near the end of a drive. The message can wait until you park.');
    expect(c.highway).toBe('Most of your pickups happen at highway speeds.');
    expect(c.band(6)).toBe('Your pickups happen most between 6 and 9pm.');
    expect(c.band(0)).toBe('Your pickups happen most between midnight and 3am.');
    expect(c.speed('high', 'km')).toBe('70+ km/h');
    expect(c.speed('mid', 'mi')).toBe('25–45 mph');
    expect(c.moment('last')).toBe('Last 5 min');
  });
});

describe('weatherSums and weatherView', () => {
  const counts = (events: number) => ({ speeding: events, hardBrake: 0, hardAccel: 0, hardCorner: 0, pickups: 0, eyesOff: 3, drowsy: 3 });
  const d = (id: string, weather: LocalDrive['weather'], miles: number, events: number) => drive({ clientTripId: id, weather, miles, counts: counts(events) });

  test('sums every scored drive with a weather word, all time: rain, snow and ice wet, clear dry; DashPal events left out', () => {
    const s = weatherSums([
      d('a', 'rain', 6, 2),
      d('b', 'snow', 3, 1),
      d('c', 'ice', 2, 0),
      d('e', 'clear', 20, 2),
      d('f', null, 50, 9),
      d('g', undefined, 50, 9),
      drive({ clientTripId: 'h', weather: 'rain', miles: 40, status: 'not_driving' }),
      drive({ clientTripId: 'i', weather: 'clear', miles: 5, startedAt: NOW - 400 * 24 * HOUR, counts: { ...counts(0), hardBrake: 1, hardAccel: 1, hardCorner: 1, pickups: 1 } }),
    ]);
    expect(s).toEqual({ wet: { drives: 3, miles: 11, events: 3 }, dry: { drives: 2, miles: 25, events: 6 } });
  });

  const sums = (wetMiles: number, wetEvents: number, dryMiles: number, dryEvents: number): WeatherSums => ({
    wet: { drives: 2, miles: wetMiles, events: wetEvents },
    dry: { drives: 5, miles: dryMiles, events: dryEvents },
  });

  test('hidden until both sides reach 10 mi (16 km)', () => {
    expect(weatherView(sums(9.9, 1, 50, 1), 'mi')).toBeNull();
    expect(weatherView(sums(50, 1, 9.9, 1), 'mi')).toBeNull();
    expect(weatherView(sums(10, 1, 10, 1), 'mi')).not.toBeNull();
    // 16 km is 9.94 mi.
    expect(weatherView(sums(9.95, 1, 9.95, 1), 'km')).not.toBeNull();
    expect(weatherView(sums(9.9, 1, 9.95, 1), 'km')).toBeNull();
  });

  test('first match: 1.5× or more is worse, at or under dry is smooth, else bumpier', () => {
    expect(weatherView(sums(10, 3, 20, 3), 'mi')).toEqual({ kind: 'worse', ratio: 2 });
    expect(weatherView(sums(10, 3, 20, 4), 'mi')).toEqual({ kind: 'worse', ratio: 1.5 });
    expect(weatherView(sums(10, 4, 25, 6), 'mi')).toEqual({ kind: 'worse', ratio: 1.7 });
    expect(weatherView(sums(10, 2, 20, 3), 'mi')).toEqual({ kind: 'bumpier', ratio: null });
    expect(weatherView(sums(10, 1, 20, 2), 'mi')).toEqual({ kind: 'smooth', ratio: null });
    expect(weatherView(sums(10, 0, 20, 0), 'mi')).toEqual({ kind: 'smooth', ratio: null });
    expect(weatherView(sums(10, 1, 20, 0), 'mi')).toEqual({ kind: 'worse', ratio: null });
  });

  test('the copy, in either unit', () => {
    const w = analyticsCopy.weather;
    expect(w.text({ kind: 'worse', ratio: 2 }, 'mi')).toBe('In rain or snow you have 2× the events per mile. Slow down and leave more room.');
    expect(w.text({ kind: 'worse', ratio: 1.6 }, 'km')).toBe('In rain or snow you have 1.6× the events per kilometer. Slow down and leave more room.');
    expect(w.text({ kind: 'worse', ratio: null }, 'mi')).toBe('In rain or snow you have more events per mile. Slow down and leave more room.');
    expect(w.text({ kind: 'smooth', ratio: null }, 'mi')).toBe('You drive as smoothly in rain or snow as in the dry. Nice.');
    expect(w.text({ kind: 'bumpier', ratio: null }, 'km')).toBe('Rain and snow make your drives a little bumpier. Give yourself extra time.');
    expect(w.detail(1, '12 mi')).toBe('1 drive in rain or snow · 12 mi');
    expect(w.detail(4, '38 km')).toBe('4 drives in rain or snow · 38 km');
  });
});

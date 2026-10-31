/**
 * Learned places: grouping noisy parking fixes, telling home (nights) from the weekday place
 * (work, school), recency, the accuracy gates, and the suggestions each field gets.
 */
import { haversineMeters, type LatLng } from '@/lib/geo';

import {
  daytimeMs,
  groupPoints,
  learnPlaces,
  nightsBetween,
  offsetMs,
  suggestionsFor,
  type LearnedPlace,
  type TripEnds,
} from '../learn';

const TZ = 'America/Los_Angeles';
const HOUR = 3_600_000;
const DAY = 24 * HOUR;
/** Monday 3 Aug 2026, 00:00 in Los Angeles (PDT, UTC−7). */
const MONDAY = Date.UTC(2026, 7, 3) + 7 * HOUR;
const at = (day: number, hour: number) => MONDAY + day * DAY + hour * HOUR;

const HOME: LatLng = { lat: 47.6205, lng: -122.3493 };
const WORK: LatLng = { lat: 47.6097, lng: -122.3331 };
const GYM: LatLng = { lat: 47.63, lng: -122.32 };
const SHOP: LatLng = { lat: 47.64, lng: -122.36 };
const CAFE: LatLng = { lat: 47.655, lng: -122.305 };

/** A small deterministic generator, so the parking noise is the same every run. */
function noise(seed: number) {
  let s = seed;
  return () => {
    s = (s * 1103515245 + 12345) % 2147483648;
    return s / 2147483648;
  };
}

function jitter(p: LatLng, r: () => number, m = 40): LatLng {
  return { lat: p.lat + ((r() - 0.5) * 2 * m) / 111_320, lng: p.lng + ((r() - 0.5) * 2 * m) / (111_320 * Math.cos((p.lat * Math.PI) / 180)) };
}

let n = 0;
function drive(from: LatLng, to: LatLng, start: number, minutes: number, r: () => number): TripEnds {
  n += 1;
  return { id: `t${n}`, startedAt: start, endedAt: start + minutes * 60_000, tz: TZ, start: jitter(from, r), end: jitter(to, r) };
}

/** A commuter: weekdays home → work 08:00 and back 17:30, gym Tue/Thu evenings, shop on Saturdays. */
function commuter(weeks: number, home = HOME, firstDay = 0, seed = 7): TripEnds[] {
  const r = noise(seed);
  const trips: TripEnds[] = [];
  for (let d = firstDay; d < firstDay + weeks * 7; d += 1) {
    const dow = d % 7; // 0 = Monday
    if (dow < 5) {
      trips.push(drive(home, WORK, at(d, 8), 25, r));
      trips.push(drive(WORK, home, at(d, 17.5), 25, r));
      if (dow === 1 || dow === 3) {
        trips.push(drive(home, GYM, at(d, 19), 10, r));
        trips.push(drive(GYM, home, at(d, 20.25), 10, r));
      }
    } else if (dow === 5) {
      trips.push(drive(home, SHOP, at(d, 10), 15, r));
      trips.push(drive(SHOP, home, at(d, 11), 15, r));
    }
  }
  return trips;
}

const near = (p: LearnedPlace | undefined, q: LatLng, m = 60) => p !== undefined && haversineMeters(p.center, q) <= m;
const find = (places: readonly LearnedPlace[], q: LatLng) => places.find((p) => haversineMeters(p.center, q) <= 100);

describe('local time', () => {
  it('reads the drive’s own time zone, DST included', () => {
    expect(offsetMs(MONDAY, TZ)).toBe(-7 * HOUR);
    expect(offsetMs(Date.UTC(2026, 0, 15, 12), TZ)).toBe(-8 * HOUR);
    expect(offsetMs(MONDAY, 'Asia/Kolkata')).toBe(5.5 * HOUR);
  });

  it('falls back to the phone’s zone for a zone it doesn’t know', () => {
    expect(offsetMs(MONDAY, 'Not/AZone')).toBe(-new Date(MONDAY).getTimezoneOffset() * 60_000);
  });

  it('counts the 03:00s inside a gap', () => {
    const local = (day: number, hour: number) => day * DAY + hour * HOUR;
    expect(nightsBetween(local(0, 18), local(1, 8))).toBe(1);
    expect(nightsBetween(local(0, 18), local(0, 23))).toBe(0);
    expect(nightsBetween(local(0, 1), local(0, 4))).toBe(1);
    expect(nightsBetween(local(0, 18), local(3, 8))).toBe(3);
    expect(nightsBetween(local(0, 8), local(0, 8))).toBe(0);
  });

  it('measures the daytime part of a stay', () => {
    const local = (hour: number) => 10 * DAY + hour * HOUR;
    expect(daytimeMs(local(8.5), local(17.5))).toBe(9 * HOUR);
    expect(daytimeMs(local(4), local(7))).toBe(1 * HOUR);
    expect(daytimeMs(local(20), local(23))).toBe(0);
  });
});

describe('grouping', () => {
  it('keeps one building’s spread-out parking in one place and the house 400 m away in another', () => {
    const r = noise(3);
    const a = Array.from({ length: 12 }, () => jitter(HOME, r, 70));
    const b = Array.from({ length: 6 }, () => jitter({ lat: HOME.lat + 400 / 111_320, lng: HOME.lng }, r, 40));
    const { groupOf, centers } = groupPoints([...a, ...b]);
    expect(new Set(groupOf.slice(0, 12)).size).toBe(1);
    expect(new Set(groupOf.slice(12)).size).toBe(1);
    expect(groupOf[0]).not.toBe(groupOf[12]);
    expect(centers).toHaveLength(2);
    expect(haversineMeters(centers[groupOf[0] as number] as LatLng, HOME)).toBeLessThan(40);
  });

  it('isn’t pulled off by a stray fix', () => {
    const r = noise(5);
    const pts = [...Array.from({ length: 9 }, () => jitter(WORK, r, 20)), { lat: WORK.lat + 140 / 111_320, lng: WORK.lng }];
    const { centers } = groupPoints(pts);
    expect(centers).toHaveLength(1);
    expect(haversineMeters(centers[0] as LatLng, WORK)).toBeLessThan(25);
  });
});

describe('learnPlaces', () => {
  const trips = commuter(8);
  const now = at(56, 12);
  const places = learnPlaces(trips, now);

  it('finds home from the nights and work from the weekdays', () => {
    const home = find(places, HOME);
    const work = find(places, WORK);
    expect(home?.kind).toBe('home');
    expect(home?.pHome).toBeGreaterThan(0.85);
    expect(near(home, HOME, 30)).toBe(true);
    expect(work?.kind).toBe('work');
    expect(work?.pWork).toBeGreaterThan(0.85);
    expect(work?.pHome).toBe(0);
    expect(near(work, WORK, 30)).toBe(true);
  });

  it('keeps the gym and the shop as frequent places, ranked by how often they come up', () => {
    expect(find(places, GYM)?.kind).toBe('frequent');
    expect(find(places, SHOP)?.kind).toBe('frequent');
    expect(places[0] && near(places[0], HOME)).toBe(true);
    const share = places.reduce((s, p) => s + p.share, 0);
    expect(share).toBeLessThanOrEqual(1.0000001);
  });

  it('counts a stay as one visit', () => {
    // 8 Saturdays at the shop: 8 arrivals and 8 departures, each pair one stay.
    expect(find(places, SHOP)?.visits).toBe(8);
    expect(find(places, SHOP)?.days).toBe(8);
  });

  it('never suggests a place seen once', () => {
    const r = noise(11);
    const once = learnPlaces([...trips, drive(HOME, CAFE, at(20, 9), 12, r), drive(CAFE, HOME, at(20, 10), 12, r)], now);
    expect(find(once, CAFE)).toBeUndefined();
  });

  it('needs more than one day: three visits in one afternoon are not a place', () => {
    const r = noise(13);
    const extra = [0, 1, 2].flatMap((k) => [drive(HOME, CAFE, at(19, 12 + k), 5, r), drive(CAFE, HOME, at(19, 12.5 + k), 5, r)]);
    expect(find(learnPlaces([...trips, ...extra], now), CAFE)).toBeUndefined();
  });

  it('a recent move wins: a month in the new home outweighs two months in the old one', () => {
    const NEW: LatLng = { lat: 47.67, lng: -122.39 };
    const moved = [...commuter(8, HOME, 0, 7), ...commuter(4, NEW, 56, 9)];
    const learned = learnPlaces(moved, at(84, 12));
    const best = suggestionsFor('home', learned, [])[0];
    expect(near(best, NEW)).toBe(true);
  });

  it('splits a night between two places when the drive in between wasn’t recorded', () => {
    const r = noise(17);
    // Ends at the shop at 18:00; the next recorded drive leaves home at 08:00.
    const gap = learnPlaces([drive(WORK, SHOP, at(0, 17.5), 20, r), drive(HOME, WORK, at(1, 8), 20, r)], at(2, 0));
    expect(gap).toEqual([]);
    const all = learnPlaces([...trips.slice(0, 20), drive(WORK, SHOP, at(40, 17.5), 20, r), drive(HOME, WORK, at(41, 8), 20, r)], now);
    expect(find(all, HOME)?.nights).toBeGreaterThan(find(all, SHOP)?.nights ?? 0);
  });

  it('skips drives without ends and survives nonsense', () => {
    const odd: TripEnds[] = [
      { id: 'x', startedAt: at(1, 9), endedAt: at(1, 8), tz: TZ, start: HOME, end: WORK },
      { id: 'y', startedAt: at(2, 9), endedAt: at(2, 10), tz: TZ, start: null, end: null },
      { id: 'z', startedAt: at(3, 9), endedAt: at(3, 10), tz: TZ, start: { lat: NaN, lng: 0 }, end: { lat: 95, lng: 0 } },
    ];
    expect(learnPlaces(odd, now)).toEqual([]);
    expect(learnPlaces([], now)).toEqual([]);
  });

  it('works through six months of drives quickly', () => {
    const big = commuter(26);
    const t0 = Date.now();
    const learned = learnPlaces(big, at(182, 12));
    expect(Date.now() - t0).toBeLessThan(1500);
    expect(find(learned, HOME)?.kind).toBe('home');
  });
});

describe('suggestionsFor', () => {
  const places = learnPlaces(commuter(8), at(56, 12));

  it('offers the likeliest home for Home and the weekday place for Work and School', () => {
    expect(near(suggestionsFor('home', places, [])[0], HOME)).toBe(true);
    expect(near(suggestionsFor('work', places, [])[0], WORK)).toBe(true);
    expect(near(suggestionsFor('school', places, [])[0], WORK)).toBe(true);
  });

  it('never offers a likely home for Work or School', () => {
    for (const slot of ['work', 'school'] as const) expect(suggestionsFor(slot, places, []).some((p) => near(p, HOME))).toBe(false);
  });

  it('leaves out places already saved and offers at most 3', () => {
    const custom = suggestionsFor('custom', places, [HOME, WORK]);
    expect(custom.length).toBeLessThanOrEqual(3);
    expect(custom.some((p) => near(p, HOME) || near(p, WORK))).toBe(false);
    expect(custom.some((p) => near(p, GYM))).toBe(true);
  });
});

import { haversineMeters } from '@/lib/geo';
import { cumulative } from '@/lib/runs';

import { at, DAY, drive, ev, line, metres, NORTH, PARALLEL, seeded, shuffle, SOUTH, T0, TURN } from '../__fixtures__/spots';
import { cleanNeededFor, detectSpots, modeLimit, replay, type PassMark, type ReplayStep } from '../detect';
import type { SpotDrive, SpotEvent } from '../types';

const length = (pts: readonly { lat: number; lng: number }[]) => {
  const c = cumulative(pts);
  return c[c.length - 1]!;
};

/** Passes `gapDays` apart, a hit where `hit(i)`. */
const passes = (n: number, gapDays: number, hit: (i: number) => boolean, from = 0): PassMark[] =>
  Array.from({ length: n }, (_, i) => ({ t: T0 + (from + i) * gapDays * DAY, hit: hit(i + from) }));

function traced(ps: readonly PassMark[]): ReplayStep[] {
  const steps: ReplayStep[] = [];
  replay(ps, (s) => steps.push(s));
  return steps;
}

/** `n` drives north one day apart; a hard brake at 1 km on the ones `hit` picks. */
function brakeRoad(n: number, hit: (i: number) => boolean, where: readonly [number, number] = [1000, 0], prefix = 'd') {
  const drives = Array.from({ length: n }, (_, i) => drive(`${prefix}${String(i).padStart(3, '0')}`, i));
  const events = drives.flatMap((d, i) => (hit(i) ? [ev(`${prefix}e${String(i).padStart(3, '0')}`, d, 'hard_brake', where)] : []));
  return { drives, events };
}

describe('the state machine (spots.md §2.5 vectors)', () => {
  test('the clean run K that clears a spot', () => {
    expect([0.15, 0.25, 0.3, 0.4, 0.5, 0.7].map(cleanNeededFor)).toEqual([10, 9, 7, 5, 4, 4]);
  });

  const COMMUTE_HITS = new Set([1, 4, 6, 9, 11, 14, 16, 19]);
  const commute = passes(20, 1.5, (i) => COMMUTE_HITS.has(i));

  test('a commute: active from pass 6 (p 0.289, K 7), ending at p 0.329, K 6', () => {
    const steps = traced(commute);
    expect(steps[5]!.state).toBe('none');
    expect(steps[6]).toMatchObject({ state: 'active', cleanNeeded: 7 });
    expect(steps[6]!.p).toBeCloseTo(0.289, 3);
    const r = replay(commute);
    expect(r).toMatchObject({ state: 'active', rate: 0.329, cleanNeeded: 6, hits: 8, passes: 20, recentHits: 4, recentPasses: 10, cleanStreak: 0 });
  });

  test('then 10 clean passes: cleared at the 6th (clean 6 = K 6)', () => {
    const more = [...commute, ...passes(10, 1.5, () => false, 20)];
    const steps = traced(more);
    expect(steps[24]).toMatchObject({ state: 'active', clean: 5 });
    expect(steps[25]!.state).toBe('none');
    expect(steps[25]!.p).toBeCloseTo(0.236, 2);
    const r = replay(more.slice(0, 26));
    expect(r.state).toBe('none');
    expect(r.clearedAt).toBe(more[25]!.t);
    // Started over: nothing before the clearing counts.
    expect(r).toMatchObject({ hits: 0, passes: 0, cleanStreak: 0 });
  });

  test('a weekend road: 3 passes 7 d apart, all hits, is active at the third (p 0.406, K 5)', () => {
    const r = replay(passes(3, 7, () => true));
    expect(r).toMatchObject({ state: 'active', rate: 0.406, cleanNeeded: 5 });
    expect(replay(passes(2, 7, () => true)).state).toBe('none');
  });

  test('a motorway: 40 passes 0.75 d apart with 4 hits never becomes a spot (final p 0.101)', () => {
    const steps = traced(passes(40, 0.75, (i) => i % 10 === 5));
    expect(steps.every((s) => s.state === 'none')).toBe(true);
    expect(steps[39]!.p).toBeCloseTo(0.101, 3);
  });

  test('2 hits on 2 drives then a clean one: never active', () => {
    expect(replay([...passes(2, 1, () => true), ...passes(1, 1, () => false, 2)]).state).toBe('none');
  });

  test('a road at 30 % over 120 passes 1 d apart: active from pass 15 and never flickers off', () => {
    const steps = traced(passes(120, 1, (i) => [2, 5, 8].includes(i % 10)));
    const first = steps.findIndex((s) => s.state === 'active');
    expect(first).toBe(15);
    expect(steps.slice(first).every((s) => s.state === 'active')).toBe(true);
  });

  test('a cleared spot needs 3 fresh hits to come back', () => {
    const cleared = [...commute, ...passes(6, 1.5, () => false, 20)];
    expect(replay(cleared).state).toBe('none');
    const two = [...cleared, ...passes(2, 1.5, () => true, 26)];
    expect(replay(two).state).toBe('none');
    const three = [...cleared, ...passes(3, 1.5, () => true, 26)];
    expect(replay(three)).toMatchObject({ state: 'active', hits: 3, passes: 3 });
  });

  test('a spot quiet for months clears on its next clean pass, under 1 in 10', () => {
    const weekend = passes(3, 7, () => true);
    const later = [...weekend, { t: weekend[2]!.t + 200 * DAY, hit: false }];
    const steps = traced(later);
    expect(steps[3]!.p).toBeLessThan(0.1);
    expect(replay(later)).toMatchObject({ state: 'none', clearedAt: later[3]!.t });
  });
});

describe('clustering', () => {
  test('the same place and direction on 3 drives is one spot', () => {
    const { drives, events } = brakeRoad(3, () => true);
    const spots = detectSpots(drives, events, T0 + 3 * DAY);
    expect(spots).toHaveLength(1);
    expect(spots[0]).toMatchObject({ id: 'hard_brake:de000', kind: 'hard_brake', state: 'active', rank: 1, hits: 3, passes: 3, lastHitTrip: 'd002' });
    expect(metres(spots[0]!.pin, at(1000, 0))).toBeLessThan(2);
    expect(Math.abs(spots[0]!.headingDeg)).toBeLessThan(1);
  });

  test('phone pickups never make a spot, however often they happen in the same place and direction', () => {
    const { drives, events } = brakeRoad(10, () => true);
    const pickups = events.map((e) => ({ ...e, id: `${e.id}p`, type: 'phone_pickup' }) as unknown as SpotEvent);
    expect(detectSpots(drives, pickups, T0 + 10 * DAY)).toEqual([]);
    // Beside the brakes they change nothing.
    expect(detectSpots(drives, [...events, ...pickups], T0 + 10 * DAY)).toEqual(detectSpots(drives, events, T0 + 10 * DAY));
  });

  test('the opposite direction is its own cluster: 2 + 2 drives make no spot', () => {
    const drives = [drive('n0', 0), drive('s0', 1, [SOUTH]), drive('n1', 2), drive('s1', 3, [SOUTH])];
    const events = drives.map((d, i) => ev(`e${i}`, d, 'hard_brake', [1000, 0]));
    expect(detectSpots(drives, events, T0 + 4 * DAY)).toEqual([]);
    // The same four on one direction would be a spot.
    const same = [0, 1, 2, 3].map((i) => drive(`n${i}`, i));
    expect(detectSpots(same, same.map((d, i) => ev(`e${i}`, d, 'hard_brake', [1000, 0])), T0 + 4 * DAY)).toHaveLength(1);
  });

  test('brakes 60 m apart stay separate', () => {
    const drives = Array.from({ length: 6 }, (_, i) => drive(`d${i}`, i));
    const events = drives.map((d, i) => ev(`e${i}`, d, 'hard_brake', [i % 2 === 0 ? 1000 : 1060, 0]));
    const spots = detectSpots(drives, events, T0 + 6 * DAY);
    expect(spots.map((s) => s.id).sort()).toEqual(['hard_brake:e0', 'hard_brake:e1']);
    for (const s of spots) expect(s).toMatchObject({ hits: 3, passes: 6 });
  });

  test('speeding episodes starting 0, 90 and 180 m apart on one road merge into one spot', () => {
    const drives = [0, 1, 2].map((i) => drive(`d${i}`, i));
    const events = drives.map((d, i) => ev(`e${i}`, d, 'speeding', [500 + 90 * i, 0], { speedMph: 40, durationS: 10 }));
    const spots = detectSpots(drives, events, T0 + 3 * DAY);
    expect(spots).toHaveLength(1);
    expect(spots[0]!.hits).toBe(3);
  });

  test("a left-turn spot is not diluted by straight passes (the exit's direction)", () => {
    const drives: SpotDrive[] = [];
    const events: SpotEvent[] = [];
    for (let i = 0; i < 13; i++) {
      const turning = i % 4 === 0; // 4 turning drives among 9 straight ones
      const d = drive(`d${String(i).padStart(2, '0')}`, i, [turning ? TURN : NORTH]);
      drives.push(d);
      if (turning) events.push(ev(`e${i}`, d, 'hard_corner', [1000, 0]));
    }
    const spots = detectSpots(drives, events, T0 + 13 * DAY);
    expect(spots).toHaveLength(1);
    expect(spots[0]).toMatchObject({ kind: 'hard_corner', hits: 4, passes: 4 });
  });
});

describe('passes', () => {
  test('a parallel road 50 m away and the opposite direction are not passes', () => {
    const drives = [drive('a', 0), drive('p1', 1, [PARALLEL]), drive('b', 2), drive('s1', 3, [SOUTH]), drive('c', 4), drive('p2', 5, [PARALLEL])];
    const events = ['a', 'b', 'c'].map((id) => ev(`e${id}`, drives.find((d) => d.clientTripId === id)!, 'hard_brake', [1000, 0]));
    const spots = detectSpots(drives, events, T0 + 6 * DAY);
    expect(spots).toHaveLength(1);
    expect(spots[0]).toMatchObject({ hits: 3, passes: 3 });
  });

  test('the same road driven the same way without an event is a pass', () => {
    const { drives, events } = brakeRoad(6, (i) => i % 2 === 0);
    expect(detectSpots(drives, events, T0 + 6 * DAY)[0]).toMatchObject({ hits: 3, passes: 6, recentHits: 3, recentPasses: 6 });
  });

  test('a hit drive is a pass even when its line is 40 m off the centre', () => {
    const drives = [drive('a', 0), drive('b', 1), drive('c', 2), drive('off', 3, [line([0, 45], [2000, 45])])];
    const events = [...drives.slice(0, 3).map((d) => ev(`e${d.clientTripId}`, d, 'hard_brake', [1000, 0])), ev('eoff', drives[3]!, 'hard_brake', [1000, 20])];
    const spot = detectSpots(drives, events, T0 + 4 * DAY)[0]!;
    expect(spot).toMatchObject({ hits: 4, passes: 4 });
    expect(metres(at(1000, 45), at(1000, 5))).toBeCloseTo(40, 0);
  });
});

describe('events', () => {
  test('an event 31 m from its own route is dropped (29 m is kept)', () => {
    const drives = [0, 1, 2].map((i) => drive(`d${i}`, i));
    const make = (off: number) => drives.map((d, i) => ev(`e${i}`, d, 'hard_brake', [1000, i === 2 ? off : 0]));
    expect(detectSpots(drives, make(31), T0 + 3 * DAY)).toEqual([]);
    expect(detectSpots(drives, make(29), T0 + 3 * DAY)).toHaveLength(1);
  });

  test('an event with no place is ignored', () => {
    const { drives, events } = brakeRoad(3, () => true);
    const nulled = events.map((e, i) => (i === 1 ? { ...e, lat: null as unknown as number } : e));
    expect(detectSpots(drives, nulled, T0 + 3 * DAY)).toEqual([]);
  });

  test("an event of another drive or a type that isn't a spot kind is ignored", () => {
    const { drives, events } = brakeRoad(3, () => true);
    expect(detectSpots(drives.slice(0, 2), events, T0 + 3 * DAY)).toEqual([]);
    const odd = events.map((e, i) => (i === 0 ? { ...e, type: 'eyes_off' as unknown as SpotEvent['type'] } : e));
    expect(detectSpots(drives, odd, T0 + 3 * DAY)).toEqual([]);
  });
});

describe('time', () => {
  test('an active spot nobody passed for 60 days is set aside', () => {
    const { drives, events } = brakeRoad(3, () => true);
    const last = drives[2]!.startedAt;
    expect(detectSpots(drives, events, last + 59 * DAY)).toHaveLength(1);
    expect(detectSpots(drives, events, last + 61 * DAY)).toEqual([]);
  });

  test('drives and events older than 120 days are ignored', () => {
    const { drives, events } = brakeRoad(3, () => true);
    const moved = drives.map((d, i) => (i === 0 ? { ...d, startedAt: d.startedAt - 100 * DAY } : d));
    const evs = events.map((e, i) => (i === 0 ? { ...e, startedAt: e.startedAt - 100 * DAY } : e));
    const now = drives[2]!.startedAt + DAY;
    expect(detectSpots(moved, evs, now)).toHaveLength(1); // 101 days: still in
    const old = moved.map((d, i) => (i === 0 ? { ...d, startedAt: now - 121 * DAY } : d));
    const oldEv = evs.map((e, i) => (i === 0 ? { ...e, startedAt: now - 121 * DAY } : e));
    expect(detectSpots(old, oldEv, now)).toEqual([]);
  });

  test('at most 5 active spots, best rate first', () => {
    const drives: SpotDrive[] = [];
    const events: SpotEvent[] = [];
    // Six brake places 200 m apart; place k is hit on every drive for k = 0, and less often after.
    const n = 12;
    for (let i = 0; i < n; i++) {
      const d = drive(`d${String(i).padStart(2, '0')}`, i);
      drives.push(d);
      for (let k = 0; k < 6; k++) {
        const hit = k === 0 || i % (k + 1) === 0 || i >= n - 3;
        if (hit) events.push(ev(`e${k}-${String(i).padStart(2, '0')}`, d, 'hard_brake', [300 + 200 * k, 0]));
      }
    }
    const spots = detectSpots(drives, events, T0 + n * DAY);
    expect(spots).toHaveLength(5);
    expect(spots.map((s) => s.rank)).toEqual([1, 2, 3, 4, 5]);
    const rates = spots.map((s) => s.rate);
    expect([...rates].sort((a, b) => b - a)).toEqual(rates);
    expect(spots[0]!.id).toBe('hard_brake:e0-00');
  });

  test('a cleared spot is kept for the footnote for 30 days, then dropped', () => {
    // 3 hits, then 10 clean passes clear it (K = 5 at p 0.44).
    const { drives, events } = brakeRoad(13, (i) => i < 3);
    const r = detectSpots(drives, events, T0 + 13 * DAY);
    expect(r).toHaveLength(1);
    expect(r[0]).toMatchObject({ state: 'cleared', rank: 0 });
    const clearedAt = r[0]!.clearedAt!;
    expect(clearedAt).toBeGreaterThan(drives[2]!.startedAt);
    expect(detectSpots(drives, events, clearedAt + 30 * DAY)).toHaveLength(1);
    expect(detectSpots(drives, events, clearedAt + 31 * DAY)).toEqual([]);
  });
});

describe('geometry', () => {
  test('a speed segment starts at the earliest entry, its pin is that start, and it is 120 to 600 m long', () => {
    const drives = [0, 1, 2].map((i) => drive(`d${i}`, i));
    const events = drives.map((d, i) => ev(`e${i}`, d, 'speeding', [500 + 40 * i, 0], { speedMph: 40, durationS: 10 }));
    const s = detectSpots(drives, events, T0 + 3 * DAY)[0]!;
    expect(metres(s.pin, at(500, 0))).toBeLessThan(2);
    expect(metres(s.segment[0]!, at(500, 0))).toBeLessThan(2);
    // From 500 m to the latest end (580 + 179 m).
    expect(length(s.segment)).toBeCloseTo(80 + 40 * 0.44704 * 10, -1);
    expect(Math.abs(s.headingDeg)).toBeLessThan(1);

    // A short episode is grown to 120 m; a long one is held to 600 m.
    const short = drives.map((d, i) => ev(`s${i}`, d, 'speeding', [500, 0], { speedMph: 40, durationS: 2 }));
    expect(length(detectSpots(drives, short, T0 + 3 * DAY)[0]!.segment)).toBeCloseTo(120, 0);
    const long = drives.map((d, i) => ev(`l${i}`, d, 'speeding', [200 + 50 * i, 0], { speedMph: 60, durationS: 40 }));
    expect(length(detectSpots(drives, long, T0 + 3 * DAY)[0]!.segment)).toBeCloseTo(600, 0);
  });

  test("point spots draw their kind's road before and after the pin", () => {
    const drives = [0, 1, 2].map((i) => drive(`d${i}`, i));
    const check = (type: 'hard_brake' | 'hard_accel', before: number, after: number) => {
      const s = detectSpots(drives, drives.map((d, i) => ev(`${type}${i}`, d, type, [1000, 0])), T0 + 3 * DAY)[0]!;
      expect(length(s.segment)).toBeCloseTo(before + after, 0);
      expect(haversineMeters(s.segment[0]!, s.pin)).toBeCloseTo(before, 0);
    };
    check('hard_brake', 60, 20);
    check('hard_accel', 20, 60);
    const turns = drives.map((d) => ({ ...d, runs: [TURN] }));
    const t = detectSpots(turns, turns.map((d, i) => ev(`t${i}`, d, 'hard_corner', [1000, 0])), T0 + 3 * DAY)[0]!;
    expect(haversineMeters(t.segment[0]!, t.pin)).toBeCloseTo(40, 0);
  });

  test("a speed spot's limit is its events' most common one, a tie to the lower", () => {
    expect(modeLimit([35, 45, 35, null])).toBe(35);
    expect(modeLimit([45, 35])).toBe(35);
    expect(modeLimit([null, null])).toBeNull();
    const drives = [0, 1, 2].map((i) => drive(`d${i}`, i));
    const events = drives.map((d, i) => ev(`e${i}`, d, 'speeding', [500, 0], { limitMph: i === 0 ? 45 : 30 }));
    expect(detectSpots(drives, events, T0 + 3 * DAY)[0]!.limitMph).toBe(30);
    const brakes = drives.map((d, i) => ev(`b${i}`, d, 'hard_brake', [1000, 0]));
    expect(detectSpots(drives, brakes, T0 + 3 * DAY)[0]!.limitMph).toBeNull();
  });
});

describe('determinism', () => {
  test('shuffled inputs give the same spots, and ids are kind:anchor event', () => {
    const { drives, events } = brakeRoad(12, (i) => i % 3 !== 2);
    const speed = drives.flatMap((d, i) => (i % 2 === 0 ? [ev(`s${String(i).padStart(3, '0')}`, d, 'speeding', [400, 0])] : []));
    const all = [...events, ...speed];
    const now = T0 + 12 * DAY;
    const want = detectSpots(drives, all, now);
    expect(want.map((s) => s.id)).toEqual(['hard_brake:de000', 'speeding:s000']);
    const rnd = seeded(7);
    for (let k = 0; k < 5; k++) expect(detectSpots(shuffle(drives, rnd), shuffle(all, rnd), now)).toEqual(want);
  });
});

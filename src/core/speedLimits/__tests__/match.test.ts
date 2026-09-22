/** @jest-environment node */
import { type Candidate, MATCH, matchLimit, type MatchResult } from '@/core/speedLimits/match';

let seq = 0;
const cand = (over: Partial<Candidate> = {}): Candidate => ({
  provider: 'osm',
  key: `osm:${(seq += 1)}`,
  limitMph: 35,
  highway: 'secondary',
  oneway: 0,
  distanceM: 5,
  bearingDeg: 90,
  ...over,
});

const UNKNOWN: Omit<MatchResult, 'parallelRoads'> = {
  limitMph: null,
  source: 'unknown',
  matchConfidence: 0,
  provider: null,
  key: null,
};

describe('MATCH', () => {
  it('holds the contract values', () => {
    expect(MATCH).toEqual({
      RADIUS_M: 25,
      HEADING_TOL_DEG: 45,
      PARALLEL_MARGIN_M: 10,
      HPMS_JOIN_M: 15,
      CONF_SINGLE_NEAR: 0.95,
      CONF_SINGLE: 0.85,
      CONF_PARALLEL: 0.6,
      CONF_RAMP: 0.65,
      CONF_HPMS_PENALTY: 0.1,
      CONF_AWS: 0.7,
      MAX_CANDIDATES: 20,
    });
  });
});

describe('matchLimit — no course, no road', () => {
  it('an unknown course is unknown, even with a perfect candidate beside the car', () => {
    expect(matchLimit(null, [cand({ distanceM: 1 })])).toEqual({ ...UNKNOWN, parallelRoads: false });
  });

  it.each([-1, Number.NaN, Number.POSITIVE_INFINITY])('a course of %p is unknown', (course) => {
    expect(matchLimit(course, [cand({ distanceM: 1 })]).source).toBe('unknown');
  });

  it('no candidates is unknown', () => {
    expect(matchLimit(90, [])).toEqual({ ...UNKNOWN, parallelRoads: false });
  });
});

describe('matchLimit — a single road', () => {
  it('within 10 m: posted at 0.95, naming the provider and key', () => {
    const c = cand({ key: 'osm:42', distanceM: 10 });
    expect(matchLimit(92, [c])).toEqual({
      limitMph: 35,
      source: 'posted',
      matchConfidence: 0.95,
      parallelRoads: false,
      provider: 'osm',
      key: 'osm:42',
    });
  });

  it('within 25 m: 0.85', () => {
    expect(matchLimit(90, [cand({ distanceM: 10.01 })]).matchConfidence).toBe(0.85);
    expect(matchLimit(90, [cand({ distanceM: 25 })]).matchConfidence).toBe(0.85);
  });

  it('beyond 25 m: unknown', () => {
    expect(matchLimit(90, [cand({ distanceM: 25.01 })]).source).toBe('unknown');
  });

  it('a *_link ramp: 0.65', () => {
    const r = matchLimit(90, [cand({ highway: 'primary_link', distanceM: 3 })]);
    expect(r).toMatchObject({ limitMph: 35, source: 'posted', matchConfidence: 0.65 });
  });
});

describe('matchLimit — heading', () => {
  it('passes within ±45° of the digitised bearing, inclusive', () => {
    expect(matchLimit(135, [cand()]).source).toBe('posted');
    expect(matchLimit(45, [cand()]).source).toBe('posted');
    expect(matchLimit(135.01, [cand()]).source).toBe('unknown');
    expect(matchLimit(44.99, [cand()]).source).toBe('unknown');
  });

  it('wraps through north', () => {
    expect(matchLimit(350, [cand({ bearingDeg: 10 })]).source).toBe('posted');
    expect(matchLimit(10, [cand({ bearingDeg: 350 })]).source).toBe('posted');
  });

  it('a two-way road also passes against its digitised direction', () => {
    expect(matchLimit(270, [cand({ oneway: 0 })]).source).toBe('posted');
  });

  it('a one-way road (1) passes only along its digitised direction', () => {
    expect(matchLimit(90, [cand({ oneway: 1 })]).source).toBe('posted');
    expect(matchLimit(270, [cand({ oneway: 1 })]).source).toBe('unknown');
  });

  it('a reversed one-way road (-1) passes only against its digitised direction', () => {
    expect(matchLimit(270, [cand({ oneway: -1 })]).source).toBe('posted');
    expect(matchLimit(90, [cand({ oneway: -1 })]).source).toBe('unknown');
  });

  it('a crossing street does not match, however close', () => {
    expect(matchLimit(90, [cand({ bearingDeg: 0, distanceM: 1 })]).source).toBe('unknown');
  });

  it('a candidate with no bearing (a line with no extent) never matches', () => {
    expect(matchLimit(90, [cand({ bearingDeg: Number.NaN, distanceM: 1 })]).source).toBe('unknown');
  });

  it('the nearest heading-passing road wins over a nearer crossing street', () => {
    const r = matchLimit(90, [
      cand({ key: 'osm:cross', bearingDeg: 0, distanceM: 2, limitMph: 25 }),
      cand({ key: 'osm:main', distanceM: 8, limitMph: 35 }),
    ]);
    expect(r).toMatchObject({ key: 'osm:main', limitMph: 35, matchConfidence: 0.95, parallelRoads: false });
  });
});

describe('matchLimit — parallel roads', () => {
  it('another road within best + 10 m with a different limit: best road at 0.6, flagged', () => {
    const r = matchLimit(90, [
      cand({ key: 'osm:main', distanceM: 3, limitMph: 35 }),
      cand({ key: 'osm:side', distanceM: 13, limitMph: 25, highway: 'residential' }),
    ]);
    expect(r).toMatchObject({ key: 'osm:main', limitMph: 35, matchConfidence: 0.6, parallelRoads: true });
  });

  it('a different class at the same limit is still a parallel road', () => {
    const r = matchLimit(90, [cand({ distanceM: 3 }), cand({ distanceM: 6, highway: 'tertiary' })]);
    expect(r).toMatchObject({ matchConfidence: 0.6, parallelRoads: true });
  });

  it('the same limit and class (a split way, the other half of the road) is not', () => {
    const r = matchLimit(90, [cand({ distanceM: 3 }), cand({ distanceM: 6 })]);
    expect(r).toMatchObject({ matchConfidence: 0.95, parallelRoads: false });
  });

  it('a road more than 10 m further out is not', () => {
    const r = matchLimit(90, [cand({ distanceM: 3 }), cand({ distanceM: 13.01, limitMph: 25 })]);
    expect(r).toMatchObject({ matchConfidence: 0.95, parallelRoads: false });
  });

  it('a parallel road going the other way on a one-way is not', () => {
    const r = matchLimit(90, [cand({ distanceM: 3 }), cand({ distanceM: 6, limitMph: 25, oneway: 1, bearingDeg: 270 })]);
    expect(r).toMatchObject({ matchConfidence: 0.95, parallelRoads: false });
  });

  it('a ramp beside a parallel road takes the lower of the two confidences', () => {
    const r = matchLimit(90, [cand({ distanceM: 3, highway: 'primary_link' }), cand({ distanceM: 6, limitMph: 45, highway: 'primary' })]);
    expect(r.matchConfidence).toBe(0.6);
  });
});

describe('matchLimit — untagged roads and HPMS', () => {
  it('an untagged OSM road with nothing else is unknown — never a guess', () => {
    expect(matchLimit(90, [cand({ limitMph: null, highway: 'residential' })])).toEqual({
      ...UNKNOWN,
      parallelRoads: false,
    });
  });

  it('an untagged nearest road does not borrow a farther road’s limit', () => {
    const r = matchLimit(90, [
      cand({ key: 'osm:lane', limitMph: null, highway: 'service', distanceM: 2 }),
      cand({ key: 'osm:arterial', limitMph: 45, highway: 'primary', distanceM: 11 }),
    ]);
    expect(r).toMatchObject({ limitMph: null, source: 'unknown', provider: null, key: null, parallelRoads: true });
  });

  it('an untagged OSM road with an HPMS section within 15 m: the HPMS limit, posted, 0.1 lower', () => {
    const r = matchLimit(90, [
      cand({ key: 'osm:7', limitMph: null, highway: 'residential', distanceM: 4 }),
      cand({ key: 'hpms:9', provider: 'hpms', limitMph: 30, highway: 'hpms', distanceM: 6 }),
    ]);
    expect(r).toEqual({
      limitMph: 30,
      source: 'posted',
      matchConfidence: 0.85,
      parallelRoads: false,
      provider: 'hpms',
      key: 'hpms:9',
    });
  });

  it('the HPMS penalty applies on top of the distance confidence', () => {
    const r = matchLimit(90, [
      cand({ limitMph: null, highway: 'residential', distanceM: 18 }),
      cand({ provider: 'hpms', limitMph: 30, highway: 'hpms', distanceM: 20 }),
    ]);
    expect(r.matchConfidence).toBe(0.75);
  });

  it('an HPMS section more than 15 m from the untagged road does not join', () => {
    const r = matchLimit(90, [
      cand({ limitMph: null, highway: 'residential', distanceM: 2 }),
      cand({ provider: 'hpms', limitMph: 30, highway: 'hpms', distanceM: 17.01 }),
    ]);
    expect(r.source).toBe('unknown');
  });

  it('an untagged lane does not take the HPMS limit of the arterial beside it', () => {
    // Lane at 2 m (untagged), arterial at 11 m (untagged in OSM), HPMS for the arterial at 12 m:
    // the HPMS section is within 15 m of the lane's distance, but it sits with the arterial.
    const r = matchLimit(90, [
      cand({ key: 'osm:lane', limitMph: null, highway: 'service', distanceM: 2 }),
      cand({ key: 'osm:arterial', limitMph: null, highway: 'primary', distanceM: 11 }),
      cand({ provider: 'hpms', limitMph: 45, highway: 'hpms', distanceM: 12 }),
    ]);
    expect(r).toMatchObject({ source: 'unknown', limitMph: null, parallelRoads: true });
  });

  it('an HPMS section that fails the heading test does not join', () => {
    const r = matchLimit(90, [
      cand({ limitMph: null, highway: 'residential', distanceM: 2 }),
      cand({ provider: 'hpms', limitMph: 30, highway: 'hpms', distanceM: 3, bearingDeg: 0 }),
    ]);
    expect(r.source).toBe('unknown');
  });

  it('two joining HPMS sections that disagree are unknown', () => {
    const r = matchLimit(90, [
      cand({ limitMph: null, highway: 'residential', distanceM: 2 }),
      cand({ provider: 'hpms', limitMph: 30, highway: 'hpms', distanceM: 3 }),
      cand({ provider: 'hpms', limitMph: 40, highway: 'hpms', distanceM: 4 }),
    ]);
    expect(r.source).toBe('unknown');
  });

  it('HPMS never overrides a posted OSM limit', () => {
    const r = matchLimit(90, [
      cand({ key: 'osm:1', limitMph: 35, distanceM: 4 }),
      cand({ provider: 'hpms', limitMph: 30, highway: 'hpms', distanceM: 2 }),
    ]);
    expect(r).toMatchObject({ limitMph: 35, provider: 'osm', key: 'osm:1', matchConfidence: 0.95 });
  });

  it('an HPMS section with no OSM road near is unknown (HPMS only fills an untagged road)', () => {
    expect(matchLimit(90, [cand({ provider: 'hpms', limitMph: 30, highway: 'hpms', distanceM: 3 })]).source).toBe(
      'unknown'
    );
  });

  it('an out-of-range limit on a candidate counts as untagged', () => {
    expect(matchLimit(90, [cand({ limitMph: 90 })]).source).toBe('unknown');
    expect(matchLimit(90, [cand({ limitMph: 32.5 })]).source).toBe('unknown');
  });
});

describe('matchLimit — the AWS cache', () => {
  it('a cache segment with no open-data road near: cached at 0.7', () => {
    const r = matchLimit(90, [cand({ key: 'aws:abc', provider: 'aws', limitMph: 45, highway: 'aws', distanceM: 3 })]);
    expect(r).toEqual({
      limitMph: 45,
      source: 'cached',
      matchConfidence: 0.7,
      parallelRoads: false,
      provider: 'aws',
      key: 'aws:abc',
    });
  });

  it('fills an untagged OSM road it runs along, like HPMS, when HPMS has nothing', () => {
    const r = matchLimit(90, [
      cand({ limitMph: null, highway: 'residential', distanceM: 2 }),
      cand({ key: 'aws:abc', provider: 'aws', limitMph: 45, highway: 'aws', distanceM: 5 }),
    ]);
    expect(r).toMatchObject({ limitMph: 45, source: 'cached', provider: 'aws', key: 'aws:abc', matchConfidence: 0.7 });
  });

  it('HPMS (posted open data) beats the cache on an untagged road', () => {
    const r = matchLimit(90, [
      cand({ limitMph: null, highway: 'residential', distanceM: 2 }),
      cand({ provider: 'aws', limitMph: 45, highway: 'aws', distanceM: 3 }),
      cand({ provider: 'hpms', limitMph: 30, highway: 'hpms', distanceM: 4 }),
    ]);
    expect(r).toMatchObject({ limitMph: 30, source: 'posted', provider: 'hpms' });
  });

  it('a posted OSM limit beats a nearer cache segment', () => {
    const r = matchLimit(90, [
      cand({ provider: 'aws', limitMph: 45, highway: 'aws', distanceM: 1 }),
      cand({ key: 'osm:1', limitMph: 35, distanceM: 4 }),
    ]);
    expect(r).toMatchObject({ limitMph: 35, source: 'posted', key: 'osm:1' });
  });

  it('a cache segment beyond the join distance of the untagged road does not fill it', () => {
    const r = matchLimit(90, [
      cand({ limitMph: null, highway: 'residential', distanceM: 1 }),
      cand({ provider: 'aws', limitMph: 45, highway: 'aws', distanceM: 16.01 }),
    ]);
    expect(r.source).toBe('unknown');
  });
});

describe('MatchResult (type level)', () => {
  it('makes an unknown answer with a limit, or a known one without, a compile-time error', () => {
    const r = matchLimit(90, []);
    if (r.source === 'unknown') {
      const none: null = r.limitMph;
      const zero: 0 = r.matchConfidence;
      expect([none, zero]).toEqual([null, 0]);
    } else {
      const mph: number = r.limitMph;
      expect(mph).toBeGreaterThan(0);
    }
    // @ts-expect-error unknown carries no limit
    const a: MatchResult = { limitMph: 25, source: 'unknown', matchConfidence: 0, parallelRoads: false, provider: null, key: null };
    // @ts-expect-error posted needs a limit
    const b: MatchResult = { limitMph: null, source: 'posted', matchConfidence: 0.9, parallelRoads: false, provider: 'osm', key: 'osm:1' };
    // @ts-expect-error cached comes only from the AWS cache
    const c: MatchResult = { limitMph: 40, source: 'cached', matchConfidence: 0.7, parallelRoads: false, provider: 'hpms', key: 'hpms:1' };
    expect([a, b, c]).toHaveLength(3);
  });
});

describe('matchLimit — invariants', () => {
  it('never produces statutory, never a limit with unknown, confidence always in 0..1 (R17, honesty)', () => {
    // Deterministic pseudo-random candidate sets.
    let s = 12345;
    const rnd = (): number => ((s = (s * 1103515245 + 12345) % 2 ** 31) / 2 ** 31);
    const pick = <T,>(xs: readonly T[]): T => xs[Math.floor(rnd() * xs.length)] as T;
    for (let i = 0; i < 2000; i += 1) {
      const cs = Array.from({ length: Math.floor(rnd() * 6) }, () =>
        cand({
          provider: pick(['osm', 'osm', 'hpms', 'aws'] as const),
          limitMph: pick([null, 20, 25, 30, 35, 45, 60, 90] as const),
          highway: pick(['primary', 'residential', 'primary_link', 'service'] as const),
          oneway: pick([-1, 0, 1] as const),
          distanceM: rnd() * 40,
          bearingDeg: rnd() * 360,
        })
      );
      const course = pick([null, -1, rnd() * 360] as const);
      const r = matchLimit(course, cs);
      expect(r.source).not.toBe('statutory');
      expect(r.matchConfidence).toBeGreaterThanOrEqual(0);
      expect(r.matchConfidence).toBeLessThanOrEqual(1);
      if (r.source === 'unknown') {
        expect(r).toMatchObject({ limitMph: null, provider: null, key: null, matchConfidence: 0 });
      } else {
        expect(r.limitMph).not.toBeNull();
        expect(Number.isInteger(r.limitMph)).toBe(true);
        expect(r.limitMph as number).toBeGreaterThanOrEqual(5);
        expect(r.limitMph as number).toBeLessThanOrEqual(85);
        expect(r.provider === 'aws').toBe(r.source === 'cached');
      }
    }
  });

  it('does not mutate or depend on the order of its input', () => {
    const cs = [
      cand({ key: 'osm:a', distanceM: 3 }),
      cand({ key: 'osm:b', distanceM: 6, limitMph: 25 }),
      cand({ key: 'hpms:c', provider: 'hpms', distanceM: 4, limitMph: 30 }),
    ];
    const frozen = Object.freeze(cs.map((c) => Object.freeze({ ...c })));
    const a = matchLimit(90, frozen);
    const b = matchLimit(90, [...frozen].reverse());
    expect(a).toEqual(b);
  });

  it('breaks an exact distance tie by key, so device and server agree', () => {
    const r1 = matchLimit(90, [cand({ key: 'osm:b', distanceM: 5, limitMph: 25 }), cand({ key: 'osm:a', distanceM: 5, limitMph: 35 })]);
    const r2 = matchLimit(90, [cand({ key: 'osm:a', distanceM: 5, limitMph: 35 }), cand({ key: 'osm:b', distanceM: 5, limitMph: 25 })]);
    expect(r1.key).toBe('osm:a');
    expect(r2.key).toBe('osm:a');
  });
});

describe('the candidate cap (the server returns at most 20 nearest)', () => {
  // A 31-road interchange (the real worst case in the WA import: I-205 at Vancouver, WA). The car's
  // road is the 20th nearest; 19 nearer ramps cross its course, and 11 farther roads run parallel
  // to it with a different limit, all within the parallel margin.
  const interchange = (): Candidate[] => {
    const ramps = Array.from({ length: 19 }, (_, i) =>
      cand({ key: `osm:ramp${String(i).padStart(2, '0')}`, highway: 'motorway_link', distanceM: 1 + i * 0.3, bearingDeg: 0, limitMph: 45 })
    );
    const own = cand({ key: 'osm:own', highway: 'primary', distanceM: 8, bearingDeg: 90, limitMph: 35 });
    const far = Array.from({ length: 11 }, (_, i) =>
      cand({ key: `osm:far${String(i).padStart(2, '0')}`, highway: 'motorway', distanceM: 9 + i * 0.5, bearingDeg: 90, limitMph: 60 })
    );
    return [...far, own, ...ramps];
  };

  it('considers only the nearest 20, before the heading test, so the farther parallels do not count', () => {
    const cs = interchange();
    expect(cs).toHaveLength(31);
    expect(matchLimit(90, cs)).toEqual({
      limitMph: 35,
      source: 'posted',
      matchConfidence: 0.95,
      parallelRoads: false,
      provider: 'osm',
      key: 'osm:own',
    });
  });

  it('would have flagged parallel roads without the cap (the 21st onward change the outcome)', () => {
    const cs = interchange();
    // Only the 20 the server would return, plus one of the farther parallels: now it counts.
    const nearest20 = [...cs].sort((a, b) => a.distanceM - b.distanceM).slice(0, 20);
    const withOneMore = [...nearest20.slice(1), cs.find((c) => c.key === 'osm:far00')!];
    expect(matchLimit(90, withOneMore)).toMatchObject({ limitMph: 35, parallelRoads: true, matchConfidence: 0.6 });
  });

  it('answers the same whatever order the candidates arrive in, ties broken by key', () => {
    const cs = interchange();
    // an exact distance tie at the cut: the 20th and 21st are both 8 m; the key decides
    const tie = cand({ key: 'osm:zzz', highway: 'motorway', distanceM: 8, bearingDeg: 90, limitMph: 60 });
    const forward = matchLimit(90, [...cs, tie]);
    const backward = matchLimit(90, [tie, ...cs].reverse());
    expect(backward).toEqual(forward);
    expect(forward).toMatchObject({ key: 'osm:own', parallelRoads: false });
  });

  it('never lets out-of-radius or broken candidates take a slot', () => {
    const cs = interchange();
    const junk = [
      ...Array.from({ length: 5 }, (_, i) => cand({ key: `osm:nan${i}`, distanceM: NaN })),
      ...Array.from({ length: 5 }, (_, i) => cand({ key: `osm:neg${i}`, distanceM: -1 })),
      ...Array.from({ length: 5 }, (_, i) => cand({ key: `osm:out${i}`, distanceM: 26 })),
    ];
    expect(matchLimit(90, [...junk, ...cs])).toEqual(matchLimit(90, cs));
  });
});

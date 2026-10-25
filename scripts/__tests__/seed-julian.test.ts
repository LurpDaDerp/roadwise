import { AXES, isDashcamType, MERIT_RULES, PHONE_PICKUP_MIN_MPH, phonePickupTier, SCORING_VERSION, type DriveEvent } from '@scoring';

import type { FinalizeTripPayloadV5 } from '@/data/sync/payload';
import { decodeRuns } from '@/lib/polyline';

interface Drive {
  trip: { route: string; reverse?: boolean; short?: boolean; kind: string | null; day: { back: number }; startedAtMs: number };
  payload: FinalizeTripPayloadV5;
  stored: { kept: DriveEvent[]; dashcam: { on: boolean }; scored: boolean; reason: string | null; activeEventCount: number };
}
interface Person {
  key: string;
  username: string;
  email: string;
  seed: number;
  share: { rating: boolean; categories: boolean; achievements: boolean; stats: boolean; heatmap: string };
}
interface Report {
  drives: number;
  scored: number;
  clean: number;
  miles90: number;
  rating: number | null;
  rating7: number | null;
  ranked: boolean;
  axes: Record<string, number | null>;
  counts: Record<string, number>;
  merits: Record<string, number>;
  recentMerits: number[];
  achievements: Record<string, boolean>;
  goals: Record<string, string>;
  spots: { kind: string; state: string; clearedDaysAgo: number | null }[];
  trend: { weeksAgo: number; score: number }[];
  disputable: { hazard: unknown; mounted: unknown };
}

/* eslint-disable @typescript-eslint/no-require-imports -- CommonJS Node scripts */
const people = require('../seed-julian/people.js') as { JULIAN: Person; FRIENDS: Person[]; PENDING: Person[] };
const gen = require('../seed-julian/generate.js') as { buildHistory: (p: Person, now: number, o?: object) => Drive[] };
const build = require('../seed-julian/build.js') as { buildPerson: (p: Person, now: number) => { drives: Drive[]; report: Report; draw: number }; julianFailures: (r: Report) => string[] };
const seed = require('../seed-julian/seed.js') as {
  uploadProblem: (p: FinalizeTripPayloadV5) => string | null;
  toEnvelope: (userId: string, p: FinalizeTripPayloadV5, stored: Drive['stored']) => { events: { type: string; status: string; zone: string | null }[]; payload: { origin: string }; scored: boolean; reason: string | null; scoringVersion: number };
  batchSql: (userId: string, items: { payload: FinalizeTripPayloadV5; envelope: unknown }[]) => string;
  parseJson: (out: string) => unknown;
};
/* eslint-enable @typescript-eslint/no-require-imports */

jest.setTimeout(900_000);

const NOW = Date.UTC(2026, 9, 22, 9, 30);
const USER = '00000000-0000-4000-8000-000000000001';
const ALL = [people.JULIAN, ...people.FRIENDS, ...people.PENDING];

const R_M = 6_371_000;
const rad = (d: number) => (d * Math.PI) / 180;
const distanceM = (a: { lat: number; lng: number }, b: { lat: number; lng: number }) => {
  const h = Math.sin(rad(b.lat - a.lat) / 2) ** 2 + Math.cos(rad(a.lat)) * Math.cos(rad(b.lat)) * Math.sin(rad(b.lng - a.lng) / 2) ** 2;
  return 2 * R_M * Math.asin(Math.min(1, Math.sqrt(h)));
};
/** Metres from a point to the nearest stretch of any run (flat projection; plenty for tens of metres). */
const distanceToRuns = (p: { lat: number; lng: number }, runs: { lat: number; lng: number }[][]): number => {
  const k = Math.cos(rad(p.lat)) * 111_320;
  let best = Infinity;
  for (const run of runs) {
    for (let i = 1; i < run.length; i += 1) {
      const a = run[i - 1]!;
      const b = run[i]!;
      const px = (p.lng - a.lng) * k, py = (p.lat - a.lat) * 111_320;
      const bx = (b.lng - a.lng) * k, by = (b.lat - a.lat) * 111_320;
      const len2 = bx * bx + by * by;
      const t = len2 === 0 ? 0 : Math.max(0, Math.min(1, (px * bx + py * by) / len2));
      best = Math.min(best, Math.hypot(px - t * bx, py - t * by));
    }
  }
  return best;
};

describe.each(ALL.map((p) => [p.key, p] as const))('the history of %s', (_key, person) => {
  const drives = gen.buildHistory(person, NOW);

  it('is the same history on every build', () => {
    expect(gen.buildHistory(person, NOW).map((d) => d.payload)).toEqual(drives.map((d) => d.payload));
  });

  it('uploads what a phone would: v5, within the upload contract and the integrity rules, oldest first, before now', () => {
    expect(drives.length).toBeGreaterThan(10);
    for (const d of drives) {
      expect(seed.uploadProblem(d.payload)).toBeNull();
      expect(d.payload.endedAt).toBeLessThan(NOW);
      expect(d.payload.polyline.length).toBeLessThanOrEqual(15_000);
    }
    const starts = drives.map((d) => d.payload.startedAt);
    expect(starts).toEqual([...starts].sort((a, b) => a - b));
    for (const d of drives) for (const v of [d.payload.miles, d.payload.nightMiles]) expect(Math.round(v * 100) / 100).toBe(v);
  });

  it('keeps drives apart: the server would join one started within 300 s and 150 m of the one before', () => {
    for (let i = 1; i < drives.length; i += 1) {
      const prev = drives[i - 1]!.payload;
      const next = drives[i]!.payload;
      const joined = next.startedAt - prev.endedAt <= 300_000 && prev.end && next.start && distanceM(prev.end, next.start) <= 150;
      expect(joined).toBeFalsy();
      expect(next.startedAt).toBeGreaterThan(prev.endedAt);
    }
  });

  it('stores nothing derived: no scores, ratings or points travel with an upload', () => {
    for (const d of drives) {
      const env = JSON.stringify(seed.toEnvelope(USER, d.payload, d.stored));
      expect(env).not.toMatch(/"(rating|safetyRating|score|merit|points|streak|clean|achievements|challenges)"/);
    }
  });

  it('puts every event on the visible route, inside the drive, and measures what the phone measures', () => {
    for (const d of drives) {
      const runs = decodeRuns(d.payload.polyline);
      for (const e of d.payload.events) {
        // the app snaps an event to its own drive's route within 30 m (problem spots)
        expect(distanceToRuns({ lat: e.lat!, lng: e.lng! }, runs)).toBeLessThan(25);
        expect(e.startedAt).toBeGreaterThanOrEqual(d.payload.startedAt + 30_000);
        expect(e.startedAt + e.durationS * 1000).toBeLessThanOrEqual(d.payload.endedAt);
        if (e.type === 'speeding') {
          expect(e.durationS).toBeGreaterThanOrEqual(1);
          expect(e.measured.overMphS).toBeGreaterThan(0);
        }
        if (e.type === 'phone_pickup') {
          expect(Number.isInteger(e.durationS) && e.durationS >= 1).toBe(true);
          expect(e.tier).toBe(phonePickupTier(e.durationS));
          expect(e.measured.speedMph).toBeGreaterThanOrEqual(PHONE_PICKUP_MIN_MPH);
        }
      }
      const x = d.payload.exposure!;
      expect(x.limitS).toBeLessThanOrEqual(x.movingS);
      expect(x.movingS).toBeLessThanOrEqual(d.payload.durationS);
      expect(x.phoneS).toBeLessThanOrEqual(Math.ceil(d.payload.miles * 360 * 1.25) + 60);
      expect(x.movingS).toBeLessThanOrEqual(Math.ceil(d.payload.miles * 720 * 1.25) + 60);
    }
  });

  it('builds the envelope finalize-trip would, agreeing with apply_drive', () => {
    for (const d of drives) {
      const env = seed.toEnvelope(USER, d.payload, d.stored);
      expect(d.stored.activeEventCount).toBe(env.events.filter((e) => !isDashcamType(e.type as Parameters<typeof isDashcamType>[0])).length);
      expect(env.events.every((e) => e.status === 'active')).toBe(true);
      expect([env.scored, env.reason]).toEqual(d.trip.short ? [false, 'too_short'] : [true, null]);
      expect(env.scoringVersion).toBe(SCORING_VERSION);
    }
  });
});

const heavy = process.env.SEED_JULIAN_FULL === '1' ? describe : describe.skip;

heavy('Julian', () => {
  const built = build.buildPerson(people.JULIAN, NOW);
  const r = built.report;

  it('meets every condition of the demo story', () => {
    expect(build.julianFailures(r)).toEqual([]);
  });

  it('is ranked, improving, with speeding the one bad category and every other one between 75 and 100', () => {
    expect(r.ranked).toBe(true);
    expect(r.rating! - r.rating7!).toBeGreaterThan(0);
    expect(Object.keys(r.axes).sort()).toEqual([...AXES].sort());
    const scores = Object.values(r.axes) as number[];
    expect(scores.every((v) => v > 0 && v <= 100)).toBe(true);
    expect(r.axes.speed).toBeGreaterThanOrEqual(24);
    expect(r.axes.speed).toBeLessThanOrEqual(36);
    const rest = Object.entries(r.axes).filter(([k]) => k !== 'speed').map(([, v]) => v as number);
    expect(Math.min(...rest)).toBeGreaterThanOrEqual(75);
    expect(Math.max(...rest) - Math.min(...rest)).toBeGreaterThanOrEqual(6);
    expect(Object.values(r.achievements).every(Boolean)).toBe(true);
    expect(Object.keys(r.counts).sort()).toEqual(expect.arrayContaining(['drowsy', 'eyes_off', 'hard_accel', 'hard_brake', 'phone_pickup', 'speeding']));
  });

  it('has a long, realistic history: about 90 days, ranked mileage, some clean drives', () => {
    expect(r.drives).toBeGreaterThanOrEqual(170);
    expect(r.miles90).toBeGreaterThan(700);
    expect(r.clean / r.scored).toBeGreaterThan(0.1);
    expect(built.drives.some((d) => d.stored.reason === 'too_short')).toBe(true);
    expect(built.drives.some((d) => d.trip.kind === 'passenger')).toBe(true);
    expect(built.drives.some((d) => d.payload.nightMiles > 0)).toBe(true);
  });

  it('shows improvement: the weekly average drive score rises from the first weeks to the last', () => {
    const mean = (xs: number[]) => xs.reduce((s, x) => s + x, 0) / xs.length;
    const early = mean(r.trend.filter((w) => w.weeksAgo >= 9).map((w) => w.score));
    const late = mean(r.trend.filter((w) => w.weeksAgo <= 2).map((w) => w.score));
    expect(late - early).toBeGreaterThanOrEqual(4);
  });

  it('spans every merit tier, the top two on long drives', () => {
    expect(Object.keys(r.merits).map(Number).sort()).toEqual([1, 2, 3, 4, 5]);
    expect(r.recentMerits.length).toBeGreaterThanOrEqual(4);
    expect(MERIT_RULES.map((m) => m.minMiles)).toEqual([25, 10, 4, 1]);
  });

  it('leaves problem spots to show: speeding active, one cleared lately', () => {
    const active = r.spots.filter((s) => s.state === 'active');
    expect(active.map((s) => s.kind)).toContain('speeding');
    expect(active.length).toBeGreaterThanOrEqual(3);
    expect(r.spots.some((s) => s.state === 'cleared' && s.clearedDaysAgo! <= 30)).toBe(true);
  });

  it('has a ride as a passenger to mark', () => {
    const passenger = built.drives.find((d) => d.trip.kind === 'passenger')!;
    expect(NOW - passenger.payload.endedAt).toBeLessThan(24 * 3_600_000);
  });
});

heavy('the friends', () => {
  const bands: Record<string, [number, number]> = {
    maya: [89.5, 93],
    sofia: [81, 83],
    ethan: [77.5, 80],
    priya: [74, 77],
    marcus: [69, 73],
    liam: [66, 72],
    olivia: [83, 86],
  };
  it.each([...people.FRIENDS, ...people.PENDING].map((p) => [p.key, p] as const))('%s drives about as well as the demo needs', (key, person) => {
    const r = build.buildPerson(person, NOW).report;
    expect(r.ranked).toBe(true);
    expect(r.rating).toBeGreaterThanOrEqual(bands[key]![0]);
    expect(r.rating).toBeLessThanOrEqual(bands[key]![1]);
  }, 600_000);

  it('ranks Maya first of the friends board, and one friend keeps the details private', () => {
    const ratings = [people.JULIAN, ...people.FRIENDS].map((p) => ({ key: p.key, rating: build.buildPerson(p, NOW).report.rating! })).sort((a, b) => b.rating - a.rating);
    expect(ratings[0]!.key).toBe('maya');
    const marcus = people.FRIENDS.find((f) => f.key === 'marcus')!;
    expect(marcus.share).toMatchObject({ rating: true, categories: false, achievements: false, stats: false });
  }, 900_000);
});

describe('the database steps', () => {
  const drives = gen.buildHistory(people.JULIAN, NOW).slice(0, 3);

  it('checks the server context before every apply in a batch', () => {
    const sql = seed.batchSql(
      USER,
      drives.map((d) => ({ payload: d.payload, envelope: seed.toEnvelope(USER, d.payload, d.stored) }))
    );
    expect(sql.startsWith('do $seed$')).toBe(true);
    expect(sql.match(/private\.drive_context\(/g)).toHaveLength(3);
    expect(sql.match(/c -> 'version' <> '23'::jsonb/g)).toHaveLength(3);
    expect(sql.match(/c -> 'phoneUse' <> 'true'::jsonb/g)).toHaveLength(3);
    expect(sql.match(/perform private\.apply_drive\(/g)).toHaveLength(3);
  });

  it('reads the Supabase CLI query output, with status lines around it', () => {
    const rows = [{ n: 1 }];
    expect(seed.parseJson(`Connecting to local database...\n${JSON.stringify({ boundary: 'b', rows }, null, 2)}\n`)).toMatchObject({ rows });
    expect(seed.parseJson(`${JSON.stringify(rows)}\nInitialising login role...\n`)).toEqual(rows);
    expect(seed.parseJson('DO\n')).toBeNull();
  });
});

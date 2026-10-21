import { AXES, isDashcamType, SPEEDING_GRACE_S, type DriveEvent } from '@scoring';

import type { FinalizeTripPayloadV4 } from '@/data/sync/payload';
import { decodeRuns } from '@/lib/polyline';

interface Drive {
  trip: { route: string; reverse: boolean; short?: boolean; day: { back: number } };
  payload: FinalizeTripPayloadV4;
  stored: { kept: DriveEvent[]; dashcam: { on: boolean }; scored: boolean; reason: string | null; activeEventCount: number };
}
interface DemoSpot {
  type: string;
  route: string;
  reverse: boolean;
  at: [number, number];
  rule: { lastDays?: number; newestBefore?: number; count?: number };
}

// eslint-disable-next-line @typescript-eslint/no-require-imports -- a CommonJS Node script
const seed = require('../seed-demo.js') as {
  parseQueryOutput: (out: string) => { rows?: Record<string, unknown>[]; error?: { message: string } } | null;
  buildHistory: (now: number) => Drive[];
  summarize: (drives: Drive[], now: number) => {
    drives: number;
    scored: number;
    clean: number;
    miles90: number;
    rating: number | null;
    ranked: boolean;
    axes: Record<string, number | null>;
    counts: Record<string, number>;
  };
  uploadProblem: (p: FinalizeTripPayloadV4) => string | null;
  toEnvelope: (userId: string, p: FinalizeTripPayloadV4, stored: Drive['stored']) => Record<string, unknown>;
  batchSql: (userId: string, items: { payload: FinalizeTripPayloadV4; envelope: unknown }[]) => string;
  DEMO_SPOTS: DemoSpot[];
};

const DAY = 86_400_000;
// A Monday evening in Seattle, and the six days after it: the calendar shifts with the weekday.
const NOWS = Array.from({ length: 7 }, (_, i) => Date.UTC(2026, 9, 20, 3, 30) + i * DAY);
const USER = '00000000-0000-4000-8000-000000000001';

const R_M = 6_371_000;
const rad = (d: number) => (d * Math.PI) / 180;
const distanceM = (a: { lat: number; lng: number }, b: { lat: number; lng: number }) => {
  const h = Math.sin(rad(b.lat - a.lat) / 2) ** 2 + Math.cos(rad(a.lat)) * Math.cos(rad(b.lat)) * Math.sin(rad(b.lng - a.lng) / 2) ** 2;
  return 2 * R_M * Math.asin(Math.min(1, Math.sqrt(h)));
};

describe.each(NOWS)('the demo history as of %i', (now) => {
  const drives = seed.buildHistory(now);
  const summary = seed.summarize(drives, now);

  it('is the same history on every build', () => {
    expect(seed.buildHistory(now).map((d) => d.payload)).toEqual(drives.map((d) => d.payload));
  });

  it('uploads what a phone would: v4, no integrity refusal, oldest first, before now, never a merge', () => {
    for (const d of drives) {
      expect(seed.uploadProblem(d.payload)).toBeNull();
      expect(d.payload.v).toBe(4);
      expect(d.payload.endedAt).toBeLessThan(now);
      expect([d.payload.origin, d.payload.notDrivingExpired]).toEqual(['manual', false]);
    }
    const starts = drives.map((d) => d.payload.startedAt);
    expect(starts).toEqual([...starts].sort((a, b) => a - b));
    for (const d of drives) for (const v of [d.payload.miles, d.payload.nightMiles]) expect(Math.round(v * 100) / 100).toBe(v);
    // the server would join a drive started within 300 s and 150 m of the one before
    for (let i = 1; i < drives.length; i += 1) {
      const prev = drives[i - 1]!.payload;
      const next = drives[i]!.payload;
      const joined = next.startedAt - prev.endedAt <= 300_000 && prev.end && next.start && distanceM(prev.end, next.start) <= 150;
      expect(joined).toBeFalsy();
    }
  });

  it('carries no phone use and no points anywhere', () => {
    for (const d of drives) {
      for (const e of d.payload.events) expect(['phone_pickup', 'phone_handling']).not.toContain(e.type);
      const env = JSON.stringify(seed.toEnvelope(USER, d.payload, d.stored));
      expect(env).not.toMatch(/"(net|breakdown|streak|safeMiles|isLoop|loopRepeat|safeMilesEarlierToday)"/);
      expect(Object.keys(d.payload)).not.toContain('safeMiles');
      expect(JSON.stringify(d.payload.events)).not.toMatch(/"(units|stoppedInTraffic|mounted|maxSpeedMph)"/);
    }
  });

  it('pins every event on the visible route, inside the drive', () => {
    for (const d of drives) {
      const points = decodeRuns(d.payload.polyline).flat();
      for (const e of d.payload.events) {
        expect(points.some((p) => Math.abs(p.lat - (e.lat ?? NaN)) < 2e-5 && Math.abs(p.lng - (e.lng ?? NaN)) < 2e-5)).toBe(true);
        expect(e.startedAt).toBeGreaterThanOrEqual(d.payload.startedAt + 30_000);
        expect(e.startedAt + e.durationS * 1000).toBeLessThanOrEqual(d.payload.endedAt);
      }
    }
  });

  it('fills every screen: ranked, every event type, a third or so clean, every category scored', () => {
    expect(summary.drives).toBeGreaterThanOrEqual(55);
    expect(summary.drives).toBeLessThanOrEqual(95);
    expect(summary.scored).toBe(summary.drives - 1);
    expect(summary.miles90).toBeGreaterThanOrEqual(100);
    expect(summary.rating).not.toBeNull();
    expect(summary.ranked).toBe(true);
    expect(Object.keys(summary.counts).sort()).toEqual(['drowsy', 'eyes_off', 'hard_accel', 'hard_brake', 'hard_corner', 'speeding'].sort());
    expect(summary.clean / summary.scored).toBeGreaterThan(0.2);
    expect(summary.clean / summary.scored).toBeLessThan(0.6);
    expect(Object.keys(summary.axes).sort()).toEqual([...AXES].sort());
    expect(Object.values(summary.axes).every((v) => v !== null && v > 0 && v <= 100)).toBe(true);
    expect(drives.some((d) => d.payload.nightMiles > 0)).toBe(true);
    expect(drives.some((d) => d.payload.dashcam !== undefined)).toBe(true);
  });

  it('reads like a decent driver: a Safety Rating in the high 70s to 80s, no category under 60', () => {
    expect(summary.rating).toBeGreaterThanOrEqual(77);
    expect(summary.rating).toBeLessThan(90);
    for (const v of Object.values(summary.axes)) expect(v).toBeGreaterThanOrEqual(60);
  });

  it('measures what the phone does: speeding past the grace with its mph-seconds over the line; counters for every drive', () => {
    for (const d of drives) {
      for (const e of d.payload.events) {
        if (e.type === 'speeding') {
          expect(e.durationS).toBeGreaterThan(SPEEDING_GRACE_S);
          expect(e.measured.overMphS).toBeGreaterThan(0);
        }
      }
      const x = d.payload.exposure!;
      expect(x.limitS).toBeLessThanOrEqual(x.movingS);
      expect(x.movingS).toBeLessThanOrEqual(d.payload.durationS);
    }
  });

  it('builds the envelope finalize-trip would, agreeing with apply_drive', () => {
    for (const d of drives) {
      const env = seed.toEnvelope(USER, d.payload, d.stored) as {
        events: { type: Parameters<typeof isDashcamType>[0]; status: string }[];
        dashcam: { on: boolean };
        scored: boolean;
        reason: string | null;
        scoringVersion: number;
        payload: { origin: string; notDrivingExpired: boolean; exposure: unknown };
      };
      expect(d.stored.activeEventCount).toBe(env.events.filter((e) => !isDashcamType(e.type)).length);
      expect(env.events.every((e) => e.status === 'active')).toBe(true);
      expect([env.scored, env.reason]).toEqual(d.trip.short ? [false, 'too_short'] : [true, null]);
      expect([env.scoringVersion, env.payload.origin, env.payload.notDrivingExpired]).toEqual([7, 'manual', false]);
      expect(env.payload.exposure).toEqual(d.payload.exposure);
    }
  });

  it('repeats events at the same places, so spots form: each demo spot is hit within 150 m on 3 drives or more', () => {
    for (const spot of seed.DEMO_SPOTS) {
      const at = { lat: spot.at[0], lng: spot.at[1] };
      const hits = drives.filter((d) => d.payload.events.some((e) => e.type === spot.type && e.lat !== null && e.lng !== null && distanceM({ lat: e.lat, lng: e.lng }, at) <= 150));
      expect(hits.length).toBeGreaterThanOrEqual(3);
      // nothing else happens there: every hit is the spot's own route and direction
      expect(hits.every((d) => d.trip.route === spot.route && d.trip.reverse === spot.reverse)).toBe(true);
      if (spot.rule.newestBefore !== undefined) {
        // a cleared spot: nothing there since
        expect(hits.every((d) => d.trip.day.back >= spot.rule.newestBefore!)).toBe(true);
      } else {
        expect(hits.some((d) => d.trip.day.back < 7)).toBe(true);
      }
    }
  });
});

it('checks the server context before every apply in a batch', () => {
  const drives = seed.buildHistory(NOWS[0]!).slice(0, 3);
  const sql = seed.batchSql(
    USER,
    drives.map((d) => ({ payload: d.payload, envelope: seed.toEnvelope(USER, d.payload, d.stored) }))
  );
  expect(sql.startsWith('do $seed$')).toBe(true);
  expect(sql.match(/private\.drive_context\(/g)).toHaveLength(3);
  expect(sql.match(/c -> 'version' <> '23'::jsonb/g)).toHaveLength(3);
  expect(sql.match(/perform private\.apply_drive\(/g)).toHaveLength(3);
  expect(sql.match(/raise exception/g)).toHaveLength(3);
});

test('the Supabase CLI query output parses in both shapes, with status lines around it', () => {
  const rows = [{ ms: 1792382400000 }];
  expect(seed.parseQueryOutput(`Connecting to local database...\n${JSON.stringify({ boundary: 'b', rows, warning: 'w' }, null, 2)}\n`)).toMatchObject({ rows });
  // The bare array of rows (other CLI versions), with the status line after it.
  expect(seed.parseQueryOutput(`${JSON.stringify(rows, null, 2)}\n\nInitialising login role...\n`)).toEqual({ rows });
  expect(seed.parseQueryOutput('Initialising login role...\n[]\n')).toEqual({ rows: [] });
  expect(seed.parseQueryOutput('DO\n')).toBeNull();
  expect(seed.parseQueryOutput('{ "_tag": "Error", "error": { "message": "boom" } }')).toMatchObject({ error: { message: 'boom' } });
});

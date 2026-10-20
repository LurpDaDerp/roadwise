import { isDashcamType, type DriveBreakdown } from '@scoring';

import type { FinalizeTripPayloadV3 } from '@/data/sync/payload';
import { decodeRuns } from '@/lib/polyline';

interface Drive {
  trip: { route: string; short?: boolean };
  payload: FinalizeTripPayloadV3;
  ctx: { streak: { streak: number; atRisk: boolean; freezes: number; cleanRun: number }; safeMilesEarlierToday: number };
  scored: { breakdown: DriveBreakdown; dashcam: { on: boolean }; streak: { state: { streak: number } } };
}

// eslint-disable-next-line @typescript-eslint/no-require-imports -- a CommonJS Node script
const seed = require('../seed-demo.js') as {
  parseQueryOutput: (out: string) => { rows?: Record<string, unknown>[]; error?: { message: string } } | null;
  buildHistory: (now: number) => Drive[];
  summarize: (drives: Drive[], now: number) => {
    drives: number;
    scored: number;
    clean: number;
    miles30: number;
    rating30: number | null;
    axes30: Record<string, number>;
    counts: Record<string, number>;
    streak: number;
  };
  uploadProblem: (p: FinalizeTripPayloadV3) => string | null;
  toEnvelope: (userId: string, p: FinalizeTripPayloadV3, ctx: Drive['ctx'], scored: Drive['scored']) => Record<string, unknown>;
  batchSql: (userId: string, items: { payload: FinalizeTripPayloadV3; ctx: Drive['ctx']; envelope: unknown }[]) => string;
};

const DAY = 86_400_000;
// A Monday evening in Seattle, and the six days after it: the calendar shifts with the weekday.
const NOWS = Array.from({ length: 7 }, (_, i) => Date.UTC(2026, 9, 20, 3, 30) + i * DAY);
const USER = '00000000-0000-4000-8000-000000000001';

describe.each(NOWS)('the demo history as of %i', (now) => {
  const drives = seed.buildHistory(now);
  const summary = seed.summarize(drives, now);

  it('is the same history on every build', () => {
    expect(seed.buildHistory(now).map((d) => d.payload)).toEqual(drives.map((d) => d.payload));
  });

  it('uploads what a phone would: the contract, no integrity refusal, no loops, oldest first, before now', () => {
    for (const d of drives) {
      expect(seed.uploadProblem(d.payload)).toBeNull();
      expect(d.payload.endedAt).toBeLessThan(now);
    }
    const starts = drives.map((d) => d.payload.startedAt);
    expect(starts).toEqual([...starts].sort((a, b) => a - b));
    // the server stores miles to 2 dp, and the daily cap sums what it stored
    for (const d of drives) for (const v of [d.payload.miles, d.payload.safeMiles, d.payload.nightMiles]) expect(Math.round(v * 100) / 100).toBe(v);
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

  it('fills every screen: ranked, a long current streak, every event type, a third or so clean', () => {
    expect(summary.drives).toBeGreaterThanOrEqual(55);
    expect(summary.drives).toBeLessThanOrEqual(95);
    expect(summary.scored).toBe(summary.drives - 1);
    expect(summary.miles30).toBeGreaterThanOrEqual(100);
    expect(summary.rating30).not.toBeNull();
    expect(summary.streak).toBeGreaterThanOrEqual(10);
    expect(Object.keys(summary.counts).sort()).toEqual(
      ['drowsy', 'eyes_off', 'hard_accel', 'hard_brake', 'hard_corner', 'phone_handling', 'phone_pickup', 'speeding'].sort()
    );
    expect(summary.clean / summary.scored).toBeGreaterThan(0.2);
    expect(summary.clean / summary.scored).toBeLessThan(0.6);
    expect(Object.values(summary.axes30).every((v) => v > 0 && v <= 100)).toBe(true);
    expect(drives.some((d) => d.payload.nightMiles > 0)).toBe(true);
    expect(drives.some((d) => d.payload.dashcam !== undefined)).toBe(true);
  });

  it('builds the envelope finalize-trip would, agreeing with apply_drive', () => {
    for (const d of drives) {
      const env = seed.toEnvelope(USER, d.payload, d.ctx, d.scored) as {
        breakdown: DriveBreakdown;
        events: { type: Parameters<typeof isDashcamType>[0] }[];
        dashcam: { on: boolean };
        streak: { before: { streak: number } };
      };
      expect(env.breakdown.activeEventCount).toBe(env.events.filter((e) => !isDashcamType(e.type)).length);
      expect(env.breakdown.dashcamMult).toBe(env.dashcam.on ? 1.25 : 1);
      expect(env.streak.before.streak).toBe(d.ctx.streak.streak);
    }
  });
});

it('checks the server context before every apply in a batch', () => {
  const drives = seed.buildHistory(NOWS[0]!).slice(0, 3);
  const sql = seed.batchSql(
    USER,
    drives.map((d) => ({ payload: d.payload, ctx: d.ctx, envelope: seed.toEnvelope(USER, d.payload, d.ctx, d.scored) }))
  );
  expect(sql.startsWith('do $seed$')).toBe(true);
  expect(sql.match(/private\.drive_context\(/g)).toHaveLength(3);
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

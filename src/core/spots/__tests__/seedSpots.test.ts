/**
 * The demo account's history (`scripts/seed-demo.js`) makes the spots its `DEMO_SPOTS` table
 * describes: speeding down Dexter and a hard brake in Fremont, both active, and the hard starts at
 * N 39th, cleared in the last 30 days. Run over a week of "now"s, as the seed's own test is.
 */
import { haversineMeters } from '@/lib/geo';
import { decodeRuns } from '@/lib/polyline';

import { detectSpots } from '../detect';
import type { SpotDrive, SpotEvent, SpotKind } from '../types';

interface SeedEvent {
  id: string;
  type: string;
  startedAt: number;
  durationS: number;
  lat: number | null;
  lng: number | null;
  measured: { speedMph?: number; limitMph?: number };
}
interface SeedDrive {
  payload: { clientTripId: string; startedAt: number; polyline: string | null; events: SeedEvent[] };
  stored: { scored: boolean };
}
interface DemoSpot {
  type: SpotKind;
  at: [number, number];
}

// eslint-disable-next-line @typescript-eslint/no-require-imports -- a CommonJS Node script
const seed = require('../../../../scripts/seed-demo.js') as { buildHistory: (now: number) => SeedDrive[]; DEMO_SPOTS: DemoSpot[] };

const DAY = 86_400_000;
const NOWS = Array.from({ length: 7 }, (_, i) => Date.UTC(2026, 9, 20, 3, 30) + i * DAY);
const KINDS = new Set<string>(['speeding', 'hard_brake', 'hard_corner', 'hard_accel']);

/** The seed's drives as the phone would read them back: scored drives with a route, and their located events. */
function inputs(drives: readonly SeedDrive[]): { drives: SpotDrive[]; events: SpotEvent[] } {
  const scored = drives.filter((d) => d.stored.scored && d.payload.polyline);
  return {
    drives: scored.map((d) => ({
      clientTripId: d.payload.clientTripId,
      startedAt: d.payload.startedAt,
      runs: decodeRuns(d.payload.polyline).filter((r) => r.length >= 2),
    })),
    events: scored.flatMap((d) =>
      d.payload.events
        .filter((e) => KINDS.has(e.type) && e.lat !== null && e.lng !== null)
        .map((e) => ({
          id: e.id,
          clientTripId: d.payload.clientTripId,
          type: e.type as SpotKind,
          startedAt: e.startedAt,
          durationS: e.durationS,
          lat: e.lat as number,
          lng: e.lng as number,
          speedMph: e.measured.speedMph ?? null,
          limitMph: e.measured.limitMph ?? null,
        }))
    ),
  };
}

describe.each(NOWS)('the demo history as of %i', (now) => {
  const { drives, events } = inputs(seed.buildHistory(now));
  const spots = detectSpots(drives, events, now);
  const near = (kind: SpotKind, at: [number, number], m: number) => spots.filter((s) => s.kind === kind && haversineMeters(s.pin, { lat: at[0], lng: at[1] }) <= m);
  const [speed, brake, starts] = seed.DEMO_SPOTS;

  it('has an active speeding spot on Dexter', () => {
    expect(speed!.type).toBe('speeding');
    const found = near('speeding', speed!.at, 150);
    expect(found).toHaveLength(1);
    expect(found[0]).toMatchObject({ state: 'active' });
    expect(found[0]!.limitMph).not.toBeNull();
  });

  it('has an active hard-brake spot in Fremont', () => {
    expect(brake!.type).toBe('hard_brake');
    const found = near('hard_brake', brake!.at, 100);
    expect(found).toHaveLength(1);
    expect(found[0]).toMatchObject({ state: 'active' });
  });

  it('has the hard starts at N 39th cleared in the last 30 days', () => {
    expect(starts!.type).toBe('hard_accel');
    const found = near('hard_accel', starts!.at, 100);
    expect(found).toHaveLength(1);
    expect(found[0]).toMatchObject({ state: 'cleared', rank: 0 });
    expect(found[0]!.clearedAt).toBeGreaterThanOrEqual(now - 30 * DAY);
  });
});

// Synthetic closed sessions for the finalize, recovery and sync suites. Lives outside `__tests__/`
// because Jest's default `testMatch` treats every file in there as a suite.
import { createDetectors } from '@/core/detectors';
import { row, T0 } from '@/core/detectors/__fixtures__/rows';
import type { TripSession } from '@/core/engine/engine.types';
import { appendRow, closeSession, createSession } from '@/core/engine/session';
import type { DetectedEvent, FeatureRow } from '@/core/engine/types';

export const TZ = 'America/Los_Angeles';
/** Seattle, heading east. */
export const START = { lat: 47.6062, lng: -122.3321 };
const M_PER_DEG_LNG = 111_194.93 * Math.cos((START.lat * Math.PI) / 180);

export interface DriveOptions {
  /** m/s; default 15 (≈ 34 mph): 15 m per row. */
  speedMps?: number;
  t0?: number;
  /** Every `mockEvery`th row is a mock fix. */
  mockEvery?: number;
  over?: (i: number) => Partial<FeatureRow>;
}

/** `n` 1 Hz rows driving east, the position integrated from the speed. */
export function rows(n: number, opts: DriveOptions = {}): FeatureRow[] {
  const t0 = opts.t0 ?? T0;
  const speed = opts.speedMps ?? 15;
  const out: FeatureRow[] = [];
  let lng = START.lng;
  for (let i = 0; i < n; i += 1) {
    out.push(
      row({
        ts: t0 + i * 1000,
        lat: START.lat,
        lng,
        speed,
        aLonMax: 0.05,
        aLonMin: -0.05,
        ...(opts.mockEvery !== undefined && i % opts.mockEvery === 0 ? { mock: true } : {}),
        ...(opts.over?.(i) ?? {}),
      })
    );
    lng += speed / M_PER_DEG_LNG;
  }
  return out;
}

/** A closed session of `n` rows with the given events, as the engine would hand it to the finalizer. */
export function closedSession(n: number, events: DetectedEvent[] = [], opts: DriveOptions & { clientTripId?: string; unsafeRows?: (i: number) => boolean } = {}): Readonly<TripSession> {
  const t0 = opts.t0 ?? T0;
  const session = createSession({ clientTripId: opts.clientTripId ?? '11111111-1111-4111-8111-111111111111', startedAt: t0 });
  const list = rows(n, opts);
  const det = createDetectors(() => 'x');
  list.forEach((r, i) => {
    det.push(r, { limitMps: null, source: 'unknown', matchConfidence: 0, parallelRoads: false }, { warmupEndsAt: t0 + 30_000, callActive: false, switchSignal: 'reliable', lockDelayMs: null, platform: 'android' });
    appendRow(session, r, opts.unsafeRows?.(i) ?? false);
  });
  session.events.push(...events);
  session.pending = [];
  return closeSession(session, t0 + n * 1000, 'manual');
}

export const uuid = (n: number): string => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;

export const speedingEvent = (startedAt: number, durationS = 20, id = uuid(1)): DetectedEvent => ({
  id,
  type: 'speeding',
  tier: 'minor',
  startedAt,
  durationS,
  measured: { speedMph: 41, limitMph: 35 },
});

export const brakeEvent = (startedAt: number): DetectedEvent => ({
  id: uuid(2),
  type: 'hard_brake',
  tier: 'minor',
  startedAt,
  durationS: 1,
  measured: { peakG: 0.45, speedMph: 25 },
});

/** Problem spots as the screens read them, for the card, sheet and map tests. */
import type { ProblemSpot, SpotsView } from '@/data/queries/spots';

/** Tue, Oct 13 2026, 08:12 local. */
export const LAST_HIT = new Date(2026, 9, 13, 8, 12).getTime();

export function problemSpot(over: Partial<ProblemSpot> = {}): ProblemSpot {
  return {
    id: 'speeding:e1',
    kind: 'speeding',
    state: 'active',
    pin: { lat: 47.6415, lng: -122.3434 },
    headingDeg: 180,
    segment: [
      { lat: 47.6415, lng: -122.3434 },
      { lat: 47.6395, lng: -122.3434 },
    ],
    limitMph: 35,
    hits: 4,
    passes: 6,
    recentHits: 4,
    recentPasses: 6,
    rate: 0.42,
    cleanStreak: 0,
    cleanNeeded: 5,
    lastHitAt: LAST_HIT,
    lastHitTrip: 'trip-9',
    lastPassAt: LAST_HIT,
    clearedAt: null,
    rank: 1,
    label: 'Dexter Ave N',
    ...over,
  };
}

export function spotsView(over: Partial<SpotsView> = {}): SpotsView {
  return { computed: true, eligible: true, active: [problemSpot()], clearedRecently: 0, ...over };
}

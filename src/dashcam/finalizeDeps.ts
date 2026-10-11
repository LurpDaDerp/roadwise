// The DashPal facts dependency both finalize call sites pass (plan §7.7): the drive host's
// `onFinalize` and bootstrap's crash-recovery `finalizeDeps`. It reads SQLite only, so a drive
// finalized as an orphan after a crash still gets its stored dashcam seconds and events.
import type { Db } from '@/data/db/driver';

import { loadDashcamTripFacts, type DashcamTripFacts } from './facts';

export interface DashcamFactsTrip {
  clientTripId: string;
  startedAt: number;
  endedAt: number;
}

export function dashcamFinalizeDeps(db: Db): { dashcamFacts: (trip: DashcamFactsTrip) => Promise<DashcamTripFacts> } {
  return { dashcamFacts: (trip) => loadDashcamTripFacts(db, trip) };
}

import type { Db } from '@/data/db/driver';

/**
 * What a finished drive learned from the DashPal dashcam: the seconds it watched the driver, and
 * the very dangerous episodes (eyes closed, eyes off the road with no return) it saw. Finalize turns
 * the candidates into scored events and the seconds into the DashPal drive flag. This module reads
 * SQLite only: it never imports the BLE transport or link, so finalize stays usable in recovery,
 * headless boots and tests.
 */
export interface DashcamCandidate {
  /** lowercase v4 uuid of the episode's first event */
  id: string;
  kind: 'eyes_off' | 'drowsy';
  /** epoch ms, when the episode's condition started */
  startedAt: number;
  durationS: number;
  /** phone GPS speed near the episode, from a row with a valid fix; null when unknown */
  speedMph: number | null;
}

export interface DashcamTripFacts {
  /** lowercase hex identity MAC of the paired dashcam, or null when it never covered the drive */
  dashcamId: string | null;
  /** seconds of the drive moving at 5 mph or more */
  movingS: number;
  /** of those, seconds the dashcam watched a live face on this phone's primary link */
  coveredS: number;
  /** the phone had every dashcam event persisted within 30 s of the drive's end */
  synced: boolean;
  events: DashcamCandidate[];
}

export async function loadDashcamTripFacts(
  _db: Db,
  _trip: { clientTripId: string; startedAt: number; endedAt: number },
): Promise<DashcamTripFacts> {
  return { dashcamId: null, movingS: 0, coveredS: 0, synced: false, events: [] };
}

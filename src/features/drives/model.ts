/**
 * The local drive shapes the drive screens read (plan §10). They are owned by the data layer
 * (`@/data/queries`); this module re-exports them so every screen imports one place.
 */
import type { EventType, Tier } from '@scoring';

import type { FinalizeTripResponseV3 } from '@/data/sync/payload';

export type DriveStatus = 'recording' | 'pending' | 'scored' | 'unscored' | 'not_driving' | 'merged' | 'failed';

export interface DriveCounts {
  speeding: number;
  pickups: number;
  handlingS: number;
  hardBrake: number;
  hardAccel: number;
  hardCorner: number;
  eyesOff: number;
  drowsy: number;
}

export interface LocalDrive {
  clientTripId: string;
  startedAt: number;
  endedAt: number | null;
  miles: number;
  durationS: number;
  nightMiles: number;
  fromLabel: string | null;
  toLabel: string | null;
  /** Already privacy-trimmed. */
  polyline: string | null;
  status: DriveStatus;
  pointsNet: number | null;
  /** Local scoreDrive until the server answers. */
  estimate: boolean;
  clean: boolean | null;
  counts: DriveCounts;
  dmsOn: boolean;
  result: FinalizeTripResponseV3 | null;
  reason: string | null;
  mergedInto: string | null;
}

export interface LocalDriveEvent {
  id: string;
  type: EventType;
  tier: Tier;
  startedAt: number;
  durationS: number;
  lat: number | null;
  lng: number | null;
  penalty: number | null;
  disputeStatus: 'none' | 'pending' | 'accepted' | 'rejected';
  disputeMessage: string | null;
}

export type HistoryFilter = 'all' | 'clean' | 'negative' | 'passenger';

export type { FinalizeTripResponseV3 };

// The pure rules the drive host applies.
import type { EngineStatus } from '@/core/engine/engine.types';
import type { DetectorContext } from '@/core/engine/types';

export const isBusyStatus = (status: EngineStatus): boolean => status !== 'idle';
export const isIdleStatus = (status: EngineStatus): boolean => status === 'idle';
/** A drive is open (recording). */
export const tripRecords = (status: EngineStatus): boolean => status === 'recording';
export const isDrivingStatus = tripRecords;

/** The per-row detector context from the call state. */
export function detectorContext(callActive: boolean): Omit<DetectorContext, 'warmupEndsAt'> {
  return { callActive };
}

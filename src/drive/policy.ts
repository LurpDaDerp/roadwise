// The pure rules the drive host applies.
import type { MotionActivity } from '@drive-sense';
import { START_MAX_MPH } from '@scoring';

import { MPS_PER_MPH } from '@/core/detectors/common';
import type { EngineStatus } from '@/core/engine/engine.types';
import type { DetectorContext } from '@/core/engine/types';

export const isBusyStatus = (status: EngineStatus): boolean => status !== 'idle';
export const isIdleStatus = (status: EngineStatus): boolean => status === 'idle';
/** A drive is open (recording). */
export const tripRecords = (status: EngineStatus): boolean => status === 'recording';
export const isDrivingStatus = tripRecords;

/** Start Drive works only below this (m/s). */
export const START_MAX_MPS = START_MAX_MPH * MPS_PER_MPH;
/** A speed at or above the line (or unknown-but-fresh fix saying so) refuses a start. */
export const isMoving = (speedMps: number | null): boolean => speedMps !== null && speedMps >= START_MAX_MPS;

/** The per-row detector context from the call state. */
export function detectorContext(callActive: boolean): Omit<DetectorContext, 'tripStartedAt'> {
  return { callActive };
}

/** An OS motion update that says the driver is on foot (a confident walk or run, never an EXIT). */
export function walkingReported(a: MotionActivity): boolean {
  return (a.type === 'walking' || a.type === 'running') && a.confidence !== 'low' && a.exit !== true;
}

// The pure rules the drive host applies.
import type { EngineStatus } from '@/core/engine/engine.types';

export const isBusyStatus = (status: EngineStatus): boolean => status !== 'idle';
/** A drive is open (recording). */
export const tripRecords = (status: EngineStatus): boolean => status === 'recording';

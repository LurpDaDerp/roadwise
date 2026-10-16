// The pure rules the drive host applies.
import type { EngineStatus } from '@/core/engine/engine.types';
import type { PhoneSwitchCtx } from '@/core/detectors/phoneSwitch';
import type { DetectorContext } from '@/core/engine/types';

export const isBusyStatus = (status: EngineStatus): boolean => status !== 'idle';
export const isIdleStatus = (status: EngineStatus): boolean => status === 'idle';
/** A drive is open (recording). */
export const tripRecords = (status: EngineStatus): boolean => status === 'recording';
export const isDrivingStatus = tripRecords;

export { NO_SWITCH, type PhoneSwitchCtx } from '@/core/detectors/phoneSwitch';

/** The per-row detector context from the call state, the drive's switch signal and the platform. */
export function detectorContext(callActive: boolean, phoneSwitch: PhoneSwitchCtx, platform: 'ios' | 'android'): Omit<DetectorContext, 'warmupEndsAt'> {
  return { callActive, switchSignal: phoneSwitch.signal, lockDelayMs: phoneSwitch.lockDelayMs, platform };
}

/**
 * The switch signal for a drive, from `getState()` at the Start tap: Android counts switches
 * exactly; an iPhone with a passcode counts them once it has shown a lock in time (`unproven` until
 * then, proven in-drive too); one without a passcode never does.
 */
export function switchSignalFor(state: { platform: 'ios' | 'android'; lockSignal: 'reliable' | 'lagged' | 'unreliable'; lockProof: boolean; lockDelayMs: number | null }): PhoneSwitchCtx {
  if (state.platform === 'android') return { signal: 'reliable', lockDelayMs: null };
  if (state.lockSignal !== 'lagged') return { signal: 'none', lockDelayMs: null };
  return { signal: state.lockProof ? 'lagged' : 'unproven', lockDelayMs: state.lockDelayMs };
}

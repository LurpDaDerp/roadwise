import type { Detector, DetectorSuite } from '../engine/types';
import { createHarshDetector } from './harsh';
import { createPhoneUseDetector } from './phoneUse';
import { createSpeedingDetector } from './speeding';

export { createHarshDetector } from './harsh';
export { createPhoneUseDetector, type PhoneUseDetector } from './phoneUse';
export type { SwitchSignal } from './phoneSwitch';
export { createSpeedingDetector, type SpeedingDetector } from './speeding';

/**
 * Every detector behind one `push`/`flush`. `push` returns the events that closed on that row;
 * `flush` closes whatever is still open at trip end.
 */
export function createDetectors(newId: () => string): DetectorSuite {
  const speeding = createSpeedingDetector(newId);
  const phone = createPhoneUseDetector(newId);
  const detectors: Detector[] = [speeding, createHarshDetector(newId), phone];
  return {
    push: (row, limit, ctx) => detectors.flatMap((d) => d.push(row, limit, ctx)),
    flush: () => detectors.flatMap((d) => d.flush()),
    openSpeeding: () => speeding.open(),
    speedingNow: () => speeding.reading(),
    speedingEpisode: () => speeding.episode(),
    openPhone: () => phone.open(),
    unsafe: () => speeding.active() || phone.active(),
    lockProof: () => phone.lockProof(),
  };
}

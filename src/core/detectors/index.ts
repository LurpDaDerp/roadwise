import type { Detector, DetectorSuite } from '../engine/types';
import { createHarshDetector } from './harsh';
import { createPhoneUseDetector } from './phoneUse';
import { createSpeedingDetector } from './speeding';

export { createHarshDetector } from './harsh';
export { createPhoneUseDetector, type PhoneUseDetector } from './phoneUse';
export { createSpeedingDetector, type SpeedingDetector } from './speeding';

/**
 * Every detector behind one `push`/`flush`. `push` returns the events that closed on that row;
 * `flush` closes whatever is still open at trip end. The DMS's eyes-off and drowsiness detector
 * (WP8) joins through `extra`.
 */
export function createDetectors(newId: () => string, extra: readonly Detector[] = []): DetectorSuite {
  const speeding = createSpeedingDetector(newId);
  const phone = createPhoneUseDetector(newId);
  const detectors: Detector[] = [speeding, createHarshDetector(newId), phone, ...extra];
  return {
    push: (row, limit, ctx) => detectors.flatMap((d) => d.push(row, limit, ctx)),
    flush: () => detectors.flatMap((d) => d.flush()),
    openSpeeding: () => speeding.open(),
    openPhone: () => phone.open(),
    unsafe: () => speeding.active() || phone.active(),
  };
}

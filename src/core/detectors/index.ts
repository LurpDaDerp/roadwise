import type { Detector, DetectorSuite } from '../engine/types';
import { createFocusDetector } from './focus';
import { createHarshDetector } from './harsh';
import { mergeEvents } from './merge';
import { createPhoneUseDetector, type OpenPhoneEpisode } from './phoneUse';
import { createSpeedingDetector } from './speeding';

export { createFocusDetector } from './focus';
export { createHarshDetector } from './harsh';
export { mergeEvents } from './merge';
export { createPhoneUseDetector } from './phoneUse';
export type { OpenPhoneEpisode, PhoneUseDetector } from './phoneUse';
export { inferRole } from './role';
export type { Role, RoleEvidence, RoleInference } from './role';
export { createSpeedingDetector } from './speeding';
export type { SpeedingDetector } from './speeding';

/** `DetectorSuite` plus the phone-use hook the engine builds the arbiter's `phoneEpisode` from. */
export interface TripDetectors extends DetectorSuite {
  /** The confirmed open phone-use episode (handling or app switch), if any. */
  openPhoneEpisode(): OpenPhoneEpisode | null;
}

/**
 * Every detector behind one `push`/`flush`. `push` returns the events that closed on that row,
 * de-duplicated across detectors; `flush` closes whatever is still open at trip end.
 */
export function createDetectors(newId: () => string): TripDetectors {
  const speeding = createSpeedingDetector(newId);
  const phone = createPhoneUseDetector(newId);
  const detectors: Detector[] = [
    speeding,
    createHarshDetector(newId),
    phone,
    createFocusDetector(newId),
  ];
  return {
    push: (row, limit, ctx) => mergeEvents(detectors.flatMap((d) => d.push(row, limit, ctx))),
    flush: () => mergeEvents(detectors.flatMap((d) => d.flush())),
    markAlerted: (id, ts) => speeding.markAlerted(id, ts),
    openSpeedingEpisodeId: () => speeding.openEpisodeId(),
    openPhoneEpisode: () => phone.openEpisode(),
  };
}

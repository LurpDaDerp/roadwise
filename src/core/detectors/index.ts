import type { Detector, DetectorSuite } from '../engine/types';
import { createFocusDetector } from './focus';
import { createHarshDetector } from './harsh';
import { mergeEvents } from './merge';
import { createPhoneUseDetector } from './phoneUse';
import { createSpeedingDetector } from './speeding';

export { createFocusDetector } from './focus';
export { createHarshDetector } from './harsh';
export { mergeEvents } from './merge';
export { createPhoneUseDetector } from './phoneUse';
export { inferRole } from './role';
export type { Role, RoleEvidence, RoleInference } from './role';
export { createSpeedingDetector } from './speeding';
export type { SpeedingDetector } from './speeding';

/**
 * Every detector behind one `push`/`flush`. `push` returns the events that closed on that row,
 * de-duplicated across detectors; `flush` closes whatever is still open at trip end.
 */
export function createDetectors(newId: () => string): DetectorSuite {
  const speeding = createSpeedingDetector(newId);
  const detectors: Detector[] = [
    speeding,
    createHarshDetector(newId),
    createPhoneUseDetector(newId),
    createFocusDetector(newId),
  ];
  return {
    push: (row, limit, ctx) => mergeEvents(detectors.flatMap((d) => d.push(row, limit, ctx))),
    flush: () => mergeEvents(detectors.flatMap((d) => d.flush())),
    markAlerted: (id, ts) => speeding.markAlerted(id, ts),
    openSpeedingEpisodeId: () => speeding.openEpisodeId(),
  };
}

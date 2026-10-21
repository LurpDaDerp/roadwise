import { SPOT_LABEL_CARRY_M } from '@/data/db/spots';
import { SPOT_READ } from '@/data/queries/spots';

import {
  CLEARED_SHOWN_DAYS,
  LABEL_CARRY_M,
  MIN_DRIVES_FOR_CARD,
  SPOT_KINDS,
  SPOT_MAX_DRIVES,
  SPOT_MAX_EVENTS,
  SPOT_NUDGE_MS,
  SPOT_WINDOW_DAYS,
} from '../constants';

test("the data layer's copy of the read limits matches the spots constants", () => {
  expect(SPOT_READ).toEqual({
    windowDays: SPOT_WINDOW_DAYS,
    maxDrives: SPOT_MAX_DRIVES,
    maxEvents: SPOT_MAX_EVENTS,
    minDrivesForCard: MIN_DRIVES_FOR_CARD,
    clearedShownDays: CLEARED_SHOWN_DAYS,
  });
  expect(SPOT_LABEL_CARRY_M).toBe(LABEL_CARRY_M);
});

test('the four kinds, the 4 s nudge and the 120-day window', () => {
  expect(SPOT_KINDS).toEqual(['speeding', 'hard_brake', 'hard_corner', 'hard_accel']);
  expect(SPOT_NUDGE_MS).toBe(4000);
  expect(SPOT_WINDOW_DAYS).toBe(120);
});

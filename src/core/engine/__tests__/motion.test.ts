import type { MotionActivity } from '@drive-sense';

import { WALK_END_S } from '@scoring';

import { MPS_PER_MPH } from '@/core/detectors/common';
import { carStillDriving, footReading, ON_FOOT_DROP_MS, WALK_CONFIRM_MS, WALK_STALE_FIX_MS, WALKER_PACE_MAX_MPS } from '@/core/engine/motion';

const a = (type: MotionActivity['type'], confidence: MotionActivity['confidence'], exit?: true): MotionActivity => ({ type, confidence, ts: 1, ...(exit ? { exit } : {}) });

describe('footReading (one report, product spec v3 "Ending on its own")', () => {
  test('walking or running at medium or high confidence is on foot (iOS; every Android ENTER is high)', () => {
    for (const type of ['walking', 'running'] as const) {
      expect(footReading(a(type, 'medium'))).toBe('onFoot');
      expect(footReading(a(type, 'high'))).toBe('onFoot');
    }
  });

  test('walking or running at low confidence says nothing either way', () => {
    expect(footReading(a('walking', 'low'))).toBe('unsure');
    expect(footReading(a('running', 'low'))).toBe('unsure');
  });

  test('an Android EXIT of a walk or a run clears, whatever its confidence', () => {
    expect(footReading(a('walking', 'high', true))).toBe('clear');
    expect(footReading(a('running', 'high', true))).toBe('clear');
    expect(footReading(a('walking', 'low', true))).toBe('clear');
  });

  test('automotive, stationary, cycling and unknown clear, at any confidence', () => {
    for (const type of ['automotive', 'stationary', 'cycling', 'unknown'] as const) {
      for (const c of ['low', 'medium', 'high'] as const) expect(footReading(a(type, c))).toBe('clear');
    }
  });
});

test('the walking-end constants', () => {
  expect(WALK_END_S).toBe(5);
  expect(WALK_CONFIRM_MS).toBe(WALK_END_S * 1000);
  expect(WALKER_PACE_MAX_MPS).toBeCloseTo(5 * MPS_PER_MPH, 9);
  expect(ON_FOOT_DROP_MS).toBe(600_000);
  expect(WALK_STALE_FIX_MS).toBe(60_000);
});

describe('carStillDriving (W1 guard)', () => {
  const T = 1_000_000;
  const mph = (v: number) => v * MPS_PER_MPH;
  const last = (v: number, carried: boolean, ts = T) => ({ mps: mph(v), ts, carried });

  test('no reading, or one at or under 3 mph: the car is not driving', () => {
    expect(carStillDriving(null, T)).toBe(false);
    expect(carStillDriving(last(3, false), T)).toBe(false);
    expect(carStillDriving(last(0, false), T)).toBe(false);
  });

  test('over 3 mph from a phone not carried holds, while the reading is at most 60 s old', () => {
    expect(carStillDriving(last(3.4, false), T)).toBe(true);
    expect(carStillDriving(last(3.4, false), T + WALK_STALE_FIX_MS)).toBe(true);
    expect(carStillDriving(last(3.4, false), T + WALK_STALE_FIX_MS + 1)).toBe(false);
    expect(carStillDriving(last(30, false), T + 10_000)).toBe(true);
  });

  test('a carried phone at a walker’s pace (over 3, at most 5 mph) is the driver walking, not the car', () => {
    expect(carStillDriving(last(3.4, true), T)).toBe(false);
    expect(carStillDriving(last(4.8, true), T)).toBe(false);
    expect(carStillDriving({ mps: WALKER_PACE_MAX_MPS, ts: T, carried: true }, T)).toBe(false);
  });

  test('running pace or faster holds even with the phone carried', () => {
    expect(carStillDriving(last(5.5, true), T)).toBe(true);
    expect(carStillDriving(last(30, true), T)).toBe(true);
  });
});

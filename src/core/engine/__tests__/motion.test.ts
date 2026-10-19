import type { MotionActivity } from '@drive-sense';

import { footReading, ON_FOOT_DROP_MS, WALK_CONFIRM_MS, WALK_STALE_FIX_MS } from '@/core/engine/motion';

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
  expect(WALK_CONFIRM_MS).toBe(20_000);
  expect(ON_FOOT_DROP_MS).toBe(600_000);
  expect(WALK_STALE_FIX_MS).toBe(60_000);
});

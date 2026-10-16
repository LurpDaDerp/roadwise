import { inWarmup, rowEligible, SPEED_ACC_MAX_MPS, speedTrusted } from '@/core/detectors/common';
import { ctx, row, T0 } from '@/core/detectors/__fixtures__/rows';

test('a speed is trusted at 2 m/s accuracy or better, or when the phone reports no accuracy (-1)', () => {
  expect(SPEED_ACC_MAX_MPS).toBe(2);
  expect(speedTrusted(row({ speedAcc: 0.5 }))).toBe(true);
  expect(speedTrusted(row({ speedAcc: 0 }))).toBe(true);
  expect(speedTrusted(row({ speedAcc: 2 }))).toBe(true);
  expect(speedTrusted(row({ speedAcc: 2.01 }))).toBe(false);
  expect(speedTrusted(row({ speedAcc: 3 }))).toBe(false);
  expect(speedTrusted(row({ speedAcc: -1 }))).toBe(true);
  expect(speedTrusted(row({ speedAcc: -0.5 }))).toBe(false);
  expect(speedTrusted(row({ speedAcc: Number.NaN }))).toBe(false);
});

test('the warm-up is the time before the context’s warmupEndsAt, whatever the drive’s start', () => {
  const c = ctx({ warmupEndsAt: T0 + 5000 });
  expect(inWarmup(row({ ts: T0 + 4999 }), c)).toBe(true);
  expect(inWarmup(row({ ts: T0 + 5000 }), c)).toBe(false);
  expect(rowEligible(row({ ts: T0 + 4999 }), c)).toBe(false);
  expect(rowEligible(row({ ts: T0 + 5000 }), c)).toBe(true);
  expect(rowEligible(row({ ts: T0 + 5000, hAcc: 25 }), c)).toBe(false);
});

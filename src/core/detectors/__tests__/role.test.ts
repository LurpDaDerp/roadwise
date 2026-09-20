import { inferRole } from '@/core/detectors/role';
import type { RoleEvidence } from '@/core/detectors/role';

const none: RoleEvidence = {
  manualStart: false,
  cameraFaceDriverSeat: false,
  statedPassenger: false,
  continuousHandlingMinutes: 0,
  habitualDriverRoute: false,
  transitPattern: false,
};

test('a stated passenger is authoritative over every other signal', () => {
  const e = { ...none, statedPassenger: true, manualStart: true, cameraFaceDriverSeat: true, transitPattern: true };
  expect(inferRole(e, 0.99)).toEqual({ role: 'passenger', pDriver: 0.02, ask: false });
});

test('a transit pattern is other transport, even against strong driver evidence', () => {
  expect(inferRole({ ...none, transitPattern: true, manualStart: true }, 0.99)).toEqual({
    role: 'other',
    pDriver: 0.05,
    ask: false,
  });
});

test.each(['manualStart', 'cameraFaceDriverSeat'] as const)(
  '%s is strong driver evidence that handling does not dilute',
  (key) => {
    expect(inferRole({ ...none, [key]: true, continuousHandlingMinutes: 10 }, 0.1)).toEqual({
      role: 'driver',
      pDriver: 0.95,
      ask: false,
    });
  }
);

test.each([
  [1, 'driver', false],
  [0.8, 'driver', false],
  [0.79, 'unknown', true],
  [0.5, 'unknown', true],
  [0.21, 'unknown', true],
  [0.2, 'passenger', false],
  [0, 'passenger', false],
])('prior %p with no evidence → %s (ask %p)', (prior, role, ask) => {
  expect(inferRole(none, prior)).toEqual({ role, pDriver: prior, ask });
});

test('three minutes of continuous handling halves P(driver)', () => {
  expect(inferRole({ ...none, continuousHandlingMinutes: 3 }, 0.9)).toEqual({
    role: 'unknown',
    pDriver: 0.45,
    ask: true,
  });
  expect(inferRole({ ...none, continuousHandlingMinutes: 2.99 }, 0.9).pDriver).toBe(0.9);
  expect(inferRole({ ...none, continuousHandlingMinutes: 5 }, 0.3)).toEqual({
    role: 'passenger',
    pDriver: 0.15,
    ask: false,
  });
});

test('a habitual driver route adds 0.15, capped at 0.98', () => {
  const r = inferRole({ ...none, habitualDriverRoute: true }, 0.7);
  expect(r).toMatchObject({ role: 'driver', ask: false });
  expect(r.pDriver).toBeCloseTo(0.85, 12);
  expect(inferRole({ ...none, habitualDriverRoute: true }, 0.9).pDriver).toBe(0.98);
});

test('handling halves before the habitual bonus is added', () => {
  const r = inferRole({ ...none, continuousHandlingMinutes: 3, habitualDriverRoute: true }, 0.9);
  expect(r).toMatchObject({ role: 'unknown', ask: true });
  expect(r.pDriver).toBeCloseTo(0.6, 12);
});

test('an unusable prior falls back to 0.5 and asks; an out-of-range prior is clamped', () => {
  expect(inferRole(none, Number.NaN)).toEqual({ role: 'unknown', pDriver: 0.5, ask: true });
  expect(inferRole(none, 1.5)).toEqual({ role: 'driver', pDriver: 1, ask: false });
  expect(inferRole(none, -0.5)).toEqual({ role: 'passenger', pDriver: 0, ask: false });
});

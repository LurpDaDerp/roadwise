import { contextMultiplier } from '../src/context';
import type { ScorableEvent } from '../src/types';

const ev = (
  category: ScorableEvent['category'],
  night: boolean,
  precipitation: boolean
): ScorableEvent => ({
  id: 'e',
  category,
  startedAt: 0,
  durationS: 1,
  q: 1,
  corrected: false,
  status: 'scored',
  measured: {},
  context: { night, precipitation },
});

test('night applies to phone/speeding/focus only', () => {
  expect(contextMultiplier(ev('phone', true, false))).toBe(1.2);
  expect(contextMultiplier(ev('braking', true, false))).toBe(1);
});

test('precipitation applies to speeding and harsh only', () => {
  expect(contextMultiplier(ev('speeding', false, true))).toBe(1.25);
  expect(contextMultiplier(ev('phone', false, true))).toBe(1);
});

test('product is capped at 1.5', () => expect(contextMultiplier(ev('speeding', true, true))).toBe(1.5));

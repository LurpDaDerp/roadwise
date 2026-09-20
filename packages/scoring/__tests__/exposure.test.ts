import { exposure } from '../src/exposure';

test('worked example: 8 mi, 22 min → 1.1', () => expect(exposure(8 * 1609.344, 22 * 60)).toBeCloseTo(1.1, 6));
test('city: 3 mi, 30 min → 1.5 (time dominates)', () => expect(exposure(3 * 1609.344, 1800)).toBeCloseTo(1.5, 6));
test('floor 0.75', () => expect(exposure(1000, 60)).toBe(0.75));

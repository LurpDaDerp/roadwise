import { kmhToMph, metersToMiles, mphToMps, mpsToMph } from '@/lib/units';

test('converts m/s to mph', () => expect(mpsToMph(10)).toBeCloseTo(22.369, 3));
test('round-trips mph', () => expect(mpsToMph(mphToMps(45))).toBeCloseTo(45, 6));
test('converts meters to miles', () => expect(metersToMiles(1609.344)).toBeCloseTo(1, 6));
test('converts km/h to mph', () => expect(kmhToMph(100)).toBeCloseTo(62.137, 3));

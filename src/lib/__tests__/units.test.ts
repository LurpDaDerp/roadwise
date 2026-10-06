import { distanceIn, formatDistance, formatDistanceProgress, kmhToMph, metersToMiles, mphToMps, mpsToMph, per100In, per100Label } from '@/lib/units';

test('converts m/s to mph', () => expect(mpsToMph(10)).toBeCloseTo(22.369, 3));
test('round-trips mph', () => expect(mpsToMph(mphToMps(45))).toBeCloseTo(45, 6));
test('converts meters to miles', () => expect(metersToMiles(1609.344)).toBeCloseTo(1, 6));
test('converts km/h to mph', () => expect(kmhToMph(100)).toBeCloseTo(62.137, 3));

describe('display units', () => {
  test('formats miles and kilometers', () => {
    expect(formatDistance(12.34, 'mi')).toBe('12.3 mi');
    expect(formatDistance(12.34, 'km')).toBe('19.9 km');
    expect(formatDistance(1204.4, 'km', { digits: 0 })).toBe('1,938 km');
    expect(formatDistance(1, 'km', { spoken: true })).toBe('1.6 kilometers');
    expect(formatDistance(2, 'mi', { spoken: true })).toBe('2.0 miles');
  });
  test('converts a per-100 rate and its label', () => {
    expect(per100In(1.6, 'mi')).toBe(1.6);
    expect(per100In(1.609344, 'km')).toBeCloseTo(1, 6);
    expect(per100Label('km')).toBe('per 100 km');
    expect(distanceIn(25, 'km')).toBeCloseTo(40.2, 1);
  });
});

test('distance progress in the driver units', () => {
  expect(formatDistanceProgress(12.9, 25, 'mi').text).toBe('12/25 mi');
  expect(formatDistanceProgress(12.9, 25, 'km').text).toBe('20/40 km');
  expect(formatDistanceProgress(30, 25, 'km').text).toBe('40/40 km');
});

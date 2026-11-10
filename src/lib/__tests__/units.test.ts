import { distanceIn, formatDistance, formatDistanceProgress, kmhToMph, metersToMiles, mphToMps, mpsToMph } from '@/lib/units';

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
  test('converts a distance', () => {
    expect(distanceIn(25, 'km')).toBeCloseTo(40.2, 1);
  });
});

test('distance progress in the driver units', () => {
  expect(formatDistanceProgress(12.9, 25, 'mi').text).toBe('12/25 mi');
  expect(formatDistanceProgress(12.9, 25, 'km').text).toBe('20/40 km');
  expect(formatDistanceProgress(30, 25, 'km').text).toBe('40/40 km');
  // 10 mi is 16.09 km, shown as 16: short of it never reads as reached.
  expect(formatDistanceProgress(9.97, 10, 'km')).toEqual({ done: 15, target: 16, text: '15/16 km' });
  expect(formatDistanceProgress(10, 10, 'km').text).toBe('16/16 km');
  expect(formatDistanceProgress(9.99, 10, 'mi').text).toBe('9/10 mi');
});

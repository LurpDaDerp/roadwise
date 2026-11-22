import { distanceIn, formatDistance, formatDistanceProgress, KMH_PER_MPH, kmhToMph, limitIn, limitKmh, metersToMiles, mphToMps, mpsToMph } from '@/lib/units';

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

describe('a posted limit in km/h (limits travel as whole mph)', () => {
  // The server's own conversion of a km/h posting (speed-limits/overpass.ts): whole mph in 5..85.
  const stored = (kmh: number) => Math.round(kmh / KMH_PER_MPH);

  test('every km/h posting from 10 to 135 in steps of 5 shows its posted number, but 65 (stored as 40 mph, a US limit)', () => {
    for (let kmh = 10; kmh <= 135; kmh += 5) {
      expect([kmh, limitKmh(stored(kmh))]).toEqual([kmh, kmh === 65 ? 64 : kmh]);
    }
    expect([stored(30), stored(70), stored(110), stored(120)]).toEqual([19, 43, 68, 75]);
    expect([limitKmh(19), limitKmh(43), limitKmh(68), limitKmh(75)]).toEqual([30, 70, 110, 120]);
  });

  test('over the whole 5–85 mph range only the limits a km/h posting is stored as move off the plain conversion; of the US limits, only 75 mph', () => {
    const moved: Record<number, number> = {};
    for (let mph = 5; mph <= 85; mph += 1) {
      const plain = Math.round(mph * KMH_PER_MPH);
      const shown = limitKmh(mph);
      // Never more than the rounding of a whole mph away from the true value.
      expect(Math.abs(shown - mph * KMH_PER_MPH)).toBeLessThan(KMH_PER_MPH / 2);
      if (shown !== plain) moved[mph] = shown;
    }
    expect(moved).toEqual({ 9: 15, 12: 20, 16: 25, 19: 30, 43: 70, 47: 75, 68: 110, 71: 115, 75: 120, 78: 125 });
    for (const mph of [5, 10, 15, 20, 25, 30, 35, 40, 45, 50, 55, 60, 65, 70, 80, 85]) expect([mph, limitKmh(mph)]).toEqual([mph, Math.round(mph * KMH_PER_MPH)]);
  });

  test('in the driver units: miles as they are, kilometres through the posted number; null stays null', () => {
    expect(limitIn(43, 'mi')).toBe(43);
    expect(limitIn(35, 'mi')).toBe(35);
    expect(limitIn(43, 'km')).toBe(70);
    expect(limitIn(35, 'km')).toBe(56);
    expect(limitIn(null, 'km')).toBeNull();
    expect(limitIn(null, 'mi')).toBeNull();
  });
});

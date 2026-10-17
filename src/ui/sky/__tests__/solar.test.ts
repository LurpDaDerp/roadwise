import { solarElevation, sunTimes } from '@/ui/sky/solar';

/** Minutes between a computed time and a published one. */
const offBy = (d: Date | null, iso: string) => {
  if (!d) throw new Error(`expected a time near ${iso}`);
  return Math.abs(d.getTime() - new Date(iso).getTime()) / 60_000;
};

// Published times (timeanddate.com / NOAA) rounded to the minute; the NOAA equations land within
// a couple of minutes of them.
describe('sunTimes', () => {
  test('London, summer solstice: sunrise 04:43 BST, sunset 21:21 BST', () => {
    const s = sunTimes(new Date('2024-06-21T12:00:00Z'), 51.5074, -0.1278);
    expect(offBy(s.sunrise, '2024-06-21T03:43:00Z')).toBeLessThanOrEqual(2);
    expect(offBy(s.sunset, '2024-06-21T20:21:00Z')).toBeLessThanOrEqual(2);
    expect(s.polar).toBeNull();
  });

  test('New York, winter solstice: sunrise 07:17 EST, sunset 16:32 EST', () => {
    const s = sunTimes(new Date('2024-12-21T17:00:00Z'), 40.7128, -74.006);
    expect(offBy(s.sunrise, '2024-12-21T12:17:00Z')).toBeLessThanOrEqual(2);
    expect(offBy(s.sunset, '2024-12-21T21:32:00Z')).toBeLessThanOrEqual(2);
  });

  test('Seattle, March equinox: sunrise 07:10 PDT, sunset 19:22 PDT, civil twilight around them', () => {
    const s = sunTimes(new Date('2024-03-20T20:00:00Z'), 47.6062, -122.3321);
    expect(offBy(s.sunrise, '2024-03-20T14:10:00Z')).toBeLessThanOrEqual(2);
    expect(offBy(s.sunset, '2024-03-21T02:22:00Z')).toBeLessThanOrEqual(2);
    expect(offBy(s.dawn, '2024-03-20T13:40:00Z')).toBeLessThanOrEqual(3);
    expect(offBy(s.dusk, '2024-03-21T02:53:00Z')).toBeLessThanOrEqual(3);
  });

  test('Sydney in its summer: the solar day around the given instant, not the UTC calendar day', () => {
    // 2024-12-21 local: sunrise 05:41 AEDT (18:41 UTC the day before), sunset 20:05 AEDT (09:05 UTC).
    const s = sunTimes(new Date('2024-12-21T02:00:00Z'), -33.8688, 151.2093);
    expect(offBy(s.sunrise, '2024-12-20T18:41:00Z')).toBeLessThanOrEqual(3);
    expect(offBy(s.sunset, '2024-12-21T09:05:00Z')).toBeLessThanOrEqual(3);
  });

  test('Tromsø: polar night in December, midnight sun in June', () => {
    const dec = sunTimes(new Date('2024-12-21T11:00:00Z'), 69.6492, 18.9553);
    expect(dec.sunrise).toBeNull();
    expect(dec.sunset).toBeNull();
    expect(dec.polar).toBe('night');
    const jun = sunTimes(new Date('2024-06-21T11:00:00Z'), 69.6492, 18.9553);
    expect(jun.sunrise).toBeNull();
    expect(jun.polar).toBe('day');
  });

  test('times run dawn < sunrise < noon < sunset < dusk', () => {
    const s = sunTimes(new Date('2026-10-17T19:00:00Z'), 37.7749, -122.4194);
    const order = [s.dawn, s.sunrise, s.noon, s.sunset, s.dusk].map((d) => d!.getTime());
    expect([...order].sort((a, b) => a - b)).toEqual(order);
  });
});

describe('solarElevation', () => {
  test('high at noon, under the horizon at midnight', () => {
    const s = sunTimes(new Date('2024-06-21T12:00:00Z'), 51.5074, -0.1278);
    expect(solarElevation(s.noon, 51.5074, -0.1278)).toBeGreaterThan(60);
    expect(solarElevation(new Date('2024-06-21T00:00:00Z'), 51.5074, -0.1278)).toBeLessThan(0);
  });

  test('about −0.8° at the computed sunrise (refraction and the sun’s radius)', () => {
    const s = sunTimes(new Date('2024-03-20T20:00:00Z'), 47.6062, -122.3321);
    expect(solarElevation(s.sunrise!, 47.6062, -122.3321)).toBeCloseTo(-0.833, 0);
  });
});

import { bearingDeg, geohash5, haversineMeters, roundCoord } from '@/lib/geo';

const seattle = { lat: 47.6062, lng: -122.3321 };
const tacoma = { lat: 47.2529, lng: -122.4443 };

test('haversine Seattle→Tacoma ≈ 40.2 km', () => {
  expect(haversineMeters(seattle, tacoma)).toBeGreaterThan(40000);
  expect(haversineMeters(seattle, tacoma)).toBeLessThan(40500);
});
test('bearing Seattle→Tacoma is roughly south-southwest', () => {
  const b = bearingDeg(seattle, tacoma);
  expect(b).toBeGreaterThan(185);
  expect(b).toBeLessThan(200);
});
test('geohash5 of Seattle', () => expect(geohash5(seattle.lat, seattle.lng)).toBe('c23nb'));
test('roundCoord to 3 dp', () => expect(roundCoord(47.60621234)).toBe(47.606));

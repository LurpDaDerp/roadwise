import type { PrivacyZone } from '@/core/engine/privacy';

import { at } from '../__fixtures__/spots';
import { spotLabel, streetGeocoder } from '../label';

const mockReverse = jest.fn();
jest.mock('expo-location', () => ({ reverseGeocodeAsync: (...args: unknown[]) => mockReverse(...args) }));

const PIN = at(1000, 0);
const ZONE: PrivacyZone = { id: 'z', name: 'Home', ...at(1100, 0), radiusM: 200 };

beforeEach(() => mockReverse.mockReset());

test('the street comes first, then the place name, the district or the city', async () => {
  mockReverse.mockResolvedValueOnce([{ street: 'Dexter Ave N', name: '1200 Dexter Ave N', district: 'Westlake' }]);
  expect(await streetGeocoder(PIN)).toBe('Dexter Ave N');
  mockReverse.mockResolvedValueOnce([{ street: null, name: null, district: 'Westlake', city: 'Seattle' }]);
  expect(await streetGeocoder(PIN)).toBe('Westlake');
  mockReverse.mockResolvedValueOnce([]);
  expect(await streetGeocoder(PIN)).toBeNull();
  mockReverse.mockRejectedValueOnce(new Error('throttled'));
  expect(await streetGeocoder(PIN)).toBeNull();
});

test('a pin inside a privacy zone gets no name and makes no request', async () => {
  const geocode = jest.fn(async () => 'Somewhere St');
  expect(await spotLabel(PIN, [ZONE], geocode)).toBeNull();
  expect(geocode).not.toHaveBeenCalled();
  expect(await spotLabel(at(0, 0), [ZONE], geocode)).toBe('Somewhere St');
  expect(geocode).toHaveBeenCalledTimes(1);
});

test('no geocoder, or one with nothing to say, gives null', async () => {
  expect(await spotLabel(PIN, [], null)).toBeNull();
  expect(await spotLabel(PIN, [], async () => null)).toBeNull();
  expect(await spotLabel(PIN, [], async () => '')).toBeNull();
});

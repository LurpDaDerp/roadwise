import { setGeocodeModuleForTests } from '@drive-sense';
import { Platform } from 'react-native';

import { phoneLabelGeocoder } from '@/core/engine/labels';
import { streetGeocoder } from '@/core/spots/label';
import { stateAt } from '@/features/permit/stateAt';
import { addressAt, lookUpExact } from '@/features/places/search';

import { forwardGeocode, reverseGeocode } from '../phoneGeocoder';

const mockReverse = jest.fn();
const mockForward = jest.fn();
jest.mock('expo-location', () => ({
  reverseGeocodeAsync: (...args: unknown[]) => mockReverse(...args),
  geocodeAsync: (...args: unknown[]) => mockForward(...args),
}));

const P = { lat: 47.6512, lng: -122.3501 };
const ADDRESS = {
  city: 'Seattle',
  district: 'Fremont',
  streetNumber: '3401',
  street: 'Evanston Ave N',
  region: 'Washington',
  subregion: 'King County',
  country: 'United States',
  postalCode: '98103',
  name: '3401',
  isoCountryCode: 'US',
};

const native = { reverseGeocode: jest.fn(), forwardGeocode: jest.fn() };

beforeEach(() => {
  mockReverse.mockReset();
  mockForward.mockReset();
  native.reverseGeocode.mockReset();
  native.forwardGeocode.mockReset();
});
afterEach(() => setGeocodeModuleForTests(undefined));

describe('iPhone: expo-location, exactly as before', () => {
  test('the reverse and forward geocodes go to expo-location even when a native geocoder exists', async () => {
    setGeocodeModuleForTests(native);
    mockReverse.mockResolvedValueOnce([ADDRESS]);
    mockForward.mockResolvedValueOnce([{ latitude: 1, longitude: 2 }]);
    expect(await reverseGeocode(P)).toEqual([ADDRESS]);
    expect(await forwardGeocode('3401 Evanston Ave N')).toEqual([{ latitude: 1, longitude: 2 }]);
    expect(mockReverse).toHaveBeenCalledWith({ latitude: P.lat, longitude: P.lng });
    expect(mockForward).toHaveBeenCalledWith('3401 Evanston Ave N');
    expect(native.reverseGeocode).not.toHaveBeenCalled();
    expect(native.forwardGeocode).not.toHaveBeenCalled();
  });

  test('a failure still rejects, and the callers read it as no answer', async () => {
    mockReverse.mockRejectedValue(new Error('throttled'));
    await expect(reverseGeocode(P)).rejects.toThrow('throttled');
    expect(await phoneLabelGeocoder(P)).toBeNull();
  });
});

describe('Android: the native geocoder, which answers with the app behind', () => {
  let restoreOS: () => void;
  beforeEach(() => {
    restoreOS = jest.replaceProperty(Platform, 'OS', 'android').restore;
  });
  afterEach(() => restoreOS());

  test('every caller reads the native answer, one call each, and expo-location is never asked', async () => {
    setGeocodeModuleForTests(native);
    native.reverseGeocode.mockResolvedValue([ADDRESS]);
    native.forwardGeocode.mockResolvedValue([{ latitude: 47.65, longitude: -122.35 }]);
    expect(await phoneLabelGeocoder(P)).toEqual({ label: 'Fremont', number: '3401', street: 'Evanston Ave N' });
    expect(await streetGeocoder(P)).toBe('Evanston Ave N');
    expect((await stateAt(P))?.code).toBe('WA');
    expect(await addressAt(P)).toEqual(expect.objectContaining({ title: '3401 Evanston Ave N', subtitle: 'Seattle, Washington 98103' }));
    expect(native.reverseGeocode).toHaveBeenCalledTimes(4);
    expect(native.reverseGeocode).toHaveBeenCalledWith(P.lat, P.lng);
    const hit = await lookUpExact('3401 Evanston Ave N');
    expect(hit).toEqual(expect.objectContaining({ lat: 47.65, lng: -122.35, title: '3401 Evanston Ave N' }));
    expect(native.forwardGeocode).toHaveBeenCalledWith('3401 Evanston Ave N');
    expect(mockReverse).not.toHaveBeenCalled();
    expect(mockForward).not.toHaveBeenCalled();
  });

  test('a phone with no geocoder (or a native failure) answers nothing, so no label, and no second geocoder is asked', async () => {
    setGeocodeModuleForTests(native);
    native.reverseGeocode.mockResolvedValue(null);
    native.forwardGeocode.mockRejectedValue(new Error('bridge'));
    expect(await reverseGeocode(P)).toEqual([]);
    expect(await forwardGeocode('somewhere')).toEqual([]);
    expect(await phoneLabelGeocoder(P)).toBeNull();
    expect(await streetGeocoder(P)).toBeNull();
    expect(await stateAt(P)).toBeNull();
    expect(await addressAt(P)).toBeNull();
    expect(await lookUpExact('somewhere')).toBeNull();
    expect(mockReverse).not.toHaveBeenCalled();
    expect(mockForward).not.toHaveBeenCalled();
  });

  test('a malformed native answer is no answer', async () => {
    setGeocodeModuleForTests(native);
    native.reverseGeocode.mockResolvedValue([{ city: 42 }]);
    native.forwardGeocode.mockResolvedValue([{ latitude: 'x' }]);
    expect(await reverseGeocode(P)).toEqual([]);
    expect(await forwardGeocode('somewhere')).toEqual([]);
  });

  test('out-of-range points and empty or overlong queries never cross the bridge', async () => {
    setGeocodeModuleForTests(native);
    expect(await reverseGeocode({ lat: 91, lng: 0 })).toEqual([]);
    expect(await reverseGeocode({ lat: Number.NaN, lng: 0 })).toEqual([]);
    expect(await forwardGeocode('   ')).toEqual([]);
    expect(await forwardGeocode('x'.repeat(201))).toEqual([]);
    expect(native.reverseGeocode).not.toHaveBeenCalled();
    expect(native.forwardGeocode).not.toHaveBeenCalled();
  });

  test('an Android build without the native geocoder keeps expo-location', async () => {
    setGeocodeModuleForTests(null);
    mockReverse.mockResolvedValueOnce([ADDRESS]);
    expect(await reverseGeocode(P)).toEqual([ADDRESS]);
    setGeocodeModuleForTests({});
    mockForward.mockResolvedValueOnce([]);
    expect(await forwardGeocode('somewhere')).toEqual([]);
    expect(mockReverse).toHaveBeenCalledTimes(1);
    expect(mockForward).toHaveBeenCalledTimes(1);
  });
});

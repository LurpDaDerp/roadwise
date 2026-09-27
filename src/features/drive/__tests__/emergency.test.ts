import {
  DEFAULT_EMERGENCY_NUMBER,
  deviceEmergencyNumber,
  deviceRegion,
  emergencyNumberFor,
  emergencyTelUrl,
  regionOfLocale,
} from '../emergency';

describe('regionOfLocale', () => {
  test.each([
    ['en-US', 'US'],
    ['en_GB', 'GB'],
    ['zh-Hant-TW', 'TW'],
    ['es-419', '419'],
    ['de', null],
    ['', null],
    [null, null],
    [undefined, null],
  ])('%s → %s', (tag, region) => {
    expect(regionOfLocale(tag)).toBe(region);
  });
});

describe('emergencyNumberFor', () => {
  test.each([
    ['US', '911'],
    ['CA', '911'],
    ['MX', '911'],
    ['PR', '911'],
    ['GB', '112'],
    ['HK', '112'],
    ['DE', '112'],
    ['FR', '112'],
    ['IN', '112'],
    ['AU', '112'],
    ['NZ', '112'],
    ['fr', '112'],
  ])('%s → %s', (region, number) => {
    expect(emergencyNumberFor(region)).toBe(number);
  });

  test('only the universal numbers are ever dialled; a missing region gets 911', () => {
    expect(DEFAULT_EMERGENCY_NUMBER).toBe('911');
    expect(emergencyNumberFor('ZZ')).toBe('112');
    expect(emergencyNumberFor('419')).toBe('112');
    expect(emergencyNumberFor(null)).toBe('911');
    expect(emergencyNumberFor(undefined)).toBe('911');
  });
});

describe('the device', () => {
  afterEach(() => jest.restoreAllMocks());

  test('reads its region from Intl and dials that number', () => {
    jest
      .spyOn(Intl.DateTimeFormat.prototype, 'resolvedOptions')
      .mockReturnValue({ locale: 'en-GB' } as Intl.ResolvedDateTimeFormatOptions);
    expect(deviceRegion()).toBe('GB');
    expect(deviceEmergencyNumber()).toBe('112');
  });

  test('falls back to 911 when Intl says nothing usable', () => {
    jest
      .spyOn(Intl.DateTimeFormat.prototype, 'resolvedOptions')
      .mockReturnValue({ locale: 'en' } as Intl.ResolvedDateTimeFormatOptions);
    expect(deviceEmergencyNumber()).toBe('911');
    jest.spyOn(Intl, 'DateTimeFormat').mockImplementation(() => {
      throw new Error('no Intl');
    });
    expect(deviceEmergencyNumber()).toBe('911');
  });
});

test('the dialer URL is a tel: link', () => {
  expect(emergencyTelUrl('112')).toBe('tel:112');
});

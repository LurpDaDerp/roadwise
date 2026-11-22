/**
 * "Use my location" (Places and Privacy zones): one fix through the one permission adapter. On
 * Android 9 and lower with the drive detector, allowing location allows it in the background too,
 * so Google Play's disclosure comes first, and Not now asks nothing and says location isn't allowed
 * yet (never that it is off).
 */
import { screen } from '@testing-library/react-native';

import { appWorld, clearQueryClients, tap } from '@/features/permissions/__fixtures__/harness';

import { settingsCopy } from '../copy';
import { setMapsForTests } from '../maps';
import { locateOnce, PrivacyZonesScreen } from '../PrivacyZonesScreen';

jest.mock('@/data/supabase/client', () => ({ supabase: {} }));
jest.mock('expo-router', () => {
  const { useEffect } = jest.requireActual<typeof import('react')>('react');
  return {
    useRouter: () => ({ back: jest.fn(), push: jest.fn(), canGoBack: () => true }),
    // Focus effects run once on mount here.
    useFocusEffect: (effect: () => void | (() => void)) => useEffect(effect, [effect]),
  };
});
jest.mock('@/features/spots/recompute', () => ({ requestSpotRecompute: () => {} }));
jest.mock('expo-location', () => ({
  Accuracy: { Balanced: 3 },
  getCurrentPositionAsync: jest.fn(async () => ({ coords: { latitude: 47.6, longitude: -122.3 } })),
}));

const mockAdapter = {
  locationAskIsBackground: jest.fn(async () => false),
  requestLocationForeground: jest.fn(async (_opts?: { disclosed?: boolean }) => 'foreground' as string),
};
jest.mock('@/core/permissions', () => ({
  ...jest.requireActual('@/core/permissions'),
  createPermissionsAdapter: () => mockAdapter,
}));

beforeAll(() => setMapsForTests(null));
afterAll(() => setMapsForTests(undefined));
beforeEach(() => {
  mockAdapter.locationAskIsBackground.mockReset().mockResolvedValue(false);
  mockAdapter.requestLocationForeground.mockReset().mockResolvedValue('foreground');
});
afterEach(() => clearQueryClients());

describe('locateOnce', () => {
  it('asks at once where allowing location is not a background request (as before)', async () => {
    const disclose = jest.fn(async () => true);
    expect(await locateOnce(disclose)).toEqual({ ok: true, lat: 47.6, lng: -122.3 });
    expect(disclose).not.toHaveBeenCalled();
    expect(mockAdapter.requestLocationForeground).toHaveBeenCalledWith({ disclosed: false });
    mockAdapter.requestLocationForeground.mockResolvedValue('denied');
    expect(await locateOnce()).toEqual({ ok: false, reason: 'denied' });
  });

  it('Android 9 and lower with the drive detector: the disclosure first; Not now (or none to show) asks nothing', async () => {
    mockAdapter.locationAskIsBackground.mockResolvedValue(true);
    expect(await locateOnce()).toEqual({ ok: false, reason: 'notAsked' });
    expect(await locateOnce(async () => false)).toEqual({ ok: false, reason: 'notAsked' });
    expect(mockAdapter.requestLocationForeground).not.toHaveBeenCalled();
    const disclose = jest.fn(async () => true);
    expect(await locateOnce(disclose)).toEqual({ ok: true, lat: 47.6, lng: -122.3 });
    expect(disclose).toHaveBeenCalledWith('allow');
    expect(mockAdapter.requestLocationForeground).toHaveBeenCalledWith({ disclosed: true });
  });
});

describe('Privacy zones: Use my location', () => {
  it("shows the disclosure where it is needed; Not now says location isn't allowed yet", async () => {
    mockAdapter.locationAskIsBackground.mockResolvedValue(true);
    const w = await appWorld();
    await w.render(<PrivacyZonesScreen />);
    await tap('zones-add');
    await tap('zone-use-location');
    expect(await screen.findByTestId('background-disclosure-next')).toHaveTextContent('Next, choose "Allow".');
    await tap('background-disclosure-not-now');
    expect(await screen.findByText(settingsCopy.zones.locationNotAsked)).toBeOnTheScreen();
    expect(screen.queryByText(settingsCopy.zones.locationDenied)).toBeNull();
    expect(mockAdapter.requestLocationForeground).not.toHaveBeenCalled();
  });
});

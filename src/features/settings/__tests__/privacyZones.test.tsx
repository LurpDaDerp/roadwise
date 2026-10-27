/**
 * Privacy zones: the rules (at most 3, 200–800 m, a name, a centre), what is stored under
 * `privacy.zones`, and the screen that adds them.
 */
import { act, fireEvent, screen, waitFor } from '@testing-library/react-native';

import { createSettingsRepo } from '@/data/db/settings';
import { appWorld, clearQueryClients, memoryDb, tap } from '@/features/permissions/__fixtures__/harness';

import { settingsCopy } from '../copy';
import { setMapsForTests } from '../maps';
import {
  MAX_RADIUS_M,
  MIN_RADIUS_M,
  PRIVACY_ZONES_KEY,
  readZones,
  stepRadius,
  writeZones,
  zoneProblem,
  zonesProblem,
  type PrivacyZone,
} from '../privacyZones';
import { PrivacyZonesScreen } from '../PrivacyZonesScreen';

jest.mock('@/data/supabase/client', () => ({ supabase: {} }));
jest.mock('expo-router', () => ({ useRouter: () => ({ back: jest.fn(), push: jest.fn(), canGoBack: () => true }) }));
const mockRecompute = jest.fn();
jest.mock('@/features/spots/recompute', () => ({ requestSpotRecompute: () => mockRecompute() }));

const zone = (over: Partial<PrivacyZone> = {}): PrivacyZone => ({
  id: 'z1',
  name: 'Home',
  lat: 40.7,
  lng: -74,
  radiusM: 300,
  ...over,
});

beforeAll(() => setMapsForTests(null));
afterAll(() => setMapsForTests(undefined));
beforeEach(() => mockRecompute.mockClear());
afterEach(() => clearQueryClients());

describe('zone rules', () => {
  it('accepts a named zone with a centre and a 200–800 m radius', () => {
    expect(zoneProblem(zone())).toBeNull();
    expect(zoneProblem(zone({ radiusM: MIN_RADIUS_M }))).toBeNull();
    expect(zoneProblem(zone({ radiusM: MAX_RADIUS_M }))).toBeNull();
  });

  it.each([
    [{ radiusM: 199 }, 'radius'],
    [{ radiusM: 801 }, 'radius'],
    [{ radiusM: Number.NaN }, 'radius'],
    [{ name: '   ' }, 'name_empty'],
    [{ name: 'a'.repeat(21) }, 'name_long'],
    [{ lat: Number.NaN }, 'center'],
    [{ lat: 91 }, 'center'],
  ])('%p is refused as %p', (over, problem) => {
    expect(zoneProblem(zone(over))).toBe(problem);
  });

  it('allows at most 3 zones', () => {
    const three = [zone({ id: 'a' }), zone({ id: 'b' }), zone({ id: 'c' })];
    expect(zonesProblem(three)).toBeNull();
    expect(zonesProblem([...three, zone({ id: 'd' })])).toBe('too_many');
  });

  it('steps the radius by 50 m and never past the bounds', () => {
    expect(stepRadius(300, 1)).toBe(350);
    expect(stepRadius(200, -1)).toBe(200);
    expect(stepRadius(800, 1)).toBe(800);
  });

  it('stores the plan’s shape and refuses a list that breaks a rule', async () => {
    const settings = createSettingsRepo(memoryDb());
    await writeZones(settings, [zone({ name: '  School ' })]);
    expect(await settings.get(PRIVACY_ZONES_KEY)).toEqual([{ id: 'z1', name: 'School', lat: 40.7, lng: -74, radiusM: 300 }]);
    await expect(writeZones(settings, [zone({ radiusM: 900 })])).rejects.toThrow('radius');
    expect(await readZones(settings)).toHaveLength(1);
  });

  it('skips malformed stored zones instead of failing', async () => {
    const settings = createSettingsRepo(memoryDb());
    await settings.set(PRIVACY_ZONES_KEY, [zone(), { id: 'x', name: 'Bad', lat: 1, lng: 1, radiusM: 5000 }, 'junk']);
    expect((await readZones(settings)).map((z) => z.id)).toEqual(['z1']);
  });
});

describe('the privacy zones screen', () => {
  it('adds a zone from the current location, saved on this phone only', async () => {
    const w = await appWorld();
    const locate = jest.fn(async () => ({ ok: true as const, lat: 40.75, lng: -73.99 }));
    await w.render(<PrivacyZonesScreen deps={{ locate }} />);
    expect(await screen.findByTestId('zones-empty')).toBeOnTheScreen();
    expect(screen.getByText(settingsCopy.zones.local)).toBeOnTheScreen();

    await tap('zones-add');
    await tap('zone-preset-Home');
    await tap('zone-bigger');
    expect(screen.getByTestId('zone-radius')).toHaveTextContent('350 m');
    await tap('zone-use-location');
    await waitFor(() => expect(screen.getByTestId('zone-center-status')).toHaveTextContent(settingsCopy.zones.centerSet));
    await tap('zone-save');

    await waitFor(async () =>
      expect(await readZones(w.settings)).toEqual([expect.objectContaining({ name: 'Home', lat: 40.75, lng: -73.99, radiusM: 350 })])
    );
    expect(await screen.findByText('Home')).toBeOnTheScreen();
    // The problem spots are worked out again: one inside the zone gives up its rank.
    expect(mockRecompute).toHaveBeenCalledTimes(1);
  });

  it('says what is missing instead of saving a zone with no centre', async () => {
    const w = await appWorld();
    await w.render(<PrivacyZonesScreen deps={{ locate: jest.fn() }} />);
    await tap('zones-add');
    const name = await screen.findByTestId('zone-name');
    await act(async () => {
      fireEvent.changeText(name, 'Gym');
    });
    await tap('zone-save');
    expect(await screen.findByTestId('zone-problem')).toHaveTextContent(settingsCopy.zones.problems.center);
    expect(await readZones(w.settings)).toEqual([]);
  });

  it('turns Add off at 3 zones', async () => {
    const w = await appWorld({
      settings: { [PRIVACY_ZONES_KEY]: [zone({ id: 'a' }), zone({ id: 'b', name: 'School' }), zone({ id: 'c', name: 'Work' })] },
    });
    await w.render(<PrivacyZonesScreen />);
    await screen.findByTestId('zone-c');
    expect(screen.getByTestId('zones-add')).toBeDisabled();
    expect(screen.getByText(settingsCopy.zones.max)).toBeOnTheScreen();
  });

  it('a location fix that lands late keeps the name typed meanwhile', async () => {
    const w = await appWorld();
    let land: (r: { ok: true; lat: number; lng: number }) => void = () => {};
    const locate = jest.fn(() => new Promise<{ ok: true; lat: number; lng: number }>((resolve) => (land = resolve)));
    await w.render(<PrivacyZonesScreen deps={{ locate }} />);
    await tap('zones-add');
    await tap('zone-use-location');
    await act(async () => {
      fireEvent.changeText(screen.getByTestId('zone-name'), 'Gym');
    });
    await act(async () => land({ ok: true, lat: 40.75, lng: -73.99 }));
    expect(screen.getByTestId('zone-name')).toHaveProp('value', 'Gym');
    expect(screen.getByTestId('zone-center-status')).toHaveTextContent(settingsCopy.zones.centerSet);
  });

  it('a location fix that lands after the editor closed does not reopen it', async () => {
    const w = await appWorld();
    let land: (r: { ok: true; lat: number; lng: number }) => void = () => {};
    const locate = jest.fn(() => new Promise<{ ok: true; lat: number; lng: number }>((resolve) => (land = resolve)));
    await w.render(<PrivacyZonesScreen deps={{ locate }} />);
    await tap('zones-add');
    await tap('zone-use-location');
    await act(async () => {
      fireEvent(screen.getByTestId('zone-editor-modal'), 'requestClose');
    });
    expect(screen.queryByTestId('zone-name')).toBeNull();
    await act(async () => land({ ok: true, lat: 40.75, lng: -73.99 }));
    expect(screen.queryByTestId('zone-name')).toBeNull();
  });

  it('a refused location says so plainly', async () => {
    const w = await appWorld();
    await w.render(<PrivacyZonesScreen deps={{ locate: async () => ({ ok: false, reason: 'denied' }) }} />);
    await tap('zones-add');
    await tap('zone-use-location');
    expect(await screen.findByText(settingsCopy.zones.locationDenied)).toBeOnTheScreen();
  });
});

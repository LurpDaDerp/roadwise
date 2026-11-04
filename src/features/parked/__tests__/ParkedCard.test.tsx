/**
 * "Where you parked" on Home: the stored spot's card (label and time, Walk back, the ✕ top right),
 * gone on ✕, once a later drive is kept, after 3 days, during a drive and on Android; the spot's
 * parse and the host's signal.
 */
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react-native';
import { Platform } from 'react-native';

import { createSqlJsDb } from '@/data/db/__fixtures__/sqljsDriver';
import { createSettingsRepo, createTripsRepo, migrate, type Db } from '@/data/db';
import { DataProvider } from '@/data/queries/context';
import { formatWhen } from '@/features/drives/format';
import { ThemeProvider } from '@/ui';

import { parkedCopy } from '../copy';
import { PARKED_KEY, PARKED_MAX_AGE_MS, parkedExpired, parseParkedSpot, writeParkedSpot, type ParkedSpot } from '../model';
import { HomeParkedCard } from '../ParkedCard';

const mockWalk = jest.fn(async () => true);
jest.mock('@/features/navigation/apps', () => ({ openWalkingDirections: (...a: unknown[]) => mockWalk(...(a as [])) }));
jest.mock('@/features/navigation/prefs', () => ({ readNavApp: async () => 'google_maps' }));
let mockFinalized: unknown = null;
jest.mock('@/drive/useDrive', () => ({ useDrive: (sel: (s: { lastFinalized: unknown }) => unknown) => sel({ lastFinalized: mockFinalized }) }));
jest.mock('expo-router', () => ({
  useFocusEffect: (fn: () => void | (() => void)) => {
    // eslint-disable-next-line @typescript-eslint/no-require-imports -- the real React inside a mock factory
    const { useEffect } = require('react') as typeof import('react');
    useEffect(() => fn(), [fn]);
  },
}));

const NOW = 1_800_000_000_000;
const spot: ParkedSpot = { lat: 47.61, lng: -122.33, parkedAt: NOW - 3600_000, label: 'Capitol Hill', driveId: '0f8fad5b-d9cb-469f-a165-70867728950e' };

let db: Db;
let now = NOW;
beforeEach(async () => {
  db = await createSqlJsDb();
  await migrate(db);
  now = NOW;
  mockWalk.mockClear();
  mockFinalized = null;
});

const ui = (hidden = false) => (
  <ThemeProvider>
    <DataProvider db={db} now={() => now}>
      <HomeParkedCard hidden={hidden} />
    </DataProvider>
  </ThemeProvider>
);
const settle = async () => {
  for (let i = 0; i < 8; i += 1) await act(async () => Promise.resolve());
};

describe("Home's card", () => {
  test('the spot: its label and time, Walk back opens walking directions to it, the ✕ top right closes it for good', async () => {
    await writeParkedSpot(db, spot);
    await render(ui());
    await waitFor(() => expect(screen.getByTestId('home-parked')).toBeTruthy());
    expect(screen.getByText(parkedCopy.title)).toBeTruthy();
    expect(screen.getByTestId('home-parked-line')).toHaveTextContent(`Capitol Hill · ${formatWhen(spot.parkedAt)}`);
    await act(async () => {
      fireEvent.press(screen.getByTestId('home-parked-walk'));
    });
    await settle();
    expect(mockWalk).toHaveBeenCalledWith('google_maps', { lat: spot.lat, lng: spot.lng });
    expect(screen.getByTestId('home-parked-dismiss')).toHaveStyle({ alignSelf: 'flex-start' });
    await act(async () => {
      fireEvent.press(screen.getByTestId('home-parked-dismiss'));
    });
    await settle();
    expect(screen.queryByTestId('home-parked')).toBeNull();
    expect(await createSettingsRepo(db).get(PARKED_KEY)).toBeNull();
  });

  test('with no label, the time alone', async () => {
    await writeParkedSpot(db, { ...spot, label: null });
    await render(ui());
    await waitFor(() => expect(screen.getByTestId('home-parked-line')).toHaveTextContent(formatWhen(spot.parkedAt)));
    expect(screen.getByTestId('home-parked-line')).not.toHaveTextContent(/·.*·.*·/);
  });

  test('shows when the host stores a spot while Home is on screen', async () => {
    await render(ui());
    await settle();
    expect(screen.queryByTestId('home-parked')).toBeNull();
    await act(async () => writeParkedSpot(db, spot));
    await waitFor(() => expect(screen.getByTestId('home-parked')).toBeTruthy());
  });

  test('gone after 3 days, and the stored spot with it', async () => {
    await writeParkedSpot(db, { ...spot, parkedAt: NOW - PARKED_MAX_AGE_MS - 1 });
    await render(ui());
    await settle();
    expect(screen.queryByTestId('home-parked')).toBeNull();
    expect(await createSettingsRepo(db).get(PARKED_KEY)).toBeNull();
  });

  test('gone once a later drive is kept (one stored at a launch included); a passenger ride or a drive still recording is no later drive', async () => {
    await writeParkedSpot(db, spot);
    const trips = createTripsRepo(db);
    await trips.insert({ client_trip_id: 'rec', started_at: spot.parkedAt + 60_000, tz: 'UTC', status: 'recording' }, NOW);
    await trips.insert({ client_trip_id: 'ride', started_at: spot.parkedAt + 60_000, tz: 'UTC', status: 'not_driving' }, NOW);
    await trips.insert({ client_trip_id: 'old', started_at: spot.parkedAt - 600_000, tz: 'UTC', status: 'scored' }, NOW);
    const first = await render(ui());
    await waitFor(() => expect(screen.getByTestId('home-parked')).toBeTruthy());
    first.unmount();
    await trips.insert({ client_trip_id: 'next', started_at: spot.parkedAt + 120_000, tz: 'UTC', status: 'pending' }, NOW);
    await render(ui());
    await settle();
    expect(screen.queryByTestId('home-parked')).toBeNull();
    expect(await createSettingsRepo(db).get(PARKED_KEY)).toBeNull();
  });

  test('never during a drive, nor on Android', async () => {
    await writeParkedSpot(db, spot);
    const during = await render(ui(true));
    await settle();
    expect(screen.queryByTestId('home-parked')).toBeNull();
    during.unmount();
    const os = Platform.OS;
    Object.defineProperty(Platform, 'OS', { value: 'android', configurable: true });
    try {
      await render(ui());
      await settle();
      expect(screen.queryByTestId('home-parked')).toBeNull();
    } finally {
      Object.defineProperty(Platform, 'OS', { value: os, configurable: true });
    }
  });
});

describe('the spot', () => {
  test('parsed defensively', () => {
    expect(parseParkedSpot(spot)).toEqual(spot);
    expect(parseParkedSpot({ ...spot, label: '  ' })).toEqual({ ...spot, label: null });
    expect(parseParkedSpot({ ...spot, lat: 91 })).toBeNull();
    expect(parseParkedSpot({ ...spot, lng: Number.NaN })).toBeNull();
    expect(parseParkedSpot({ ...spot, driveId: '' })).toBeNull();
    expect(parseParkedSpot('x')).toBeNull();
    expect(parseParkedSpot(null)).toBeNull();
  });

  test('expired after 3 days, or dated in the future', () => {
    expect(parkedExpired(spot, NOW)).toBe(false);
    expect(parkedExpired({ ...spot, parkedAt: NOW - PARKED_MAX_AGE_MS }, NOW)).toBe(false);
    expect(parkedExpired({ ...spot, parkedAt: NOW - PARKED_MAX_AGE_MS - 1 }, NOW)).toBe(true);
    expect(parkedExpired({ ...spot, parkedAt: NOW + 120_000 }, NOW)).toBe(true);
  });
});

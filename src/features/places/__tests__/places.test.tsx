/**
 * Saved places: what is stored under `places.saved`, the address search (Photon's answers read as
 * two lines, failures that never throw), the privacy zone that follows its place, the learned
 * suggestions' addresses, and the screens: Places, its sheet, Home's card and Privacy zones' switches.
 */
import { act, fireEvent, screen, waitFor } from '@testing-library/react-native';
import { Alert } from 'react-native';

import type { LearnedPlace } from '@/core/places/learn';
import type { Db } from '@/data/db/driver';
import { createSettingsRepo } from '@/data/db/settings';
import { appWorld, clearQueryClients, memoryDb, tap } from '@/features/permissions/__fixtures__/harness';
import { setMapsForTests } from '@/features/settings/maps';
import { PRIVACY_ZONES_KEY, readZones, type PrivacyZone } from '@/features/settings/privacyZones';
import { PrivacyZonesScreen } from '@/features/settings/PrivacyZonesScreen';

import { placesCopy } from '../copy';
import { nameSuggestions } from '../learned';
import { PLACES_CARD_DISMISSED_KEY, PLACES_KEY, PLACE_NAMES_KEY, placesProblem, readPlaces, writePlaces, type SavedPlace } from '../model';
import { HomePlacesCard } from '../PlacesCard';
import { PlacesScreen } from '../PlacesScreen';
import { clearSearchCache, coarse, hitFromPhoton, photonUrl, searchAddresses, type AddressHit } from '../search';
import { readPlacesCard, removePlace, savePlace, zonesFollowing, zonesUnlinked } from '../usePlaces';

const mockPush = jest.fn();
jest.mock('@/data/supabase/client', () => ({ supabase: {} }));
jest.mock('expo-router', () => ({
  useRouter: () => ({ back: jest.fn(), push: mockPush, canGoBack: () => true }),
  // Focus effects run once on mount here.
  useFocusEffect: (fn: () => void | (() => void)) => {
    // eslint-disable-next-line @typescript-eslint/no-require-imports -- the real React inside a mock factory
    const { useEffect } = require('react') as typeof import('react');
    useEffect(() => fn(), [fn]);
  },
}));
const mockRecompute = jest.fn();
jest.mock('@/features/spots/recompute', () => ({ requestSpotRecompute: () => mockRecompute() }));

const HOME: SavedPlace = { id: 'home', kind: 'home', name: 'Home', address: '123 Main St', area: 'Seattle, WA 98104', lat: 47.6, lng: -122.33 };

beforeAll(() => setMapsForTests(null));
afterAll(() => setMapsForTests(undefined));
beforeEach(() => {
  mockPush.mockClear();
  mockRecompute.mockClear();
  clearSearchCache();
});
afterEach(() => clearQueryClients());

describe('stored places', () => {
  it('keeps one Home, Work and School, in that order, then your own', async () => {
    const settings = createSettingsRepo(memoryDb());
    await settings.set(PLACES_KEY, [
      { id: 'place-1', kind: 'custom', name: 'Gym', address: '1 Gym Rd', area: '', lat: 1, lng: 1 },
      HOME,
      { ...HOME, id: 'home-2', address: 'Second home' },
      { id: 'school', kind: 'school', name: 'School', address: '9 School Ln', lat: 2, lng: 2 },
      { id: 'x', kind: 'castle', name: 'Bad', address: '', lat: 1, lng: 1 },
      'junk',
    ]);
    const places = await readPlaces(settings);
    expect(places.map((p) => p.id)).toEqual(['home', 'school', 'place-1']);
    expect(places[1]?.area).toBe('');
  });

  it('refuses a nameless place, a point off the map and an eighth place of your own', async () => {
    const settings = createSettingsRepo(memoryDb());
    await expect(writePlaces(settings, [{ ...HOME, kind: 'custom', name: '  ' }])).rejects.toThrow('name_empty');
    await expect(writePlaces(settings, [{ ...HOME, lat: 95 }])).rejects.toThrow('point');
    const eight = Array.from({ length: 8 }, (_, i) => ({ ...HOME, id: `place-${i}`, kind: 'custom' as const, name: `P${i}` }));
    expect(placesProblem(eight)).toBe('too_many');
    expect(placesProblem(eight.slice(0, 7))).toBeNull();
    expect(await readPlaces(settings)).toEqual([]);
  });
});

describe('address search', () => {
  const feature = (properties: Record<string, unknown>, coordinates: unknown = [-122.333, 47.6]) => ({ type: 'Feature', properties, geometry: { type: 'Point', coordinates } });

  it('reads a house as its street line over its city line', () => {
    expect(hitFromPhoton(feature({ osm_type: 'N', osm_id: 1, housenumber: '123', street: 'South Main Street', city: 'Seattle', state: 'WA', postcode: '98104', countrycode: 'US' }))).toEqual(
      expect.objectContaining({ title: '123 South Main Street', subtitle: 'Seattle, WA 98104', lat: 47.6, lng: -122.333 })
    );
  });

  it('reads a named place by its name, with its address under it', () => {
    const hit = hitFromPhoton(feature({ name: 'Roosevelt High School', housenumber: '1410', street: 'NE 66th St', city: 'Seattle', state: 'Washington', countrycode: 'US' }));
    expect(hit).toEqual(expect.objectContaining({ title: 'Roosevelt High School', subtitle: '1410 NE 66th St, Seattle, Washington' }));
  });

  it('names the country outside the US, and drops a feature with no point', () => {
    expect(hitFromPhoton(feature({ street: 'Main Street', city: 'Winnipeg', state: 'Manitoba', country: 'Canada', countrycode: 'CA' }))?.subtitle).toBe('Winnipeg, Manitoba, Canada');
    expect(hitFromPhoton(feature({ street: 'Main Street' }, null))).toBeNull();
    expect(hitFromPhoton(feature({}))).toBeNull();
  });

  it('sends only the text and a position rounded to about 10 km', () => {
    expect(coarse({ lat: 47.62345, lng: -122.34567 })).toEqual({ lat: 47.6, lng: -122.3 });
    const url = photonUrl('123 main st', { lat: 47.62345, lng: -122.34567 });
    expect(url).toBe('https://photon.komoot.io/api/?q=123%20main%20st&limit=6&lang=en&lat=47.6&lon=-122.3&zoom=10&location_bias_scale=0.1');
    expect(photonUrl('x y z', null)).not.toContain('lat=');
  });

  it('waits for 3 characters, remembers answers, and never throws', async () => {
    const body = { features: [feature({ housenumber: '1', street: 'A St', city: 'Town' }), feature({ housenumber: '1', street: 'A St', city: 'Town' })] };
    const fetch = jest.fn(async () => ({ ok: true, json: async () => body }));
    expect(await searchAddresses('ab', null, { fetch })).toEqual({ ok: true, hits: [] });
    expect(fetch).not.toHaveBeenCalled();
    const first = await searchAddresses('1 a st', null, { fetch });
    expect(first.ok && first.hits.map((h) => h.title)).toEqual(['1 A St']);
    await searchAddresses('1  a st ', null, { fetch });
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(await searchAddresses('fails', null, { fetch: async () => ({ ok: false, json: async () => ({}) }) })).toEqual({ ok: false });
    expect(await searchAddresses('throws', null, { fetch: async () => Promise.reject(new Error('offline')) })).toEqual({ ok: false });
  });
});

describe('a place and its privacy zone', () => {
  const linked: PrivacyZone = { id: 'z1', name: 'Home', lat: 47.6, lng: -122.33, radiusM: 400, placeId: 'home' };
  const other: PrivacyZone = { id: 'z2', name: 'Gym', lat: 1, lng: 1, radiusM: 300 };

  it('moves and renames the zone with its place, keeping its size', () => {
    expect(zonesFollowing([linked, other], { ...HOME, lat: 47.7, lng: -122.4 })).toEqual([{ ...linked, lat: 47.7, lng: -122.4 }, other]);
    expect(zonesFollowing([linked, other], HOME)).toBeNull();
    expect(zonesFollowing([other], HOME)).toBeNull();
  });

  it('keeps the zone when its place is removed, as an ordinary zone', () => {
    const { placeId: _, ...plain } = linked;
    expect(zonesUnlinked([linked, other], 'home')).toEqual([plain, other]);
    expect(zonesUnlinked([other], 'home')).toBeNull();
  });

  it('saves through the settings, zone included', async () => {
    const settings = createSettingsRepo(memoryDb());
    await settings.set(PRIVACY_ZONES_KEY, [linked]);
    await savePlace(settings, { ...HOME, lat: 47.61 });
    expect((await readZones(settings))[0]).toEqual(expect.objectContaining({ lat: 47.61, placeId: 'home' }));
    expect(mockRecompute).toHaveBeenCalledTimes(1);
    expect(await removePlace(settings, 'home')).toEqual([]);
    expect((await readZones(settings))[0]?.placeId).toBeUndefined();
  });
});

describe('learned suggestions’ addresses', () => {
  const learned = (lat: number, lng: number): LearnedPlace => ({
    id: `${lat},${lng}`,
    center: { lat, lng },
    kind: 'home',
    visits: 20,
    days: 15,
    nights: 14,
    nightsSeen: 15,
    weekdays: 0,
    share: 0.5,
    pHome: 0.88,
    pWork: 0,
    lastSeen: 0,
  });

  it('looks each one up once, remembers it, and never looks one up inside a privacy zone', async () => {
    const settings = createSettingsRepo(memoryDb());
    const lookup = jest.fn(async () => ({ title: '123 Main St', subtitle: 'Seattle' }));
    const zone: PrivacyZone = { id: 'z', name: 'Home', lat: 10, lng: 10, radiusM: 300 };
    const first = await nameSuggestions(settings, [learned(47.6, -122.33), learned(10, 10)], [zone], lookup);
    expect(first.map((s) => [s.title, s.zone?.name ?? null])).toEqual([
      ['123 Main St', null],
      [null, 'Home'],
    ]);
    expect(lookup).toHaveBeenCalledTimes(1);
    expect(lookup).toHaveBeenCalledWith({ lat: 47.6, lng: -122.33 });
    await nameSuggestions(settings, [learned(47.6001, -122.3301)], [], lookup);
    expect(lookup).toHaveBeenCalledTimes(1);
    expect(await settings.get(PLACE_NAMES_KEY)).toHaveLength(1);
  });
});

/** Types into the place search: found first, then changed inside one act (never a find inside an act). */
async function typeQuery(text: string) {
  const field = await screen.findByTestId('place-query', {}, { timeout: 3000 });
  await act(async () => {
    fireEvent.changeText(field, text);
  });
}

/** Flips a switch, found first. */
async function flip(testID: string, value: boolean) {
  const el = await screen.findByTestId(testID, {}, { timeout: 3000 });
  await act(async () => {
    fireEvent(el, 'valueChange', value);
  });
}

/** The world's database also answers the learned places' read of the drives. */
function withTrips(db: Db, rows: Record<string, unknown>[]) {
  const execute = db.execute.bind(db);
  (db as { execute: Db['execute'] }).execute = async (sql, params) => (/FROM trips/.test(sql) ? { rows, changes: 0 } : execute(sql, params));
}

/** A commuter's month of drives: home (47.62, -122.35) at night, work on weekdays. */
function commuteRows(now: number) {
  const DAY = 86_400_000;
  const rows: Record<string, unknown>[] = [];
  const start = now - 28 * DAY;
  for (let d = 0; d < 28; d += 1) {
    const midnight = start - (start % DAY) + d * DAY + 7 * 3_600_000; // 00:00 in Los Angeles (PDT)
    const dow = new Date(midnight - 7 * 3_600_000).getUTCDay();
    if (dow === 0 || dow === 6) continue;
    rows.push({ client_trip_id: `a${d}`, started_at: midnight + 8 * 3_600_000, ended_at: midnight + 8.4 * 3_600_000, tz: 'America/Los_Angeles', start_lat: 47.62, start_lng: -122.35, end_lat: 47.61, end_lng: -122.333 });
    rows.push({ client_trip_id: `b${d}`, started_at: midnight + 17.5 * 3_600_000, ended_at: midnight + 17.9 * 3_600_000, tz: 'America/Los_Angeles', start_lat: 47.61, start_lng: -122.333, end_lat: 47.62, end_lng: -122.35 });
  }
  return rows;
}

describe('the Places screen', () => {
  const hit: AddressHit = { id: 'h1', title: '500 Pine St', subtitle: 'Seattle, WA 98101', lat: 47.611, lng: -122.336 };

  it('saves Home from a typed address', async () => {
    const w = await appWorld();
    withTrips(w.db, []);
    const search = jest.fn(async () => ({ ok: true as const, hits: [hit] }));
    await w.render(<PlacesScreen deps={{ search, bias: async () => null }} />);
    expect(await screen.findByTestId('places-home')).toHaveTextContent(new RegExp(placesCopy.noAddress));

    await tap('places-home');
    await typeQuery('500 pine');
    await tap('place-hit-h1');
    expect(screen.getByTestId('place-address')).toHaveTextContent('500 Pine St');
    await tap('place-save');

    await waitFor(async () => expect(await readPlaces(w.settings)).toEqual([expect.objectContaining({ id: 'home', kind: 'home', name: 'Home', address: '500 Pine St', area: 'Seattle, WA 98101', lat: 47.611 })]));
    expect(await screen.findByTestId('places-home')).toHaveTextContent(/500 Pine St/);
    expect(search).toHaveBeenCalledWith('500 pine', null, expect.anything());
  });

  it('offers the place your drives say is home, with how likely it is', async () => {
    const w = await appWorld({ settings: { [PLACE_NAMES_KEY]: [{ lat: 47.62, lng: -122.35, title: '742 Evergreen Ter', subtitle: 'Seattle' }] } });
    withTrips(w.db, commuteRows(Date.now()));
    await w.render(<PlacesScreen deps={{ search: jest.fn(), bias: async () => null, addressAt: async () => null }} />);
    await tap('places-home');
    const row = await screen.findByText('742 Evergreen Ter', {}, { timeout: 3000 });
    expect(screen.getByTestId('place-suggestions')).toHaveTextContent(/Likely home · \d+%/);
    await act(async () => {
      fireEvent.press(row);
    });
    await tap('place-save');
    await waitFor(async () => expect((await readPlaces(w.settings))[0]).toEqual(expect.objectContaining({ kind: 'home', address: '742 Evergreen Ter', lat: 47.62 })));
  });

  it('adds a place of your own with a name, and refuses one without', async () => {
    const w = await appWorld();
    withTrips(w.db, []);
    await w.render(<PlacesScreen deps={{ search: async () => ({ ok: true, hits: [{ ...hit, title: '12 Gym Way' }] }), bias: async () => null }} />);
    // Add waits for the saved places to be read.
    await waitFor(() => expect(screen.getByTestId('places-add')).toBeEnabled());
    await tap('places-add');
    await typeQuery('12 gym');
    await tap('place-hit-h1');
    await tap('place-save');
    expect(await screen.findByTestId('place-problem')).toHaveTextContent(placesCopy.sheet.problems.name_empty);
    await act(async () => {
      fireEvent.changeText(screen.getByTestId('place-name'), 'Gym');
    });
    await tap('place-save');
    await waitFor(async () => expect((await readPlaces(w.settings))[0]).toEqual(expect.objectContaining({ kind: 'custom', name: 'Gym', address: '12 Gym Way' })));
  });

  it('looks up the exact address through the phone when search has nothing', async () => {
    const w = await appWorld();
    withTrips(w.db, []);
    const exact = jest.fn(async () => ({ ...hit, id: 'exact', title: '9 Exact Rd' }));
    await w.render(<PlacesScreen deps={{ search: async () => ({ ok: false }), exact, bias: async () => null }} />);
    await tap('places-work');
    await typeQuery('9 exact rd');
    expect(await screen.findByTestId('place-search-failed', {}, { timeout: 3000 })).toBeOnTheScreen();
    await tap('place-exact');
    expect(exact).toHaveBeenCalledWith('9 exact rd');
    expect(await screen.findByTestId('place-address')).toHaveTextContent('9 Exact Rd');
  });

  it('removes a saved place after a check', async () => {
    const w = await appWorld({ settings: { [PLACES_KEY]: [HOME] } });
    withTrips(w.db, []);
    const alert = jest.spyOn(Alert, 'alert').mockImplementation((_t, _m, buttons) => buttons?.find((b) => b.style === 'destructive')?.onPress?.());
    await w.render(<PlacesScreen />);
    expect(await screen.findByText(/123 Main St/)).toBeOnTheScreen();
    await tap('places-home');
    await tap('place-remove');
    await waitFor(async () => expect(await readPlaces(w.settings)).toEqual([]));
    alert.mockRestore();
  });
});

describe('Home’s places card', () => {
  it('shows until a place is saved, and opens Places', async () => {
    const w = await appWorld();
    await w.render(<HomePlacesCard hidden={false} />);
    await tap('home-places');
    expect(mockPush).toHaveBeenCalledWith('/settings/places');
    await w.settings.set(PLACES_KEY, [HOME]);
    expect(await readPlacesCard(w.settings)).toBe(false);
  });

  it('goes for good with Not now', async () => {
    const w = await appWorld();
    await w.render(<HomePlacesCard hidden={false} />);
    await tap('home-places-dismiss');
    expect(screen.queryByTestId('home-places')).toBeNull();
    await waitFor(async () => expect(await readPlacesCard(w.settings)).toBe(false));
    expect(await w.settings.get(PLACES_CARD_DISMISSED_KEY)).toBe(true);
  });

  it('never shows during a drive', async () => {
    const w = await appWorld();
    await w.render(<HomePlacesCard hidden />);
    await waitFor(async () => expect(await readPlacesCard(w.settings)).toBe(true));
    expect(screen.queryByTestId('home-places')).toBeNull();
  });
});

describe('Privacy zones and your places', () => {
  it('hides a place under a 300 m zone of its own with one switch', async () => {
    const w = await appWorld({ settings: { [PLACES_KEY]: [HOME] } });
    await w.render(<PrivacyZonesScreen />);
    await flip('zones-place-home-switch', true);
    await waitFor(async () => expect(await readZones(w.settings)).toEqual([expect.objectContaining({ name: 'Home', lat: 47.6, lng: -122.33, radiusM: 300, placeId: 'home' })]));
    await waitFor(() => expect(screen.getByTestId('zones-place-home-switch')).toHaveProp('value', true));
    expect(screen.getByTestId('zones-places')).toHaveTextContent(/Hidden · 300 m radius/);
    // The place's zone isn't listed again with the other zones.
    expect(screen.queryByTestId('zones-list')).toBeNull();
  });

  it('sets a hidden place’s size, centred on its address', async () => {
    const w = await appWorld({ settings: { [PLACES_KEY]: [HOME], [PRIVACY_ZONES_KEY]: [{ id: 'z1', name: 'Home', lat: 47.6, lng: -122.33, radiusM: 300, placeId: 'home' }] } });
    await w.render(<PrivacyZonesScreen />);
    await tap('zones-place-home');
    expect(await screen.findByTestId('zone-place-center')).toHaveTextContent('Centered on 123 Main St, Seattle, WA 98104.');
    expect(screen.queryByTestId('zone-name')).toBeNull();
    await tap('zone-bigger');
    await tap('zone-save');
    await waitFor(async () => expect((await readZones(w.settings))[0]).toEqual(expect.objectContaining({ radiusM: 350, placeId: 'home' })));
  });

  it('stops hiding a place after a check', async () => {
    const w = await appWorld({ settings: { [PLACES_KEY]: [HOME], [PRIVACY_ZONES_KEY]: [{ id: 'z1', name: 'Home', lat: 47.6, lng: -122.33, radiusM: 300, placeId: 'home' }] } });
    const alert = jest.spyOn(Alert, 'alert').mockImplementation((_t, _m, buttons) => buttons?.find((b) => b.style === 'destructive')?.onPress?.());
    await w.render(<PrivacyZonesScreen />);
    await flip('zones-place-home-switch', false);
    await waitFor(async () => expect(await readZones(w.settings)).toEqual([]));
    alert.mockRestore();
  });

  it('offers to add places when there are none', async () => {
    const w = await appWorld();
    await w.render(<PrivacyZonesScreen />);
    await tap('zones-add-places');
    expect(mockPush).toHaveBeenCalledWith('/settings/places');
  });
});

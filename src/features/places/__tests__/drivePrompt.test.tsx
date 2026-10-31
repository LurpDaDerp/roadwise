/**
 * The recap's "Save as …?" card: when it asks (a sure place, an empty slot, not saved, not said No
 * to, not turned off), what each answer does, and that a point in a privacy zone is never looked up.
 */
import { act, screen, waitFor } from '@testing-library/react-native';

import type { LearnedPlace } from '@/core/places/learn';
import type { Db } from '@/data/db/driver';
import { appWorld, clearQueryClients, tap } from '@/features/permissions/__fixtures__/harness';
import type { PrivacyZone } from '@/features/settings/privacyZones';

import { DrivePlacePrompt } from '../DrivePlacePrompt';
import { pickPrompt, readPromptOn, type PromptInputs } from '../drivePrompt';
import { PLACES_KEY, PLACE_NAMES_KEY, PROMPT_DECLINED_KEY, PROMPT_OFF_KEY, readPlaces } from '../model';

jest.mock('@/data/supabase/client', () => ({ supabase: {} }));
jest.mock('@/features/spots/recompute', () => ({ requestSpotRecompute: jest.fn() }));
const mockAddressAt = jest.fn();
jest.mock('../search', () => ({ ...jest.requireActual('../search'), addressAt: (p: unknown) => mockAddressAt(p) }));

afterEach(() => {
  clearQueryClients();
  mockAddressAt.mockReset();
});

const HOME = { lat: 47.62, lng: -122.35 };
const SCHOOL = { lat: 47.68, lng: -122.3 };

const learned = (over: Partial<LearnedPlace>): LearnedPlace => ({
  id: 'p',
  center: HOME,
  kind: 'home',
  visits: 30,
  days: 20,
  nights: 18,
  nightsSeen: 20,
  weekdays: 0,
  share: 0.5,
  pHome: 0.86,
  pWork: 0,
  lastSeen: 0,
  ...over,
});

const inputs = (over: Partial<PromptInputs> = {}): PromptInputs => ({
  ends: [HOME],
  learned: [learned({})],
  saved: [],
  declined: [],
  zones: [],
  address: async () => ({ title: '742 Evergreen Ter', subtitle: 'Seattle, WA' }),
  ...over,
});

describe('pickPrompt', () => {
  it('asks Home for a drive that ends where most nights end', async () => {
    expect(await pickPrompt(inputs())).toEqual(expect.objectContaining({ kind: 'home', why: 'nights', point: HOME }));
  });

  it('asks School for a place named like one, from the drive’s start when the end says nothing', async () => {
    const p = await pickPrompt(
      inputs({ ends: [{ lat: 10, lng: 10 }, SCHOOL], learned: [], address: async (pt) => (pt.lat === SCHOOL.lat ? { title: '2000 NE 1st St', subtitle: 'Seattle', poi: 'Lincoln High School' } : null) })
    );
    expect(p).toEqual(expect.objectContaining({ kind: 'school', why: 'name', point: SCHOOL }));
  });

  it('stays quiet when the slot is taken, the place is saved, or it was said No to', async () => {
    expect(await pickPrompt(inputs({ saved: [{ kind: 'home', lat: 1, lng: 1 }] }))).toBeNull();
    expect(await pickPrompt(inputs({ saved: [{ kind: 'custom', lat: HOME.lat, lng: HOME.lng }] }))).toBeNull();
    expect(await pickPrompt(inputs({ declined: [HOME] }))).toBeNull();
    expect(await pickPrompt(inputs({ learned: [learned({ nights: 2 })] }))).toBeNull();
  });

  it('never looks up a point inside a privacy zone, and names it by the zone', async () => {
    const zone: PrivacyZone = { id: 'z', name: 'Home', lat: HOME.lat, lng: HOME.lng, radiusM: 300 };
    const address = jest.fn(async () => null);
    const p = await pickPrompt(inputs({ zones: [zone], address }));
    expect(address).not.toHaveBeenCalled();
    expect(p).toEqual(expect.objectContaining({ kind: 'home', address: null, zone }));
  });
});

/** A commuter's month of drives ending at HOME at night (the learned read), and one drive to show. */
function withDrives(db: Db) {
  const DAY = 86_400_000;
  const HOUR = 3_600_000;
  const today = Math.floor(Date.now() / DAY) * DAY;
  const rows: Record<string, unknown>[] = [];
  // Every day: leave HOME at 08:00 UTC, back at 18:20; each night is spent at HOME.
  for (let d = 20; d >= 1; d -= 1) {
    const day = today - d * DAY;
    rows.push({ client_trip_id: `out${d}`, started_at: day + 8 * HOUR, ended_at: day + 8.3 * HOUR, tz: 'UTC', start_lat: HOME.lat, start_lng: HOME.lng, end_lat: 47.6, end_lng: -122.33 });
    rows.push({ client_trip_id: `in${d}`, started_at: day + 18 * HOUR, ended_at: day + 18.3 * HOUR, tz: 'UTC', start_lat: 47.6, start_lng: -122.33, end_lat: HOME.lat, end_lng: HOME.lng });
  }
  rows.sort((a, b) => (a.started_at as number) - (b.started_at as number));
  const execute = db.execute.bind(db);
  (db as { execute: Db['execute'] }).execute = async (sql, params) => {
    if (/WHERE client_trip_id = \?/.test(sql)) return { rows: [{ start_lat: 47.6, start_lng: -122.33, end_lat: HOME.lat, end_lng: HOME.lng }], changes: 0 };
    if (/FROM trips/.test(sql)) return { rows, changes: 0 };
    return execute(sql, params);
  };
}

describe('the recap card', () => {
  it('saves Home with Yes', async () => {
    const w = await appWorld({ settings: { [PLACE_NAMES_KEY]: [{ lat: HOME.lat, lng: HOME.lng, title: '742 Evergreen Ter', subtitle: 'Seattle, WA' }] } });
    withDrives(w.db);
    await w.render(<DrivePlacePrompt clientTripId="in1" />);
    expect(await screen.findByTestId('drive-place-prompt', {}, { timeout: 3000 })).toHaveTextContent(/Save as Home\?.*742 Evergreen Ter · Most nights end here/);
    await tap('drive-place-yes');
    await waitFor(async () => expect(await readPlaces(w.settings)).toEqual([expect.objectContaining({ id: 'home', kind: 'home', address: '742 Evergreen Ter', area: 'Seattle, WA' })]));
    expect(await screen.findByTestId('drive-place-saved')).toBeOnTheScreen();
    // Home's address was remembered, so it wasn't looked up again.
    expect(mockAddressAt).not.toHaveBeenCalledWith(HOME);
  });

  it('No never asks about that spot again', async () => {
    const w = await appWorld({ settings: { [PLACE_NAMES_KEY]: [{ lat: HOME.lat, lng: HOME.lng, title: '742 Evergreen Ter', subtitle: 'Seattle' }] } });
    withDrives(w.db);
    await w.render(<DrivePlacePrompt clientTripId="in1" />);
    await tap('drive-place-no');
    expect(screen.queryByTestId('drive-place-prompt')).toBeNull();
    await waitFor(async () => expect(await w.settings.get(PROMPT_DECLINED_KEY)).toEqual([HOME]));
    expect(await readPlaces(w.settings)).toEqual([]);
  });

  it('Don’t remind me turns the question off', async () => {
    const w = await appWorld({ settings: { [PLACE_NAMES_KEY]: [{ lat: HOME.lat, lng: HOME.lng, title: '742 Evergreen Ter', subtitle: 'Seattle' }] } });
    withDrives(w.db);
    await w.render(<DrivePlacePrompt clientTripId="in1" />);
    await tap('drive-place-never');
    expect(screen.queryByTestId('drive-place-prompt')).toBeNull();
    await waitFor(async () => expect(await readPromptOn(w.settings)).toBe(false));
  });

  it('shows nothing once Home and Work are saved or the question is off', async () => {
    const w = await appWorld({
      settings: {
        [PLACES_KEY]: [
          { id: 'home', kind: 'home', name: 'Home', address: 'x', area: '', lat: 1, lng: 1 },
          { id: 'work', kind: 'work', name: 'Work', address: 'y', area: '', lat: 2, lng: 2 },
        ],
      },
    });
    withDrives(w.db);
    await w.render(<DrivePlacePrompt clientTripId="in1" />);
    await act(async () => {
      await new Promise((r) => setTimeout(r, 50));
    });
    expect(screen.queryByTestId('drive-place-prompt')).toBeNull();
    await w.settings.set(PROMPT_OFF_KEY, true);
    expect(await readPromptOn(w.settings)).toBe(false);
  });
});

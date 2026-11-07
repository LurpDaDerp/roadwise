/**
 * The recap's practice row as the app wires it: the drive read from SQLite (`useDriveDetail`), Permit
 * mode's settings, and `usePracticeDrive`. The row shows for a kept drive on or after the start day
 * while Permit mode is on, and not for one before it, a "Wasn't driving" drive or an archived one;
 * the supervisor is the drive's own, else the copy kept through a sign-out, else the saved one; and
 * Change writes the drive's row and the recap updates.
 */
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react-native';
import { Text } from 'react-native';

import { createSqlJsDb } from '@/data/db/__fixtures__/sqljsDriver';
import { createSettingsRepo, createTripsRepo, migrate, type Db, type NewTrip } from '@/data/db';
import { DataProvider, useDriveDetail } from '@/data/queries';
import type { LocalDrive } from '@/data/queries/rows';
import { tap } from '@/features/permissions/__fixtures__/harness';
import { dayKey } from '@/lib/time';
import { ThemeProvider } from '@/ui';

import { DRIVE_SUPERVISORS_KEY } from '../notes';
import { PracticeDriveRow } from '../PracticeDriveRow';
import { PERMIT_KEYS } from '../prefs';
import { PERMIT_QUERY, usePracticeDrive } from '../usePermit';

jest.mock('@/data/supabase/client', () => ({ supabase: {} }));

// The clock is pinned to noon today (only Date is faked; timers stay real, so waitFor and the
// queries run as usual): the fixture drives, an hour or three before now, then always fall on the
// log's start day (today), whenever the suite runs. Unpinned, a run soon after midnight put them on
// yesterday, before the start day, and out of the log.
const NOON = new Date();
NOON.setHours(12, 0, 0, 0);
jest.useFakeTimers({
  now: NOON,
  doNotFake: ['hrtime', 'nextTick', 'performance', 'queueMicrotask', 'requestAnimationFrame', 'cancelAnimationFrame', 'requestIdleCallback', 'cancelIdleCallback', 'setImmediate', 'clearImmediate', 'setInterval', 'clearInterval', 'setTimeout', 'clearTimeout'],
});
afterAll(() => jest.useRealTimers());

const NOW = Date.now();
const DAY_MS = 86_400_000;
const TZ = Intl.DateTimeFormat().resolvedOptions().timeZone;
const TODAY = dayKey(new Date(NOW));

let db: Db;
let client: QueryClient;
beforeEach(async () => {
  db = await createSqlJsDb();
  await migrate(db);
  client = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: Infinity } } });
});
afterEach(() => client.clear());

const permitOn = async (over: Record<string, unknown> = {}) => {
  const settings = createSettingsRepo(db);
  const values = { [PERMIT_KEYS.enabled]: true, [PERMIT_KEYS.startDay]: TODAY, [PERMIT_KEYS.supervisor]: 'Dad', ...over };
  for (const [k, v] of Object.entries(values)) await settings.set(k, v);
};

const trip = (over: Partial<NewTrip> = {}): NewTrip => ({
  client_trip_id: 'p',
  started_at: NOW - 40 * 60_000,
  ended_at: NOW - 10 * 60_000,
  duration_s: 1800,
  miles: 10,
  night_miles: 0,
  tz: TZ,
  status: 'scored',
  ...over,
});

function Practice({ drive }: { drive: LocalDrive }) {
  const { practice, setSupervisor } = usePracticeDrive(drive);
  return practice === null ? <Text testID="no-practice">none</Text> : <PracticeDriveRow practice={practice} onSupervisor={setSupervisor} />;
}

function Recap({ id }: { id: string }) {
  const detail = useDriveDetail(id);
  return detail.data ? <Practice drive={detail.data.drive} /> : <Text testID="loading">loading</Text>;
}

async function show(id = 'p') {
  await render(
    <ThemeProvider>
      <QueryClientProvider client={client}>
        <DataProvider db={db}>
          <Recap id={id} />
        </DataProvider>
      </QueryClientProvider>
    </ThemeProvider>
  );
  await waitFor(() => expect(screen.queryByTestId('loading')).toBeNull());
}

test('a kept drive in the log shows the row with the saved supervisor; Change writes this drive and the recap updates', async () => {
  await permitOn();
  await createTripsRepo(db).insert(trip(), NOW);
  await show();
  expect(await screen.findByTestId('summary-practice-line')).toHaveTextContent(/^30 min · \d+ min at night · with Dad$/);
  await tap('summary-practice-change');
  await act(async () => {
    fireEvent.changeText(screen.getByTestId('summary-practice-sheet-input'), 'Coach Kim');
  });
  await tap('summary-practice-sheet-save');
  await waitFor(() => expect(screen.getByTestId('summary-practice-line')).toHaveTextContent(/with Coach Kim$/));
  expect((await createTripsRepo(db).get('p'))?.practice_supervisor).toBe('Coach Kim');
  expect(await createSettingsRepo(db).get(DRIVE_SUPERVISORS_KEY)).toEqual({ p: 'Coach Kim' });
});

test("the drive's own supervisor comes first", async () => {
  await permitOn({ [DRIVE_SUPERVISORS_KEY]: { p: 'Mom' } });
  await createTripsRepo(db).insert(trip({ practice_supervisor: 'Grandpa' }), NOW);
  await show('p');
  expect(await screen.findByTestId('summary-practice-line')).toHaveTextContent(/with Grandpa$/);
});

test('with none on the row (restored after a sign-out), the copy kept beside it', async () => {
  await permitOn({ [DRIVE_SUPERVISORS_KEY]: { q: 'Aunt Jo' } });
  await createTripsRepo(db).insert(trip({ client_trip_id: 'q' }), NOW);
  await show('q');
  await waitFor(() => expect(screen.getByTestId('summary-practice-line')).toHaveTextContent(/with Aunt Jo$/));
});

test.each([
  ['Permit mode is off', { [PERMIT_KEYS.enabled]: false }, {}],
  ['the drive is before the start day', {}, { started_at: NOW - 3 * DAY_MS, ended_at: NOW - 3 * DAY_MS + 30 * 60_000 }],
  ['the drive was marked "Wasn\'t driving"', {}, { status: 'not_driving' as const }],
  ['the drive could not be scored', {}, { status: 'unscored' as const, reason: 'server_error' }],
])('no row when %s', async (_name, settings, over) => {
  await permitOn(settings);
  await createTripsRepo(db).insert(trip(over), NOW);
  await show();
  // Once the settings are read (before that, no row either).
  await waitFor(() => expect(client.getQueryState(PERMIT_QUERY)?.status).toBe('success'));
  expect(await screen.findByTestId('no-practice')).toBeOnTheScreen();
  expect(screen.queryByTestId('summary-practice')).toBeNull();
});

test('no row on an archived drive', async () => {
  await permitOn();
  await createTripsRepo(db).insert(trip({ archived_at: NOW }), NOW);
  const archived = { clientTripId: 'p', startedAt: NOW - 40 * 60_000, endedAt: NOW - 10 * 60_000, durationS: 1800, miles: 10, nightMiles: 0, tz: TZ, status: 'scored', archived: true } as unknown as LocalDrive;
  await render(
    <ThemeProvider>
      <QueryClientProvider client={client}>
        <DataProvider db={db}>
          <Practice drive={archived} />
        </DataProvider>
      </QueryClientProvider>
    </ThemeProvider>
  );
  await waitFor(() => expect(client.getQueryState(PERMIT_QUERY)?.status).toBe('success'));
  expect(await screen.findByTestId('no-practice')).toBeOnTheScreen();
});

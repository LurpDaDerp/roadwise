import { fireEvent, screen, within } from '@testing-library/react-native';

import { createQueueRepo, type Db } from '@/data/db';
import { deductions, T0, tripRow } from '@/data/queries/__fixtures__/rows';
import { LastTripCard } from '@/features/home/LastTripCard';
import {
  brokenDb,
  clearQueryClients,
  routerDouble,
  world,
} from '@/features/trips/__fixtures__/render';

const mockRouter = routerDouble();
jest.mock('expo-router', () => ({ useRouter: () => mockRouter }));
// The trips barrel now carries D1's rewards field, whose hooks load the Supabase client (M5 T11).
jest.mock('@/data/supabase/client', () => ({ supabase: {} }));

const DAY = 86_400_000;
const drive = (id: string, daysAgo: number, over: Parameters<typeof tripRow>[0] = {}) =>
  tripRow({ client_trip_id: id, started_at: T0 - daysAgo * DAY, ...over });

/**
 * The card reads the database twice — the last drive, then the scored drives it counts — through
 * one `Db`. This lets the second read fail while the first stands, which is the only way the two
 * queries can disagree.
 */
function failNthRead(db: Db, nth: number): Db {
  let reads = 0;
  return {
    execute(sql, params) {
      reads += 1;
      return reads === nth
        ? Promise.reject(new Error('SQLITE_CORRUPT: database disk image is malformed'))
        : db.execute(sql, params);
    },
    transaction: (fn) => db.transaction(fn),
  };
}

beforeEach(() => mockRouter.push.mockClear());
afterEach(clearQueryClients);

test('with no drives yet the card says where the first one will land', async () => {
  const w = await world();
  await w.renderScreen(<LastTripCard />);
  expect(await screen.findByText('Your first drive will appear here')).toBeOnTheScreen();
});

test('prints the last drive — score, band, route, date, splits — and counts toward the score', async () => {
  const w = await world({
    trips: [
      drive('older', 3, { score: 70 }),
      drive('last', 1, { score: 84, category_deductions_json: JSON.stringify(deductions({ speeding: 16 })) }),
    ],
  });
  await w.renderScreen(<LastTripCard />);

  expect(await screen.findByText('84')).toBeOnTheScreen();
  // The field caption is printed on the card, not only spoken by the row.
  expect(screen.getByText('Last drive')).toBeOnTheScreen();
  expect(screen.getByText('Good')).toBeOnTheScreen();
  expect(screen.getByText('Near Home → Near Lincoln HS')).toBeOnTheScreen();
  expect(screen.getByText('Sun, Jan 4 · 12:00 – 12:30 PM')).toBeOnTheScreen();
  expect(screen.getByText('30 min')).toBeOnTheScreen();
  expect(screen.getByText('10 mi')).toBeOnTheScreen();
  expect(screen.getByText('Building your score: 2 of 3 drives')).toBeOnTheScreen();

  // The top highlight (§7.B B1 item 5) is the first of the three D1 prints — a positive here.
  expect(screen.getByText('No phone use')).toBeOnTheScreen();

  // Spoken with "to", never the printed arrow (M-7).
  await fireEvent.press(
    screen.getByRole('button', {
      name: /Last drive, Near Home to Near Lincoln HS, .*No phone use, 84, Good/,
    })
  );
  expect(mockRouter.push).toHaveBeenCalledWith({
    pathname: '/(app)/trips/[clientTripId]/summary',
    params: { clientTripId: 'last' },
  });
});

test('once three drives are scored the score is no longer being built', async () => {
  const w = await world({
    trips: [drive('a', 3, { score: 70 }), drive('b', 2, { score: 80 }), drive('c', 1, { score: 90 })],
  });
  await w.renderScreen(<LastTripCard />);
  await screen.findByText('90');
  expect(screen.queryByText(/Building your score/)).toBeNull();
});

test('an unscored last drive prints a dash, and an unclassified one asks its question here', async () => {
  const w = await world({
    trips: [drive('last', 0, { score: null, status: 'unscored', role: 'unknown' })],
  });
  await w.renderScreen(<LastTripCard />);
  expect(await screen.findByText('Not scored')).toBeOnTheScreen();
  expect(screen.getByText('Building your score: 0 of 3 drives')).toBeOnTheScreen();

  await fireEvent.press(screen.getByRole('button', { name: 'Bus, train, other' }));
  await screen.findByRole('button', { name: /Last drive/ });
  const [item] = await createQueueRepo(w.db).nextDue(Date.now() + 1, 10);
  expect(JSON.parse(item?.payload_json ?? '{}')).toMatchObject({ action: 'set-role', role: 'other' });
  expect(screen.queryByText('Were you driving?')).toBeNull();
});

test('the three splits are printed inside the row, and the row speaks them', async () => {
  const w = await world({
    trips: [
      drive('last', 1, {
        conditions_json: JSON.stringify({ night: true, precipitation: true, hadSevereEvent: false }),
      }),
    ],
  });
  await w.renderScreen(<LastTripCard />);

  expect(await screen.findByText('Night, rain')).toBeOnTheScreen();
  const row = screen.getByTestId('last-trip-row');
  // Inside the press target, so the whole record row is tappable and washes as one.
  expect(within(row).getByText('30 min')).toBeOnTheScreen();
  expect(within(row).getByText('10 mi')).toBeOnTheScreen();
  expect(within(row).getByText('Night, rain')).toBeOnTheScreen();
  expect(
    screen.getByRole('button', {
      name: 'Last drive, Near Home to Near Lincoln HS, Sun, Jan 4 · 12:00 – 12:30 PM, 30 min, 10 mi, Night, rain, No phone use, 90, Excellent',
    })
  ).toBeOnTheScreen();
});

test('with nothing clean to claim the highlight is the costliest category, named without a count', async () => {
  const w = await world({
    trips: [
      drive('last', 1, {
        score: 55,
        category_deductions_json: JSON.stringify(
          deductions({ speeding: 18, phone: 9, braking: 6, accel: 5, cornering: 4 })
        ),
      }),
    ],
  });
  await w.renderScreen(<LastTripCard />);
  // The Home row reads no timeline, so there is no episode count to print here; the card back has it.
  expect(await screen.findByText('Speeding')).toBeOnTheScreen();
  expect(screen.queryByText(/episode/)).toBeNull();
});

test('an unscored drive has no highlight to print', async () => {
  const w = await world({ trips: [drive('last', 1, { score: null, status: 'unscored' })] });
  await w.renderScreen(<LastTripCard />);
  await screen.findByText('Not scored');
  expect(screen.queryByText('No phone use')).toBeNull();
});

test('a count that cannot be read says so, with a retry, rather than a wrong number', async () => {
  const w = await world({
    trips: [drive('a', 3, { score: 70 }), drive('last', 1, { score: 84 })],
  });
  // The last drive is read first and stands; the count behind it fails.
  await w.renderScreen(<LastTripCard />, failNthRead(w.db, 2));
  expect(await screen.findByText('84')).toBeOnTheScreen();
  expect(screen.queryByText(/Building your score/)).toBeNull();
  expect(screen.getByText("Couldn't count your drives.")).toBeOnTheScreen();
  expect(screen.getByRole('button', { name: 'Try again' })).toBeOnTheScreen();
});

test('a database that cannot be read fails on the card alone, with a retry', async () => {
  const w = await world();
  await w.renderScreen(<LastTripCard />, brokenDb());
  expect(await screen.findByText("Couldn't read your last drive.")).toBeOnTheScreen();
  expect(screen.getByRole('button', { name: 'Try again' })).toBeOnTheScreen();
});

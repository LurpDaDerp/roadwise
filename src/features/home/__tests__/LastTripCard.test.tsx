import { fireEvent, screen } from '@testing-library/react-native';

import { createQueueRepo } from '@/data/db';
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

const DAY = 86_400_000;
const drive = (id: string, daysAgo: number, over: Parameters<typeof tripRow>[0] = {}) =>
  tripRow({ client_trip_id: id, started_at: T0 - daysAgo * DAY, ...over });

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
  expect(screen.getByText('Good')).toBeOnTheScreen();
  expect(screen.getByText('Near Home → Near Lincoln HS')).toBeOnTheScreen();
  expect(screen.getByText('Sun, Jan 4 · 12:00 – 12:30 PM')).toBeOnTheScreen();
  expect(screen.getByText('30 min')).toBeOnTheScreen();
  expect(screen.getByText('10 mi')).toBeOnTheScreen();
  expect(screen.getByText('Building your score: 2 of 3 drives')).toBeOnTheScreen();

  await fireEvent.press(
    screen.getByRole('button', { name: /Last drive, Near Home → Near Lincoln HS, .*84, Good/ })
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

test('a database that cannot be read fails on the card alone, with a retry', async () => {
  const w = await world();
  await w.renderScreen(<LastTripCard />, brokenDb());
  expect(await screen.findByText("Couldn't read your last drive.")).toBeOnTheScreen();
  expect(screen.getByRole('button', { name: 'Try again' })).toBeOnTheScreen();
});

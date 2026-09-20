import { fireEvent, screen } from '@testing-library/react-native';

import { createSettingsRepo } from '@/data/db';
import { deductions, eventRow, T0, tripRow } from '@/data/queries/__fixtures__/rows';
import { clearQueryClients, routerDouble, world } from '@/features/trips/__fixtures__/render';
import { TipScreen, WEEKLY_FOCUS_KEY, type WeeklyFocus } from '@/features/trips/TipScreen';

const mockRouter = routerDouble();
jest.mock('expo-router', () => ({ useRouter: () => mockRouter }));

const ID = 'trip-1';

beforeEach(() => {
  mockRouter.back.mockClear();
  mockRouter.dismissTo.mockClear();
});

afterEach(clearQueryClients);

test('a coaching tip is read in full, with the moments from this drive it is about', async () => {
  const w = await world({
    trips: [
      tripRow({
        client_trip_id: ID,
        score: 91,
        category_deductions_json: JSON.stringify(deductions({ braking: 9 })),
      }),
    ],
    events: [
      eventRow({ id: 'b1', client_trip_id: ID, category: 'braking', started_at: T0 + 5 * 60_000, deduction: 4, measured_json: JSON.stringify({ peakG: -0.42 }) }),
      eventRow({ id: 'b2', client_trip_id: ID, category: 'braking', started_at: T0 + 9 * 60_000, deduction: 5, measured_json: JSON.stringify({ peakG: -0.5 }) }),
      eventRow({ id: 'b3', client_trip_id: ID, category: 'braking', started_at: T0 + 12 * 60_000, deduction: 3 }),
      eventRow({ id: 'p', client_trip_id: ID, category: 'braking', status: 'possible', deduction: 0 }),
    ],
  });
  await w.renderScreen(<TipScreen clientTripId={ID} />);

  expect(await screen.findByRole('header', { name: 'Leave a three-second gap' })).toBeOnTheScreen();
  expect(screen.getByText(/Why it matters/i)).toBeOnTheScreen();
  // Two examples at most, the ones that cost points, at the trip's own times.
  expect(screen.getByLabelText('12:05 PM, 0.42 g brake')).toBeOnTheScreen();
  expect(screen.getByLabelText('12:09 PM, 0.50 g brake')).toBeOnTheScreen();
  expect(screen.queryByText(/12:12 PM/)).toBeNull();
});

test('Practice this week keeps the tip as the weekly focus and confirms in place', async () => {
  const w = await world({
    trips: [tripRow({ client_trip_id: ID, score: 91, category_deductions_json: JSON.stringify(deductions({ braking: 9 })) })],
  });
  await w.renderScreen(<TipScreen clientTripId={ID} />);
  await screen.findByRole('header', { name: 'Leave a three-second gap' });

  await fireEvent.press(screen.getByRole('button', { name: 'Practice this week' }));

  expect(await screen.findByText('This is your focus this week.')).toBeOnTheScreen();
  expect(screen.getByRole('button', { name: 'Focus set for this week' })).toBeDisabled();
  const stored = await createSettingsRepo(w.db).get<WeeklyFocus>(WEEKLY_FOCUS_KEY);
  expect(stored?.tipId).toBe('braking-low-new');
});

test('the clean-drive card has nothing to practise: it reads, and Done goes back', async () => {
  const w = await world({ trips: [tripRow({ client_trip_id: ID, score: 100, status: 'final', sync_state: 'synced' })] });
  await w.renderScreen(<TipScreen clientTripId={ID} />);
  expect(await screen.findByRole('header', { name: 'Keep the run going' })).toBeOnTheScreen();
  expect(screen.queryByRole('button', { name: 'Practice this week' })).toBeNull();
  await fireEvent.press(screen.getByRole('button', { name: 'Done' }));
  expect(mockRouter.back).toHaveBeenCalled();
});

test('a drive that is on the record but has nothing to coach says exactly that', async () => {
  const w = await world({ trips: [tripRow({ client_trip_id: ID, score: null, status: 'unscored' })] });
  await w.renderScreen(<TipScreen clientTripId={ID} />);
  expect(await screen.findByText('No tip for this drive')).toBeOnTheScreen();
  expect(screen.getByText("This drive didn't cost points in any one area.")).toBeOnTheScreen();
  expect(screen.queryByText("This drive isn't on your record")).toBeNull();
});

test('a drive that is not on the record at all is still the not-found state', async () => {
  const w = await world();
  await w.renderScreen(<TipScreen clientTripId="missing" />);
  expect(await screen.findByText("This drive isn't on your record")).toBeOnTheScreen();
});

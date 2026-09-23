import { screen } from '@testing-library/react-native';
import { useState } from 'react';
import { AccessibilityInfo } from 'react-native';

import { deductions, MILE_M, tripRow } from '@/data/queries/__fixtures__/rows';
import {
  brokenDb,
  clearQueryClients,
  flush,
  press,
  routerDouble,
  world,
} from '@/features/insights/__fixtures__/render';
import type { InsightsPeriod } from '@/features/insights/period';
import { TotalsScreen } from '@/features/insights/TotalsScreen';

const mockRouter = routerDouble();
jest.mock('expo-router', () => ({ useRouter: () => mockRouter }));

const NOW = Date.UTC(2026, 0, 26, 12);
const now = () => NOW;

const drive = (
  id: string,
  startedAt: number,
  over: Parameters<typeof tripRow>[0] = {}
) =>
  tripRow({
    client_trip_id: id,
    started_at: startedAt,
    distance_m: 10 * MILE_M,
    duration_s: 1800,
    ...over,
  });

const NIGHT = JSON.stringify({ night: true, precipitation: false, hadSevereEvent: false });

const TRIPS = [
  drive('a', Date.UTC(2026, 0, 5, 12), { score: 88 }),
  drive('b', Date.UTC(2026, 0, 12, 12), {
    score: 84,
    distance_m: 20 * MILE_M,
    duration_s: 3600,
    category_deductions_json: JSON.stringify(deductions({ phone: 8 })),
    conditions_json: NIGHT,
  }),
  drive('c', Date.UTC(2026, 0, 19, 12), { score: 91 }),
  // A drive as a passenger is not the driver's record, and never counted in it.
  drive('p', Date.UTC(2026, 0, 20, 12), { role: 'passenger', score: null, status: 'unscored' }),
];

/** Three driving days, two of them consecutive and safe. */
const DAYS: [string, unknown][] = [
  ['2026-01-05', { day: '2026-01-05', safeDay: true }],
  ['2026-01-12', { day: '2026-01-12', safeDay: false }],
  ['2026-01-19', { day: '2026-01-19', safeDay: true }],
  ['2026-01-20', { day: '2026-01-20', safeDay: true }],
];

function Route({ initial = 'all' as InsightsPeriod }) {
  const [period, setPeriod] = useState<InsightsPeriod>(initial);
  return <TotalsScreen period={period} onPeriodChange={setPeriod} />;
}

/**
 * All three reads have landed. The screen only carries this testID once the aggregate, the drives
 * and the day cache have all settled, so awaiting it cannot leave a read to land after the test.
 */
async function ready(): Promise<void> {
  await screen.findByTestId('totals-screen');
  await flush();
}

beforeEach(() => {
  jest.spyOn(AccessibilityInfo, 'isReduceMotionEnabled').mockResolvedValue(true);
});

afterEach(clearQueryClients);

test('the record prints miles, hours, safe days, the streak and the best week', async () => {
  const w = await world({ trips: TRIPS, days: DAYS }, now);
  await w.renderScreen(<Route />);
  await ready();

  expect(screen.getByRole('header', { name: 'Totals & records' })).toBeOnTheScreen();
  // Each row is one accessible sentence, so the record reads in eight swipes.
  expect(screen.getByLabelText('Drives, 3')).toBeOnTheScreen();
  expect(screen.getByLabelText('Miles, 40 mi')).toBeOnTheScreen();
  expect(screen.getByLabelText('Driving time, 2 h 00 min')).toBeOnTheScreen();
  expect(screen.getByLabelText('Safe days on this phone, 3 days')).toBeOnTheScreen();
  // Never the bare label Home uses for its settled count (final review m8).
  expect(screen.queryByText('Safe days')).toBeNull();
  // Two consecutive safe driving days; the unsafe one in between resets the run.
  expect(screen.getByLabelText('Longest run of safe days, 2 days')).toBeOnTheScreen();
  expect(screen.getByLabelText('Best week, 91 · Week of Jan 19')).toBeOnTheScreen();
  // Phone cost points on the 20-mile drive, so only the two clean ones are phone-free miles.
  expect(screen.getByLabelText('Phone-free miles, 20 mi')).toBeOnTheScreen();
  expect(screen.getByLabelText('Night miles, 20 mi')).toBeOnTheScreen();
});

test('nothing on the record is a target, a comparison or a reward', async () => {
  const w = await world({ trips: TRIPS, days: DAYS }, now);
  await w.renderScreen(<Route />);
  await ready();

  expect(
    screen.getByText('These describe your driving. Nothing here earns points, badges or levels.')
  ).toBeOnTheScreen();
  expect(screen.getByText('Drives where you were the driver.')).toBeOnTheScreen();
  expect(
    screen.getByText(
      "Safe days here are counted from the drives on this phone, once a day has synced. Home's safe days count only days confirmed since rewards began, so the two can differ."
    )
  ).toBeOnTheScreen();
  // Descriptive only: no other driver appears anywhere on the page.
  expect(screen.queryByText(/average|other drivers|than you|rank/i)).toBeNull();
});

test('the period narrows the record without changing what it means', async () => {
  const w = await world({ trips: TRIPS, days: DAYS }, now);
  await w.renderScreen(<Route />);
  await ready();
  expect(screen.getByLabelText('Drives, 3')).toBeOnTheScreen();
  expect(screen.getByLabelText('Miles, 40 mi')).toBeOnTheScreen();

  // Four weeks back from 26 January opens on 29 December, so every drive is still inside it:
  // the window moved, the meaning of each field did not.
  // The selector stays put while the record reprints, and the record comes back whole: three
  // reads have to land, which is more than one turn of the loop.
  await press(screen.getByRole('radio', { name: '4 weeks' }));
  expect(screen.getByRole('radio', { name: '4 weeks', selected: true })).toBeOnTheScreen();
  await ready();
  expect(screen.getByLabelText('Drives, 3')).toBeOnTheScreen();
  expect(
    screen.getByText('These describe your driving. Nothing here earns points, badges or levels.')
  ).toBeOnTheScreen();
});

test('a record with nothing on it says what would fill it', async () => {
  const w = await world({}, now);
  await w.renderScreen(<Route />);
  await ready();

  expect(screen.getByText('Nothing on the record yet')).toBeOnTheScreen();
  expect(screen.getByText('Drives you take as the driver are totalled here.')).toBeOnTheScreen();
  expect(screen.queryByTestId('total-miles')).toBeNull();
});

test('no share door and no "coming soon": F9 exists, and no card shows these descriptive totals (M5 T13)', async () => {
  const w = await world({ trips: TRIPS, days: DAYS }, now);
  await w.renderScreen(<Route />);
  await ready();

  expect(screen.queryByRole('button', { name: 'Share a record' })).toBeNull();
  expect(screen.queryByText(/coming soon/i)).toBeNull();
});

test('a database that cannot be read says so in place and offers a retry', async () => {
  const w = await world({}, now);
  await w.renderScreen(<Route />, brokenDb());
  expect(await screen.findByText("Couldn't read your drives.")).toBeOnTheScreen();
  expect(screen.getByRole('button', { name: 'Try again' })).toBeOnTheScreen();
});

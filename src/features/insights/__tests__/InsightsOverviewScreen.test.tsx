import { screen, within } from '@testing-library/react-native';
import { useState } from 'react';
import { AccessibilityInfo } from 'react-native';

import { deductions, MILE_M, tripRow } from '@/data/queries/__fixtures__/rows';
import {
  brokenDb,
  clearQueryClients,
  flush,
  press,
  routerDouble,
  slowDb,
  world,
} from '@/features/insights/__fixtures__/render';
import { InsightsOverviewScreen } from '@/features/insights/InsightsOverviewScreen';
import type { InsightsPeriod } from '@/features/insights/period';

const mockRouter = routerDouble();
jest.mock('expo-router', () => ({ useRouter: () => mockRouter }));

/** Monday 26 January 2026, noon UTC — the instant every window below is measured back from. */
const NOW = Date.UTC(2026, 0, 26, 12);
const now = () => NOW;

const DAY = 86_400_000;

const MON = {
  dec1: Date.UTC(2025, 11, 1, 12),
  dec8: Date.UTC(2025, 11, 8, 12),
  jan5: Date.UTC(2026, 0, 5, 12),
  jan12: Date.UTC(2026, 0, 12, 12),
  jan19: Date.UTC(2026, 0, 19, 12),
};

const drive = (
  id: string,
  startedAt: number,
  score: number,
  lost: Parameters<typeof deductions>[0] = {},
  over: Parameters<typeof tripRow>[0] = {}
) =>
  tripRow({
    client_trip_id: id,
    started_at: startedAt,
    score,
    category_deductions_json: JSON.stringify(deductions(lost)),
    ...over,
  });

/**
 * Two drives in the 8-week baseline and three in the current four weeks, so the you-vs-you card
 * has both halves, the period switch changes every number, and the 3-month window has quiet
 * weeks in the middle of it.
 */
const TRIPS = [
  drive('b1', MON.dec1, 80, { speeding: 6 }),
  drive('b2', MON.dec8, 80, { speeding: 6 }),
  drive('a', MON.jan5, 80, { phone: 8, speeding: 4 }),
  drive('b', MON.jan12, 84, { phone: 4, speeding: 4 }),
  drive('c', MON.jan19, 90),
];

/**
 * Both of the screen's reads have landed. The insights aggregate and the drive list resolve
 * independently, and pressing anything while the second is still in flight overlaps React's
 * `act` queue — which breaks every later render in the worker, not just this test.
 */
async function settled(): Promise<void> {
  await screen.findByText('Smooth braking for 5 drives');
}

/** The route's own job: the period lives in the URL, and changing it re-reads the screen. */
function Route({ initial = '4w' as InsightsPeriod }) {
  const [period, setPeriod] = useState<InsightsPeriod>(initial);
  return <InsightsOverviewScreen period={period} onPeriodChange={setPeriod} />;
}

beforeEach(() => {
  mockRouter.push.mockClear();
  mockRouter.back.mockClear();
  // Reduce motion on: `Skeleton`'s pulse is an endless `withRepeat`, and under Jest a handful of
  // those running at once starve `waitFor`'s own timer. Off is covered by the charts' own suite.
  jest.spyOn(AccessibilityInfo, 'isReduceMotionEnabled').mockResolvedValue(true);
});

afterEach(clearQueryClients);

describe('while the drives are read', () => {
  test('the page is drawn as a skeleton, never a spinner', async () => {
    const w = await world({ trips: TRIPS }, now);
    await w.renderScreen(<Route />, slowDb(w.db, 200));
    expect(screen.getByRole('progressbar', { name: 'Loading your insights' })).toBeOnTheScreen();
    expect(await screen.findByText('Up 10 points over 4 weeks.')).toBeOnTheScreen();
  });

  test('a database that cannot be read says so in place and offers a retry', async () => {
    const w = await world({}, now);
    await w.renderScreen(<Route />, brokenDb());
    expect(await screen.findByText("Couldn't read your drives.")).toBeOnTheScreen();
    expect(screen.getByRole('button', { name: 'Try again' })).toBeOnTheScreen();
  });
});

describe('with enough scored drives', () => {
  test('prints the score, the trend and its summary, and the trend can be read as a table', async () => {
    const w = await world({ trips: TRIPS }, now);
    await w.renderScreen(<Route />);

    await settled();
    expect(screen.getByRole('header', { name: 'Insights' })).toBeOnTheScreen();
    expect(screen.getByTestId('long-term-score')).toBeOnTheScreen();
    expect(screen.getByText('Up 10 points over 4 weeks.')).toBeOnTheScreen();

    // The drawing is one accessible image carrying the data; the marks inside it are hidden.
    expect(screen.getByRole('image', { name: /^Score trend, from 80 to 90 over \d+ weeks$/ })).toBeOnTheScreen();

    const trend = within(screen.getByTestId('trend'));
    await press(trend.getByRole('button', { name: 'Show as table' }));
    expect(await screen.findByLabelText('Week of Jan 19, 90, Excellent')).toBeOnTheScreen();
  });

  test('you vs. you compares the last four weeks with the driver s own earlier drives, and says so', async () => {
    const w = await world({ trips: TRIPS }, now);
    await w.renderScreen(<Route />);

    await settled();
    expect(screen.getByText('Your last 4 weeks')).toBeOnTheScreen();
    expect(screen.getByLabelText('Score 84, Up 4 from your baseline, better')).toBeOnTheScreen();
    expect(screen.getByLabelText('Speeding, 2 fewer points a drive than your baseline, better')).toBeOnTheScreen();
    expect(screen.getByLabelText('Phone use, 4 more points a drive than your baseline, more lost')).toBeOnTheScreen();
    expect(screen.getByLabelText('Hard braking, same as your baseline')).toBeOnTheScreen();

    // A baseline computed on this phone never claims to be a stored one.
    expect(
      screen.getByText('Compared with your own drives from the 8 weeks before these 4.')
    ).toBeOnTheScreen();
    expect(screen.queryByText('Compared with your 8-week baseline.')).toBeNull();
  });

  test('the breakdown names the costliest category, opens it, and toggles to a table', async () => {
    const w = await world({ trips: TRIPS }, now);
    await w.renderScreen(<Route />);

    await settled();
    expect(screen.getByText('Phone use was 60% of the points you lost over 4 weeks.')).toBeOnTheScreen();

    await press(screen.getByRole('button', { name: 'Phone use, 60% of points lost, 12 points' }));
    expect(mockRouter.push).toHaveBeenCalledWith({
      pathname: '/(app)/insights/[category]',
      params: { category: 'phone', period: '4w' },
    });

    // The same numbers as a ruled table. Scoped to the table: the bar row it replaces carries the
    // identical sentence, and a bare query would match whichever of the two the tick still held.
    await press(
      within(screen.getByTestId('breakdown-chart')).getByRole('button', { name: 'Show as table' })
    );
    await flush();
    expect(
      within(screen.getByTestId('breakdown-chart-table')).getByLabelText(
        'Speeding, 40% of points lost, 8 points'
      )
    ).toBeOnTheScreen();
  });

  test('highlights count runs of clean drives, and conditions are stated without comparing them', async () => {
    const w = await world({ trips: TRIPS }, now);
    await w.renderScreen(<Route />);

    await settled();
    expect(screen.getByText('Smooth braking for 5 drives')).toBeOnTheScreen();
    expect(screen.getByText('Smooth acceleration for 5 drives')).toBeOnTheScreen();
    // Phone and speeding both cost points on the second-newest drive, so neither has a run.
    expect(screen.queryByText(/^Phone-free for/)).toBeNull();

    expect(screen.getByLabelText('Day, score 85, 3 drives · 30 mi')).toBeOnTheScreen();
    expect(screen.getByLabelText('Night, no drives')).toBeOnTheScreen();
    expect(
      screen.getByText('How your drives went in each. For information only; nothing here is compared or scored.')
    ).toBeOnTheScreen();
  });

  test('changing the period re-reads every number, and quiet weeks earn the spec s note', async () => {
    const w = await world({ trips: TRIPS }, now);
    await w.renderScreen(<Route />);

    await settled();
    expect(screen.getByText('Up 10 points over 4 weeks.')).toBeOnTheScreen();

    await press(screen.getByRole('radio', { name: '3 months' }));
    await flush();

    expect(
      screen.getByText(
        'Up 10 points over 3 months. Weeks without a drive leave a gap. Driving less never lowers your score.'
      )
    ).toBeOnTheScreen();
    expect(screen.getByText('Speeding was 63% of the points you lost over 3 months.')).toBeOnTheScreen();
    expect(screen.getByRole('radio', { name: '3 months', selected: true })).toBeOnTheScreen();
    expect(screen.getByRole('radio', { name: '4 weeks', selected: false })).toBeOnTheScreen();
  });

  test('the record and the explainer are one tap away', async () => {
    const w = await world({ trips: TRIPS }, now);
    await w.renderScreen(<Route />);

    await settled();
    await press(screen.getByRole('button', { name: /^Totals & records/ }));
    expect(mockRouter.push).toHaveBeenCalledWith({
      pathname: '/(app)/insights/totals',
      params: { period: '4w' },
    });

    await press(screen.getByRole('button', { name: /^How scoring works/ }));
    expect(mockRouter.push).toHaveBeenCalledWith('/(app)/insights/how-scoring-works');
  });
});

test('a period with no drives in it says so once, instead of six bars of nothing', async () => {
  // Three scored drives all-time, so the overview is past its progress state; none of them in the
  // last four weeks, so the window itself is empty.
  const w = await world(
    { trips: [drive('b1', MON.dec1, 80), drive('b2', MON.dec8, 80), drive('b3', MON.dec8 + DAY, 80)] },
    now
  );
  await w.renderScreen(<Route />);
  await screen.findByTestId('insights-overview');
  await flush();

  expect(screen.getByTestId('quiet-period')).toBeOnTheScreen();
  expect(
    screen.getByText(
      'No scored drives over 4 weeks. Widen the period to see further back — driving less never lowers your score.'
    )
  ).toBeOnTheScreen();
  // §7.0 Empty: one sentence, not a breakdown of zeroes and a table of dashes.
  expect(screen.queryByTestId('breakdown')).toBeNull();
  expect(screen.queryByTestId('conditions')).toBeNull();
  // The trend, the highlights and the doors are still worth having.
  expect(screen.getByTestId('trend')).toBeOnTheScreen();
  expect(screen.getByTestId('highlights')).toBeOnTheScreen();
  expect(screen.getByTestId('insights-entries')).toBeOnTheScreen();

  // Widening the period brings them back.
  await press(screen.getByRole('radio', { name: 'All time' }));
  await flush();
  expect(screen.queryByTestId('quiet-period')).toBeNull();
  expect(screen.getByTestId('breakdown')).toBeOnTheScreen();
  expect(screen.getByTestId('conditions')).toBeOnTheScreen();
});

describe('without enough scored drives', () => {
  test('shows what is still needed instead of charts drawn from two drives', async () => {
    const w = await world(
      { trips: [drive('a', MON.jan12, 80), drive('b', MON.jan19, 90)] },
      now
    );
    await w.renderScreen(<Route />);

    expect(await screen.findByText('Building your score: 2 of 3 drives')).toBeOnTheScreen();
    expect(
      screen.getByText(
        'Insights start after 3 scored drives. Drive the way you normally would — there is no hurry, and nothing here rewards driving more.'
      )
    ).toBeOnTheScreen();
    expect(screen.getByRole('progressbar', { name: '2 of 3 scored drives' })).toBeOnTheScreen();

    // No period selector and no charts: there is nothing yet for either to be about.
    expect(screen.queryByTestId('period')).toBeNull();
    expect(screen.queryByTestId('trend')).toBeNull();
    // Never a dead end (§7.0): the explainer is still reachable.
    expect(screen.getByRole('button', { name: /^How scoring works/ })).toBeOnTheScreen();
  });

  test('a driver with no drives at all sees the same progress state, starting at zero', async () => {
    const w = await world({}, now);
    await w.renderScreen(<Route />);
    expect(await screen.findByText('Building your score: 0 of 3 drives')).toBeOnTheScreen();
  });
});

test('a passenger trip is never counted as one of the driver s drives', async () => {
  const w = await world(
    {
      trips: [
        drive('a', MON.jan5, 80, {}, { distance_m: 10 * MILE_M }),
        drive('p', MON.jan12, 90, {}, { role: 'passenger', score: null, status: 'unscored' }),
        drive('c', MON.jan19, 90),
      ],
    },
    now
  );
  await w.renderScreen(<Route />);
  expect(await screen.findByText('Building your score: 2 of 3 drives')).toBeOnTheScreen();
});

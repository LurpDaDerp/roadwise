import { screen, within } from '@testing-library/react-native';
import { useState } from 'react';
import { AccessibilityInfo } from 'react-native';

import { deductions, MILE_M, tripRow } from '@/data/queries/__fixtures__/rows';
import { CAMERA_MODE_SETTING_KEY, parseCategory } from '@/features/insights';
import {
  brokenDb,
  clearQueryClients,
  flush,
  press,
  routerDouble,
  world,
  type Seed,
} from '@/features/insights/__fixtures__/render';
import { CategoryScreen } from '@/features/insights/CategoryScreen';
import type { InsightsPeriod } from '@/features/insights/period';

const mockRouter = routerDouble();
jest.mock('expo-router', () => ({ useRouter: () => mockRouter }));

const NOW = Date.UTC(2026, 0, 26, 12);
const now = () => NOW;

const drive = (
  id: string,
  startedAt: number,
  lost: Parameters<typeof deductions>[0] = {},
  over: Parameters<typeof tripRow>[0] = {}
) =>
  tripRow({
    client_trip_id: id,
    started_at: startedAt,
    distance_m: 10 * MILE_M,
    duration_s: 1800,
    category_deductions_json: JSON.stringify(deductions(lost)),
    ...over,
  });

/** Three half-hour, ten-mile drives: 30 miles and an hour and a half of exposure in the window. */
const SPEEDING = [
  drive('a', Date.UTC(2026, 0, 5, 12), { speeding: 6 }),
  drive('b', Date.UTC(2026, 0, 12, 12), { speeding: 2 }),
  drive('c', Date.UTC(2026, 0, 19, 12)),
];

function Route({
  category,
  initial = '4w' as InsightsPeriod,
}: {
  category: string | undefined;
  initial?: InsightsPeriod;
}) {
  const [period, setPeriod] = useState<InsightsPeriod>(initial);
  // The route's own parse, so a hand-typed segment is exercised end to end.
  return <CategoryScreen category={parseCategory(category)} period={period} onPeriodChange={setPeriod} />;
}

/** Both of the screen's reads — the aggregate and the drive list — have landed. */
async function ready(): Promise<void> {
  await screen.findByTestId('category-screen');
  await flush();
}

async function open(seed: Seed, category: string | undefined) {
  const w = await world(seed, now);
  await w.renderScreen(<Route category={category} />);
  return w;
}

beforeEach(() => {
  mockRouter.push.mockClear();
  jest.spyOn(AccessibilityInfo, 'isReduceMotionEnabled').mockResolvedValue(true);
});

afterEach(clearQueryClients);

describe('a category that cost points', () => {
  test('prints the rate per 100 miles, per hour and the drives it touched', async () => {
    await open({ trips: SPEEDING }, 'speeding');
    await ready();

    expect(screen.getByRole('header', { name: 'Speeding' })).toBeOnTheScreen();
    // 8 points over 30 miles and an hour and a half, on two of the three drives.
    expect(screen.getByTestId('rate-per100Mi')).toHaveTextContent('26.7');
    expect(screen.getByTestId('rate-perHour')).toHaveTextContent('5.3');
    expect(screen.getByTestId('rate-drives')).toHaveTextContent('2 of 3');
  });

  test('the weekly trend and the time-of-day pattern each carry a summary and a table', async () => {
    await open({ trips: SPEEDING }, 'speeding');
    await ready();

    expect(screen.getByText('From 60 to 0 points per 100 miles over 4 weeks.')).toBeOnTheScreen();
    expect(
      screen.getByText('Afternoon drives lose the most to speeding: 26.7 points per 100 miles.')
    ).toBeOnTheScreen();
    expect(
      screen.getByText(
        'By when the drive started. Morning 5–11 AM · Afternoon 11 AM–5 PM · Evening 5–10 PM · Night 10 PM–5 AM.'
      )
    ).toBeOnTheScreen();

    await press(
      within(screen.getByTestId('time-of-day-chart')).getByRole('button', { name: 'Show as table' })
    );
    await flush();
    const table = within(screen.getByTestId('time-of-day-chart-table'));
    expect(table.getByLabelText('Afternoon, 26.7 points per 100 miles, 3 drives')).toBeOnTheScreen();
    expect(table.getByLabelText('Morning, no drives')).toBeOnTheScreen();
  });

  test('the drives it happened on are offered costliest first and open the card back', async () => {
    await open({ trips: SPEEDING }, 'speeding');
    await ready();

    const examples = within(screen.getByTestId('examples'));
    expect(examples.getByRole('button', { name: /6 points to speeding/ })).toBeOnTheScreen();
    expect(examples.getByRole('button', { name: /2 points to speeding/ })).toBeOnTheScreen();
    // The clean drive is not an example of speeding.
    expect(screen.queryByTestId('example-c')).toBeNull();

    await press(screen.getByTestId('example-a'));
    expect(mockRouter.push).toHaveBeenCalledWith({
      pathname: '/(app)/trips/[clientTripId]/summary',
      params: { clientTripId: 'a' },
    });
  });

  test('changing the period re-reads the category', async () => {
    await open({ trips: SPEEDING }, 'speeding');
    await ready();

    await press(screen.getByRole('radio', { name: 'All time' }));
    await flush();
    expect(screen.getByText('From 60 to 0 points per 100 miles since your first drive.')).toBeOnTheScreen();
  });
});

describe('a category that cost nothing', () => {
  test('is a celebration and how to keep it up, not an empty chart', async () => {
    await open({ trips: SPEEDING }, 'phone');
    await ready();

    expect(screen.getByTestId('category-clean')).toBeOnTheScreen();
    expect(screen.getByText('Nothing lost to phone use over 4 weeks')).toBeOnTheScreen();
    expect(screen.getByLabelText('Clean')).toBeOnTheScreen();
    expect(within(screen.getByTestId('tips')).getByText('How to keep it up')).toBeOnTheScreen();
    // Nothing to plot, so nothing is plotted.
    expect(screen.queryByTestId('category-trend')).toBeNull();
    expect(screen.queryByTestId('examples')).toBeNull();
  });
});

describe('the camera category', () => {
  test('explains itself when camera mode is off, and offers the way in rather than a nag', async () => {
    await open({ trips: SPEEDING }, 'focus');
    await ready();

    expect(screen.getByTestId('camera-explainer')).toBeOnTheScreen();
    expect(
      screen.getByRole('header', { name: 'Focus and alertness is a camera-mode category' })
    ).toBeOnTheScreen();
    expect(
      screen.getByText(
        'Camera mode is optional, runs only on your phone, stores and sends nothing, and is never needed for rewards.'
      )
    ).toBeOnTheScreen();

    // Nothing was watched, so nothing is claimed: no rates, and no "clean" stamp either.
    expect(screen.queryByTestId('rates')).toBeNull();
    expect(screen.queryByTestId('category-clean')).toBeNull();
    // Still useful: the two tips for the behaviour are here.
    expect(screen.getByTestId('tips')).toBeOnTheScreen();
  });

  test('with camera mode on but no camera drive, it still claims nothing', async () => {
    await open({ trips: SPEEDING, settings: [[CAMERA_MODE_SETTING_KEY, true]] }, 'focus');
    await ready();

    expect(screen.queryByTestId('camera-explainer')).toBeNull();
    expect(screen.queryByTestId('category-clean')).toBeNull();
    expect(screen.getByTestId('tips')).toBeOnTheScreen();
  });

  test('with camera mode on and a camera drive, it reads like any other category', async () => {
    await open(
      {
        trips: [
          drive('cam', Date.UTC(2026, 0, 19, 12), { focus: 4 }, { camera_session: 1 }),
          ...SPEEDING,
        ],
        settings: [[CAMERA_MODE_SETTING_KEY, true]],
      },
      'focus'
    );
    await ready();

    expect(screen.queryByTestId('camera-explainer')).toBeNull();
    expect(screen.getByTestId('rates')).toBeOnTheScreen();
    expect(screen.getByTestId('rate-drives')).toHaveTextContent('1 of 4');
  });
});

describe('the edges', () => {
  test('a route segment that is not a category is an empty state, not a crash', async () => {
    await open({ trips: SPEEDING }, 'driving');
    expect(await screen.findByText("That isn't a category we score")).toBeOnTheScreen();
    expect(screen.getByText('Pick one from the overview.')).toBeOnTheScreen();
  });

  test('a database that cannot be read says so in place and offers a retry', async () => {
    const w = await world({}, now);
    await w.renderScreen(<Route category="speeding" />, brokenDb());
    expect(await screen.findByText("Couldn't read your drives.")).toBeOnTheScreen();
    expect(screen.getByRole('button', { name: 'Try again' })).toBeOnTheScreen();
  });
});

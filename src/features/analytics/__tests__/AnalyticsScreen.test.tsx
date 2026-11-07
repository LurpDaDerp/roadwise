import { act, screen, waitFor, within } from '@testing-library/react-native';
import { Component, type ComponentType, type ReactNode } from 'react';
import { View } from 'react-native';
import type { ReactTestInstance } from 'react-test-renderer';

import { draw, EXPOSURE, press, ROUTE } from '@/features/drives/__fixtures__/drives';
import { driveSummaryHref } from '@/features/drives/routes';
import { setMapsForTests, type MapsModule } from '@/features/settings/maps';
import { SETTINGS_HREFS } from '@/features/settings/routes';
import { ThemeProvider } from '@/ui/theme';

import { analytics as mockAnalytics, drives as mockDrives, empty as mockEmpty, SCORES_RATING } from '../__fixtures__/analytics';
import { AnalyticsScreen } from '../AnalyticsScreen';
import type { CommuteRow } from '../commuteModel';
import type { AnalyticsData } from '../useAnalytics';

const mockRouter = { push: jest.fn(), navigate: jest.fn() };
// The tab's focus: the screen subscribes on mount (its first focus); `mockFocus()` focuses it again.
let mockFocus: () => void = () => undefined;
jest.mock('expo-router', () => {
  const { useEffect } = jest.requireActual<typeof import('react')>('react');
  return {
    useRouter: () => mockRouter,
    useFocusEffect: (cb: () => void) => {
      mockFocus = cb;
      useEffect(cb, [cb]);
    },
  };
});

// The problem spots: the data layer's view, and the spots package's card and sheet (their own tests cover them).
// On the fixture drives' route (it runs north), heading its way: a spot on the commute's way too.
const SPOT = { id: 's1', kind: 'speeding', state: 'active', lastHitTrip: 'd5', pin: ROUTE[10], headingDeg: 0, label: 'Main St', recentHits: 2, recentPasses: 5 };
let mockSpots: unknown = { computed: true, eligible: true, active: [SPOT], clearedRecently: 0 };
jest.mock('@/data/queries/spots', () => ({ useSpots: () => ({ data: mockSpots, isLoading: false, isError: false }) }));
// This month's passenger rides: the server's count (its hook has its own tests).
let mockPassengerRides: unknown = undefined;
jest.mock('@/data/server/passengerRides', () => ({
  usePassengerRides: () => ({ data: mockPassengerRides }),
  passengerRidesShown: (q: { data?: { this_month: number } }) => (q.data && q.data.this_month > 0 ? q.data.this_month : null),
}));
jest.mock('../spots', () => {
  const { Pressable, Text, View } = jest.requireActual<typeof import('react-native')>('react-native');
  return {
    SpotsCard: ({ view, onOpen }: { view: { active: { id: string }[] } | null; onOpen: (id: string) => void }) =>
      view ? (
        <View testID="analytics-spots">
          {view.active.map((s) => (
            <Pressable key={s.id} testID={`spot-row-${s.id}`} onPress={() => onOpen(s.id)}>
              <Text>Spot</Text>
            </Pressable>
          ))}
        </View>
      ) : null,
    SpotSheet: ({ spot, visible, onOpenDrive }: { spot: { id: string; lastHitTrip: string } | null; visible: boolean; onOpenDrive: (id: string) => void }) =>
      visible && spot ? (
        <View testID="spot-sheet">
          <Text>{spot.id}</Text>
          <Pressable testID="spot-open-drive" onPress={() => onOpenDrive(spot.lastHitTrip)}>
            <Text>Open drive</Text>
          </Pressable>
        </View>
      ) : null,
  };
});

type MockRange = 'day' | 'week' | 'month' | 'year';
// Ten drives, one every 30 hours: 6 in the last week, all 10 in the last month, each watched for
// phone pickups for 20 minutes at driving speed; every other one in the rain (60 mi wet, 60 mi dry).
const mockList = () => mockDrives(10, 30, { exposure: { ...EXPOSURE, phoneS: 1200 } }).map((d, i) => ({ ...d, weather: i % 2 === 1 ? ('rain' as const) : ('clear' as const) }));
let mockData: (range: MockRange) => AnalyticsData = (range) => mockAnalytics(mockList(), range);
const mockUseAnalytics = jest.fn((range: MockRange) => mockData(range));
jest.mock('../useAnalytics', () => ({ useAnalytics: (range: MockRange) => mockUseAnalytics(range) }));
// The commute legs (the hook's own test reads them from a database): one leg, Home → School, over
// the fixture's first four drives (they run Home to School).
const mockLeg = (over: Partial<CommuteRow> = {}): CommuteRow => ({
  id: 'home-school',
  from: { id: 'home', kind: 'home', name: 'Home', lat: 40.7, lng: -74 },
  to: { id: 'school', kind: 'school', name: 'School', lat: 40.758, lng: -74 },
  drives: mockList().slice(0, 4),
  usualS: 24 * 60,
  departure: { minuteOfDay: 7 * 60 + 40, drives: 4 },
  score: 84,
  change: null,
  scored: 4,
  ...over,
});
let mockCommute: CommuteRow[] = [mockLeg()];
const mockUseCommute = jest.fn((_drives: unknown) => mockCommute);
jest.mock('../useCommute', () => ({ useCommute: (drives: unknown) => mockUseCommute(drives) }));

beforeEach(() => {
  jest.clearAllMocks();
  mockSpots = { computed: true, eligible: true, active: [SPOT], clearedRecently: 0 };
  mockData = (range) => mockAnalytics(mockList(), range);
  mockCommute = [mockLeg()];
});

/** The fixture's analytics with this 90-day rating. */
const withRating = (rating: number | null, ranked: boolean) => (range: MockRange) => {
  const base = mockAnalytics(mockList(), range);
  return { ...base, coaching: { ...base.coaching, rating: { rating, ranked } } };
};

const SECTIONS = [
  'analytics-radar',
  'analytics-summary',
  'analytics-all-time',
  'analytics-metrics',
  'analytics-range',
  'analytics-grid',
  'analytics-time-of-day',
  'analytics-weather',
  'analytics-map',
  'analytics-spots',
  'analytics-commute',
  'analytics-drives',
];

/** Section testIDs in the order they are drawn. */
function order(): string[] {
  const out: string[] = [];
  const walk = (n: ReactTestInstance | string) => {
    if (typeof n === 'string') return;
    const id = n.props.testID as unknown;
    if (typeof id === 'string' && SECTIONS.includes(id) && !out.includes(id)) out.push(id);
    n.children.forEach(walk);
  };
  walk(screen.root as unknown as ReactTestInstance);
  return out;
}

test('top to bottom: radar, summary, all time, the range group (its toggle at the top), when you drive, time of day, weather, map, spots to watch, your commute, drives', async () => {
  await draw(<AnalyticsScreen />);
  expect(screen.getByRole('header', { name: 'Analytics' })).toBeOnTheScreen();
  expect(order()).toEqual(SECTIONS);
});

test('your commute reads the tab’s drives, and is gone with no leg to show', async () => {
  await draw(<AnalyticsScreen />);
  expect(mockUseCommute).toHaveBeenCalledWith(mockUseAnalytics.mock.results.at(-1)!.value.drives);
  expect(within(screen.getByTestId('analytics-commute')).getByText('Home → School')).toBeOnTheScreen();
  mockCommute = [];
  await draw(<AnalyticsScreen />);
  expect(screen.queryByTestId('analytics-commute')).toBeNull();
  expect(order()).toEqual(SECTIONS.filter((id) => id !== 'analytics-commute'));
});

test('a commute leg opens its sheet; a drive there closes it and opens the drive', async () => {
  await draw(<AnalyticsScreen />);
  expect(screen.queryByTestId('commute-sheet')).toBeNull();
  await press(screen.getByTestId('analytics-commute-home-school'));
  const sheet = screen.getByTestId('commute-sheet');
  expect(within(sheet).getByRole('header', { name: 'Home → School' })).toBeOnTheScreen();
  await press(within(sheet).getByTestId('commute-drive-d1'));
  expect(mockRouter.push).toHaveBeenCalledWith(driveSummaryHref('d1'));
  await waitFor(() => expect(screen.queryByTestId('commute-sheet')).toBeNull());
});

test('a spot on the commute’s way opens its own sheet once the commute’s has gone', async () => {
  await draw(<AnalyticsScreen />);
  await press(screen.getByTestId('analytics-commute-home-school'));
  await press(within(screen.getByTestId('commute-sheet')).getByTestId('commute-spot-s1'));
  // One sheet at a time: the spot's waits for the commute's to leave.
  expect(screen.queryByTestId('spot-sheet')).toBeNull();
  await waitFor(() => expect(screen.queryByTestId('commute-sheet')).toBeNull());
  await waitFor(() => expect(screen.getByTestId('spot-sheet')).toBeOnTheScreen(), { timeout: 3000 });
  await press(screen.getByTestId('spot-open-drive'));
  expect(mockRouter.push).toHaveBeenCalledWith(driveSummaryHref('d5'));
});

test('closing the commute sheet opens no spot sheet', async () => {
  await draw(<AnalyticsScreen />);
  await press(screen.getByTestId('analytics-commute-home-school'));
  await press(within(screen.getByTestId('commute-sheet')).getAllByRole('button', { name: 'Close' }).at(-1)!);
  await waitFor(() => expect(screen.queryByTestId('commute-sheet')).toBeNull());
  await act(async () => new Promise((resolve) => setTimeout(resolve, 900)));
  expect(screen.queryByTestId('spot-sheet')).toBeNull();
});

test('a commute leg that leaves the card closes its sheet', async () => {
  const view = await draw(<AnalyticsScreen />);
  await press(screen.getByTestId('analytics-commute-home-school'));
  expect(screen.getByTestId('commute-sheet')).toBeOnTheScreen();
  mockCommute = [];
  await view.rerender(
    <ThemeProvider scheme="light" reduceMotion>
      <AnalyticsScreen />
    </ThemeProvider>
  );
  await waitFor(() => expect(screen.queryByTestId('commute-sheet')).toBeNull());
});

test('a commute leg that leaves the card and comes back does not open its sheet by itself', async () => {
  const view = await draw(<AnalyticsScreen />);
  const redraw = () =>
    view.rerender(
      <ThemeProvider scheme="light" reduceMotion>
        <AnalyticsScreen />
      </ThemeProvider>
    );
  await press(screen.getByTestId('analytics-commute-home-school'));
  expect(screen.getByTestId('commute-sheet')).toBeOnTheScreen();
  mockCommute = [];
  await redraw();
  await waitFor(() => expect(screen.queryByTestId('commute-sheet')).toBeNull());
  // Past the sheet's dismissal, the leg qualifies again (a new drive kept, the places back).
  await act(async () => new Promise((resolve) => setTimeout(resolve, 900)));
  mockCommute = [mockLeg()];
  await redraw();
  expect(screen.getByTestId('analytics-commute-home-school')).toBeOnTheScreen();
  expect(screen.queryByTestId('commute-sheet')).toBeNull();
  // A tap still opens it.
  await press(screen.getByTestId('analytics-commute-home-school'));
  expect(screen.getByTestId('commute-sheet')).toBeOnTheScreen();
});

test('the month’s passenger rides show under the drives’ header when there are any, and nothing when none', async () => {
  mockPassengerRides = { this_month: 4 };
  await draw(<AnalyticsScreen />);
  expect(within(screen.getByTestId('analytics-drives')).getByTestId('analytics-passenger-rides')).toHaveTextContent('4 passenger rides this month');
  mockPassengerRides = { this_month: 0 };
  await draw(<AnalyticsScreen />);
  expect(screen.queryByTestId('analytics-passenger-rides')).toBeNull();
  mockPassengerRides = undefined;
});

test('the radar centre is the 90-day Safety Rating of the categories around it, whole and bold', async () => {
  await draw(<AnalyticsScreen />);
  // The fixture's axes average to 87.6 (Speed and Phone use double).
  expect(SCORES_RATING).toBe(87.6);
  expect(screen.getByTestId('radar-rating')).toHaveTextContent('88');
  mockData = withRating(91.5, true);
  await draw(<AnalyticsScreen />);
  expect(screen.getByTestId('radar-rating')).toHaveTextContent('92');
});

test('no Safety Rating yet: a dash', async () => {
  mockData = withRating(null, false);
  await draw(<AnalyticsScreen />);
  expect(screen.getByTestId('radar-rating')).toHaveTextContent('—');
});

test('unranked (under 10 mi): a dash, as on Home and Profile', async () => {
  mockData = withRating(88, false);
  await draw(<AnalyticsScreen />);
  expect(screen.getByTestId('radar-rating')).toHaveTextContent('—');
});

test('the problem spots sit on the map and in their own card; a spot opens its sheet, whose drive link closes it and opens the drive', async () => {
  await draw(<AnalyticsScreen />);
  expect(screen.queryByTestId('spot-sheet')).toBeNull();
  await press(screen.getByTestId('spot-row-s1'));
  expect(screen.getByTestId('spot-sheet')).toBeOnTheScreen();
  await press(screen.getByTestId('spot-open-drive'));
  expect(mockRouter.push).toHaveBeenCalledWith(driveSummaryHref('d5'));
  expect(screen.queryByTestId('spot-sheet')).toBeNull();
});

test('a spot that leaves the list closes its sheet', async () => {
  const view = await draw(<AnalyticsScreen />);
  await press(screen.getByTestId('spot-row-s1'));
  expect(screen.getByTestId('spot-sheet')).toBeOnTheScreen();
  mockSpots = { computed: true, eligible: true, active: [], clearedRecently: 1 };
  await view.rerender(
    <ThemeProvider scheme="light" reduceMotion>
      <AnalyticsScreen />
    </ThemeProvider>
  );
  expect(screen.queryByTestId('spot-sheet')).toBeNull();
});

test('the range starts on Week and moves only the Driving and Trends cards in its group', async () => {
  await draw(<AnalyticsScreen />);
  expect(mockUseAnalytics).toHaveBeenLastCalledWith('week');
  expect(screen.getByRole('tab', { name: 'Week' })).toBeSelected();
  expect(screen.getByTestId('metric-drives-value')).toHaveTextContent('6');
  // Below the group everything is all time: all ten drives.
  expect(screen.getByTestId('analytics-drives-toggle')).toHaveAccessibleName('Drives, 10');
  const grid = screen.getByTestId('analytics-grid');
  const gridLabel = within(grid).getByRole('image').props.accessibilityLabel as string;
  expect(gridLabel).toMatch(/^When you drive\. 10 drives\./);
  const comment = screen.getByTestId('analytics-time-of-day-text').props.children as string;

  await press(screen.getByRole('tab', { name: 'Month' }));
  expect(mockUseAnalytics).toHaveBeenLastCalledWith('month');
  expect(screen.getByRole('tab', { name: 'Month' })).toBeSelected();
  expect(screen.getByTestId('metric-drives-value')).toHaveTextContent('10');
  expect(screen.getByTestId('analytics-drives-toggle')).toHaveAccessibleName('Drives, 10');
  expect(within(screen.getByTestId('analytics-grid')).getByRole('image').props.accessibilityLabel).toBe(gridLabel);
  expect(screen.getByTestId('analytics-time-of-day-text').props.children).toBe(comment);

  await press(screen.getByRole('tab', { name: 'Day' }));
  expect(screen.getByTestId('metric-drives-value')).toHaveTextContent('1');
  expect(screen.getByTestId('analytics-drives-toggle')).toHaveAccessibleName('Drives, 10');
  // The toggle says what it changes, and sits inside the group with the two cards.
  const group = screen.getByTestId('analytics-metrics');
  expect(within(group).getByLabelText('Time range, for Driving and Trends')).toBeOnTheScreen();
  for (const r of ['Day', 'Week', 'Month', 'Year']) expect(within(group).getByRole('tab', { name: r })).toBeOnTheScreen();
  for (const id of ['analytics-all-time', 'analytics-grid', 'analytics-time-of-day', 'analytics-map', 'analytics-drives']) {
    expect(within(group).queryByTestId(id)).toBeNull();
  }
});

test('the group holds Driving then Trends, which carries the range’s clean share and follows the range', async () => {
  await draw(<AnalyticsScreen />);
  const cards = within(screen.getByTestId('analytics-metrics')).getAllByTestId(/^metrics-[a-z]+$/);
  expect(cards.map((c) => c.props.testID)).toEqual(['metrics-driving', 'metrics-trend']);
  expect(screen.getByTestId('metrics-trend-clean')).toHaveTextContent('0% clean drives');
  expect(screen.getByTestId('metrics-trend-title')).toHaveTextContent('Trends');
  expect(screen.getByRole('tab', { name: 'Score' })).toBeSelected();
  // Six drives 30 hours apart in the week: the Safety Rating by day.
  expect(screen.getByTestId('trend-chart-box').props.accessibilityLabel).toMatch(/^Safety Rating by day\. /);
  await press(screen.getByRole('tab', { name: 'Month' }));
  expect(screen.getByTestId('trend-chart-box').props.accessibilityLabel).toMatch(/^Safety Rating by week\. /);
  await press(screen.getByRole('tab', { name: 'Events' }));
  expect(screen.getByTestId('trend-chart-box').props.accessibilityLabel).toMatch(/^Events per mile by week\. /);
  expect(screen.queryByRole('tab', { name: 'Points' })).toBeNull();
});

test('the page keeps only general numbers: no category counts, rates or bests, and no points anywhere', async () => {
  await draw(<AnalyticsScreen />);
  for (const key of ['speeding', 'brakes', 'starts', 'turns', 'slowdowns', 'after-dark', 'dark-share', 'points', 'avg-points']) {
    expect(screen.queryByTestId(`metric-${key}`)).toBeNull();
    expect(screen.queryByTestId(`metric-${key}-rate`)).toBeNull();
  }
  expect(screen.queryByTestId('best-points')).toBeNull();
  // Clean drives belong to no radar category, so they stay on the page: the all-time count and
  // longest, and the range's share in Trends. The Clean driving card is gone.
  expect(screen.getByTestId('all-time-clean-drives')).toBeOnTheScreen();
  expect(screen.getByTestId('all-time-longest-clean')).toBeOnTheScreen();
  expect(screen.getByTestId('metrics-trend-clean')).toBeOnTheScreen();
  expect(screen.queryByTestId('metrics-clean')).toBeNull();
  for (const key of ['clean', 'clean-rate', 'pickups', 'in-hand']) expect(screen.queryByTestId(`metric-${key}`)).toBeNull();
  expect(screen.queryByTestId('category-sheet')).toBeNull();
  expect(screen.queryByText(/\bpoints?\b|\bpts\b/i)).toBeNull();
  // The radar's per-category numbers are its scores, nothing else.
  const chips = within(screen.getByTestId('analytics-radar')).getAllByTestId(/^radar-axis-/);
  expect(chips).toHaveLength(6);
  for (const el of chips) expect(el.props.accessibilityLabel).toMatch(/^[A-Za-z ]+, (score \d+|no score yet|needs DashPal)$/);
  // Its one other button explains the total, with no number.
  expect(within(screen.getByTestId('analytics-radar')).getAllByRole('button').map((el) => el.props.accessibilityLabel)).toContain('How it works');
});

test.each([
  ['speed', 'Speed · 88', ['metric-speeding', 'metric-over-limit', 'metric-with-limit']],
  ['braking', 'Braking · 72', ['metric-brakes', 'metric-slowdowns']],
  ['acceleration', 'Acceleration · 95', ['metric-starts', 'metric-speedups']],
  ['turning', 'Turning · 100', ['metric-sharp-turns', 'metric-turns']],
  ['phone', 'Phone use · 84', ['metric-phone-pickups', 'metric-phone-in-hand']],
] as const)('tapping %s on the radar opens its details, which close again', async (axis, title, cells) => {
  await draw(<AnalyticsScreen />);
  await press(screen.getByTestId(`radar-axis-${axis}`));
  const sheet = screen.getByTestId('category-sheet');
  expect(within(sheet).getByRole('header', { name: title })).toBeOnTheScreen();
  expect(within(sheet).getByTestId('category-coaching')).toBeOnTheScreen();
  for (const id of cells) expect(within(sheet).getByTestId(id)).toBeOnTheScreen();
  expect(within(sheet).getByTestId('category-rate')).toBeOnTheScreen();
  expect(within(sheet).queryByTestId('category-best')).toBeNull();
  expect(within(sheet).queryByText(/pts|points/i)).toBeNull();
  await press(within(sheet).getAllByRole('button', { name: 'Close' }).at(-1)!);
  await waitFor(() => expect(screen.queryByTestId('category-sheet')).toBeNull());
});

test('with no drives at all, every category still opens: "No data yet"', async () => {
  mockData = () => mockEmpty();
  await draw(<AnalyticsScreen />);
  expect(screen.getByTestId('radar-rating')).toHaveTextContent('—');
  for (const axis of ['acceleration', 'braking', 'turning', 'phone', 'speed']) {
    await press(screen.getByTestId(`radar-axis-${axis}`));
    const sheet = screen.getByTestId('category-sheet');
    expect(within(sheet).getByText('No data yet')).toBeOnTheScreen();
    await press(within(sheet).getAllByRole('button', { name: 'Close' }).at(-1)!);
    await waitFor(() => expect(screen.queryByTestId('category-sheet')).toBeNull());
  }
});

test('with no DashPal paired, Attention is locked: its sheet says so and opens DashPal setup', async () => {
  await draw(<AnalyticsScreen />);
  expect(screen.getByTestId('radar-lock-attention')).toBeOnTheScreen();
  await press(screen.getByTestId('radar-axis-attention'));
  const sheet = screen.getByTestId('category-sheet');
  expect(within(sheet).getByText('Attention comes from DashPal')).toBeOnTheScreen();
  await press(within(sheet).getByRole('button', { name: 'Set up DashPal' }));
  expect(mockRouter.push).toHaveBeenCalledWith(SETTINGS_HREFS.dashcam);
  await waitFor(() => expect(screen.queryByTestId('category-sheet')).toBeNull());
});

test('the time-of-day card comments on when the drives start and scores nothing', async () => {
  await draw(<AnalyticsScreen />);
  const card = screen.getByTestId('analytics-time-of-day');
  expect(within(card).getByText('Time of day')).toBeOnTheScreen();
  expect(within(card).getByTestId('analytics-time-of-day-text').props.children).toMatch(/\.$/);
  expect(within(card).queryByText(/pts|points|score/i)).toBeNull();
});

test('the weather card: all time, rain against the dry, gone without enough of both', async () => {
  await draw(<AnalyticsScreen />);
  const card = screen.getByTestId('analytics-weather');
  expect(within(card).getByText('Weather')).toBeOnTheScreen();
  // A hard brake on every drive, rain or dry: as smooth in both.
  expect(within(card).getByTestId('analytics-weather-text')).toHaveTextContent('You drive as smoothly in rain or snow as in the dry. Nice.');
  expect(within(card).getByTestId('analytics-weather-detail')).toHaveTextContent('5 drives in rain or snow · 60 mi');
  // The range never moves it.
  await press(screen.getByRole('tab', { name: 'Day' }));
  expect(screen.getByTestId('analytics-weather-detail')).toHaveTextContent('5 drives in rain or snow · 60 mi');
  mockData = (range) => mockAnalytics(mockDrives(10, 30), range);
  await draw(<AnalyticsScreen />);
  expect(screen.queryByTestId('analytics-weather')).toBeNull();
});

test("Speed's sheet says where the speeding happens and Phone use's when the pickups do, from the page's data", async () => {
  mockData = (range) => ({
    ...mockAnalytics(mockList(), range),
    roads: { speedingS: 60, speeding: { low: 0, mid: 15, high: 45 }, driving: null },
    pickupTiming: { pickups: 3, speed: { low: 0, mid: 1, high: 2 }, moment: { first: 0, middle: 1, last: 2 }, bands: [0, 0, 1, 0, 0, 2, 0, 0] },
  });
  await draw(<AnalyticsScreen />);
  await press(screen.getByTestId('radar-axis-speed'));
  let sheet = screen.getByTestId('category-sheet');
  expect(within(sheet).getByTestId('category-roads-headline')).toHaveTextContent('Most of your speeding is on highways.');
  expect(within(sheet).queryByTestId('category-pickups')).toBeNull();
  await press(within(sheet).getAllByRole('button', { name: 'Close' }).at(-1)!);
  await waitFor(() => expect(screen.queryByTestId('category-sheet')).toBeNull());
  await press(screen.getByTestId('radar-axis-phone'));
  sheet = screen.getByTestId('category-sheet');
  expect(within(sheet).getByTestId('category-pickups-headline')).toHaveTextContent('Most of your pickups happen near the end of a drive. The message can wait until you park.');
  expect(within(sheet).queryByTestId('category-roads')).toBeNull();
});

test("the sheet's range is the page's: switching it there re-reads the page too", async () => {
  await draw(<AnalyticsScreen />);
  await press(screen.getByTestId('radar-axis-braking'));
  const sheet = screen.getByTestId('category-sheet');
  // Six drives in the week, a hard brake each, 30 slowdowns each.
  expect(within(sheet).getByTestId('metric-brakes-value')).toHaveTextContent('6');
  expect(within(sheet).getByTestId('metric-slowdowns-value')).toHaveTextContent('180');
  expect(within(sheet).getByTestId('category-rate')).toHaveTextContent('1 hard brake per 30 slowdowns');
  await press(within(sheet).getByRole('tab', { name: 'Month' }));
  expect(mockUseAnalytics).toHaveBeenLastCalledWith('month');
  expect(within(screen.getByTestId('category-sheet')).getByTestId('metric-brakes-value')).toHaveTextContent('10');
  expect(within(screen.getByTestId('category-sheet')).getByTestId('metrics-braking-title')).toHaveTextContent('Last 30 days');
  expect(screen.getByTestId('metric-drives-value')).toHaveTextContent('10');
});

test('a drive in the list opens its summary page', async () => {
  await draw(<AnalyticsScreen />);
  await press(screen.getByTestId('analytics-drives-toggle'));
  await press(screen.getByTestId('analytics-drive-d2'));
  expect(mockRouter.push).toHaveBeenCalledWith(driveSummaryHref('d2'));
});

test('the All time card: the clean drives over every drive, and the longest clean one opens its drive', async () => {
  mockData = (range) => mockAnalytics([...mockDrives(3, 30, { clean: true }), ...mockDrives(2, 30, { clientTripId: 'rough' })], range);
  await draw(<AnalyticsScreen />);
  const card = screen.getByTestId('analytics-all-time');
  expect(within(card).getByRole('header', { name: 'All time' })).toBeOnTheScreen();
  expect(within(card).getByTestId('all-time-clean-drives-value')).toHaveTextContent('3');
  await press(screen.getByRole('tab', { name: 'Day' }));
  expect(within(screen.getByTestId('analytics-all-time')).getByTestId('all-time-clean-drives-value')).toHaveTextContent('3');
  await press(screen.getByTestId('all-time-longest-clean'));
  expect(mockRouter.push).toHaveBeenCalledWith(driveSummaryHref('d0'));
});

test('a new driver sees short empty states, not errors', async () => {
  mockData = () => mockEmpty();
  await draw(<AnalyticsScreen />);
  expect(screen.getByText('Tips are on the way')).toBeOnTheScreen();
  expect(screen.getByTestId('analytics-grid-empty')).toHaveTextContent('No drives yet');
  expect(screen.getByTestId('trips-map-empty')).toHaveTextContent('No trips yet');
  expect(screen.getByTestId('analytics-drives-empty')).toHaveTextContent('No drives yet');
  expect(screen.queryByRole('alert')).toBeNull();
});

test('first load shows a placeholder; a failed read says so in one line', async () => {
  mockData = () => mockEmpty({ loading: true });
  await draw(<AnalyticsScreen />);
  expect(screen.getByTestId('analytics-loading', { includeHiddenElements: true })).toBeOnTheScreen();
  expect(screen.queryByTestId('analytics-radar')).toBeNull();

  mockData = (range) => mockAnalytics(mockDrives(3), range, { error: true });
  await draw(<AnalyticsScreen />);
  expect(screen.getByText("Couldn't load your drives.")).toBeOnTheScreen();
  expect(screen.getByTestId('analytics-radar')).toBeOnTheScreen();
});

test('each time the tab gains focus again the All trips map goes back to the view framing every route', async () => {
  const animateToRegion = jest.fn();
  class MapView extends Component<{ children?: ReactNode }> {
    animateToRegion = animateToRegion;
    render() {
      return <View testID="map-view">{this.props.children}</View>;
    }
  }
  setMapsForTests({ default: MapView as unknown as ComponentType, Polyline: View, Marker: View } as unknown as MapsModule);
  // The mocked spots carry no road to draw; this test is about the map's view.
  mockSpots = null;
  try {
    await draw(<AnalyticsScreen />);
    // The first focus leaves the map on the view it opens on.
    expect(screen.getByTestId('trips-map', { includeHiddenElements: true })).toBeOnTheScreen();
    expect(animateToRegion).not.toHaveBeenCalled();
    const { region } = mockAnalytics(mockList(), 'week');
    // A switch back to the tab: back to the framing view (the test theme's Reduce Motion jumps).
    await act(async () => mockFocus());
    expect(animateToRegion).toHaveBeenCalledTimes(1);
    expect(animateToRegion).toHaveBeenCalledWith(region, 0);
    await act(async () => mockFocus());
    expect(animateToRegion).toHaveBeenCalledTimes(2);
  } finally {
    setMapsForTests(undefined);
  }
});

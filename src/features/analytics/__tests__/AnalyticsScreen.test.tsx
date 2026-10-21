import { screen, waitFor, within } from '@testing-library/react-native';
import type { ReactTestInstance } from 'react-test-renderer';

import { draw, EXPOSURE, press } from '@/features/drives/__fixtures__/drives';
import { driveSummaryHref } from '@/features/drives/routes';
import { SETTINGS_HREFS } from '@/features/settings/routes';
import { ThemeProvider } from '@/ui/theme';

import { analytics as mockAnalytics, drives as mockDrives, empty as mockEmpty, SCORES_RATING } from '../__fixtures__/analytics';
import { AnalyticsScreen } from '../AnalyticsScreen';
import type { AnalyticsData } from '../useAnalytics';

const mockRouter = { push: jest.fn(), navigate: jest.fn() };
jest.mock('expo-router', () => ({ useRouter: () => mockRouter }));

// The problem spots: the data layer's view, and the spots package's card and sheet (their own tests cover them).
const SPOT = { id: 's1', kind: 'speeding', state: 'active', lastHitTrip: 'd5' };
let mockSpots: unknown = { computed: true, eligible: true, active: [SPOT], clearedRecently: 0 };
jest.mock('@/data/queries/spots', () => ({ useSpots: () => ({ data: mockSpots, isLoading: false, isError: false }) }));
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
// phone pickups for 20 minutes at driving speed.
const mockList = () => mockDrives(10, 30, { exposure: { ...EXPOSURE, phoneS: 1200 } });
let mockData: (range: MockRange) => AnalyticsData = (range) => mockAnalytics(mockList(), range);
const mockUseAnalytics = jest.fn((range: MockRange) => mockData(range));
jest.mock('../useAnalytics', () => ({ useAnalytics: (range: MockRange) => mockUseAnalytics(range) }));

beforeEach(() => {
  jest.clearAllMocks();
  mockSpots = { computed: true, eligible: true, active: [SPOT], clearedRecently: 0 };
  mockData = (range) => mockAnalytics(mockList(), range);
});

/** The fixture's analytics with this 90-day rating. */
const withRating = (rating: number | null, ranked: boolean) => (range: MockRange) => {
  const base = mockAnalytics(mockList(), range);
  return { ...base, coaching: { ...base.coaching, rating: { rating, ranked } } };
};

const SECTIONS = [
  'analytics-radar',
  'analytics-summary',
  'analytics-bests',
  'analytics-range',
  'analytics-metrics',
  'analytics-grid',
  'analytics-time-of-day',
  'analytics-map',
  'analytics-spots',
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

test('top to bottom: radar, summary, bests, range, metrics, when you drive, time of day, map, spots to watch, drives', async () => {
  await draw(<AnalyticsScreen />);
  expect(screen.getByRole('header', { name: 'Analytics' })).toBeOnTheScreen();
  expect(order()).toEqual(SECTIONS);
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

test('the range starts on Week and switching it re-reads everything below it', async () => {
  await draw(<AnalyticsScreen />);
  expect(mockUseAnalytics).toHaveBeenLastCalledWith('week');
  expect(screen.getByRole('tab', { name: 'Week' })).toBeSelected();
  expect(screen.getByTestId('metric-drives-value')).toHaveTextContent('6');
  expect(screen.getByTestId('analytics-drives-toggle')).toHaveAccessibleName('Drives, 6');

  await press(screen.getByRole('tab', { name: 'Month' }));
  expect(mockUseAnalytics).toHaveBeenLastCalledWith('month');
  expect(screen.getByRole('tab', { name: 'Month' })).toBeSelected();
  expect(screen.getByTestId('metric-drives-value')).toHaveTextContent('10');
  expect(screen.getByTestId('analytics-drives-toggle')).toHaveAccessibleName('Drives, 10');
  expect(screen.getByLabelText('Time range')).toBeOnTheScreen();
  for (const r of ['Day', 'Week', 'Month', 'Year']) expect(screen.getByRole('tab', { name: r })).toBeOnTheScreen();
});

test('the trend card sits between Driving and Clean driving and follows the range', async () => {
  await draw(<AnalyticsScreen />);
  const cards = within(screen.getByTestId('analytics-metrics')).getAllByTestId(/^metrics-[a-z]+$/);
  expect(cards.map((c) => c.props.testID)).toEqual(['metrics-driving', 'metrics-trend', 'metrics-clean']);
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
  // Clean drives belong to no radar category, so they stay on the page.
  expect(screen.getByTestId('metric-clean')).toBeOnTheScreen();
  expect(screen.getByTestId('metric-clean-rate')).toBeOnTheScreen();
  expect(screen.getByTestId('best-clean')).toBeOnTheScreen();
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

test('the personal best, the longest clean drive, opens its drive', async () => {
  mockData = (range) => mockAnalytics(mockDrives(3, 30, { clean: true }), range);
  await draw(<AnalyticsScreen />);
  await press(screen.getByTestId('best-clean'));
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

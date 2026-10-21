import { screen, waitFor, within } from '@testing-library/react-native';
import type { ReactTestInstance } from 'react-test-renderer';

import { draw, press, summary as mockSummary } from '@/features/drives/__fixtures__/drives';
import { driveSummaryHref } from '@/features/drives/routes';
import { SETTINGS_HREFS } from '@/features/settings/routes';

import { analytics as mockAnalytics, drives as mockDrives, empty as mockEmpty } from '../__fixtures__/analytics';
import { AnalyticsScreen } from '../AnalyticsScreen';
import type { AnalyticsData } from '../useAnalytics';

const mockRouter = { push: jest.fn(), navigate: jest.fn() };
jest.mock('expo-router', () => ({ useRouter: () => mockRouter }));

let mockRating: number | null = 92.4;
let mockRanked = true;
jest.mock('@/data/server/summary', () => ({
  useMySummary: () => ({ data: mockSummary({ progress: { safety_rating: mockRating, ranked: mockRanked } }), isLoading: false, isError: false }),
}));

// Ten drives, one every 30 hours: 6 in the last week, all 10 in the last month.
let mockData: (range: 'day' | 'week' | 'month' | 'year') => AnalyticsData = (range) => mockAnalytics(mockDrives(10, 30), range);
const mockUseAnalytics = jest.fn((range: 'day' | 'week' | 'month' | 'year') => mockData(range));
jest.mock('../useAnalytics', () => ({ useAnalytics: (range: 'day' | 'week' | 'month' | 'year') => mockUseAnalytics(range) }));

beforeEach(() => {
  jest.clearAllMocks();
  mockRating = 92.4;
  mockRanked = true;
  mockData = (range) => mockAnalytics(mockDrives(10, 30), range);
});

const SECTIONS = [
  'analytics-radar',
  'analytics-summary',
  'analytics-bests',
  'analytics-range',
  'analytics-metrics',
  'analytics-grid',
  'analytics-time-of-day',
  'analytics-map',
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

test('top to bottom: radar, summary, bests, range, metrics, when you drive, time of day, map, drives', async () => {
  await draw(<AnalyticsScreen />);
  expect(screen.getByRole('header', { name: 'Analytics' })).toBeOnTheScreen();
  expect(order()).toEqual(SECTIONS);
});

test('the radar centre is the server Safety Rating, whole and bold', async () => {
  await draw(<AnalyticsScreen />);
  expect(screen.getByTestId('radar-rating')).toHaveTextContent('92');
});

test('no Safety Rating yet: a dash', async () => {
  mockRating = null;
  await draw(<AnalyticsScreen />);
  expect(screen.getByTestId('radar-rating')).toHaveTextContent('—');
});

test('unranked (under 10 mi): a dash, as on Home and Profile', async () => {
  mockRating = 88;
  mockRanked = false;
  await draw(<AnalyticsScreen />);
  expect(screen.getByTestId('radar-rating')).toHaveTextContent('—');
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

test('the trend card sits between Driving and Points and follows the range', async () => {
  await draw(<AnalyticsScreen />);
  const cards = within(screen.getByTestId('analytics-metrics')).getAllByTestId(/^metrics-[a-z]+$/);
  expect(cards.map((c) => c.props.testID)).toEqual(['metrics-driving', 'metrics-trend', 'metrics-points']);
  expect(screen.getByTestId('metrics-trend-title')).toHaveTextContent('Trend');
  expect(screen.getByRole('tab', { name: 'Score' })).toBeSelected();
  // Six drives 30 hours apart in the week: one point per day that has one.
  expect(screen.getByTestId('trend-chart-box').props.accessibilityLabel).toMatch(/^Score by day\. /);
  await press(screen.getByRole('tab', { name: 'Month' }));
  expect(screen.getByTestId('trend-chart-box').props.accessibilityLabel).toMatch(/^Score by week\. /);
  await press(screen.getByRole('tab', { name: 'Points' }));
  expect(screen.getByTestId('trend-chart-box').props.accessibilityLabel).toMatch(/^Points per drive by week\. /);
});

test('the page keeps only general numbers: no category counts, rates or bests, and points only in general', async () => {
  await draw(<AnalyticsScreen />);
  for (const key of ['speeding', 'brakes', 'starts', 'turns', 'pickups', 'phone-time', 'after-dark', 'dark-share']) {
    expect(screen.queryByTestId(`metric-${key}`)).toBeNull();
    expect(screen.queryByTestId(`metric-${key}-rate`)).toBeNull();
  }
  expect(screen.queryByTestId('best-phone-free')).toBeNull();
  // Clean drives belong to no radar category, so they stay on the page.
  expect(screen.getByTestId('metric-clean')).toBeOnTheScreen();
  expect(screen.getByTestId('metric-clean-share')).toBeOnTheScreen();
  expect(screen.getByTestId('best-clean')).toBeOnTheScreen();
  expect(screen.queryByTestId('category-sheet')).toBeNull();
  // The points left are the range's total and per drive, and the most in one drive.
  expect(screen.getByTestId('metric-points-value')).toHaveTextContent('+792 pts');
  expect(screen.getByTestId('metric-avg-points-value')).toHaveTextContent('+132 pts');
  expect(screen.getByTestId('best-points-value')).toHaveTextContent('+132 pts');
  // The radar's per-category numbers are its scores, nothing else.
  for (const el of within(screen.getByTestId('analytics-radar')).getAllByRole('button')) expect(el.props.accessibilityLabel).toMatch(/^[A-Za-z ]+, (score \d+|no score yet|needs DashPal)$/);
});

test.each([
  ['speeding', 'Speed · 88', ['metric-speeding', 'metric-speeding-distance'], null],
  ['braking', 'Braking · 72', ['metric-brakes', 'metric-brakes-distance'], null],
  ['accel', 'Acceleration · 95', ['metric-starts', 'metric-starts-distance'], null],
  ['cornering', 'Turning · 100', ['metric-turns', 'metric-turns-distance'], null],
  ['phone', 'Phone use · 60', ['metric-pickups', 'metric-phone-time'], 'best-phone-free'],
] as const)('tapping %s on the radar opens its details, which close again', async (axis, title, cells, best) => {
  await draw(<AnalyticsScreen />);
  await press(screen.getByTestId(`radar-axis-${axis}`));
  const sheet = screen.getByTestId('category-sheet');
  expect(within(sheet).getByRole('header', { name: title })).toBeOnTheScreen();
  expect(within(sheet).getByTestId('category-coaching')).toBeOnTheScreen();
  for (const id of cells) expect(within(sheet).getByTestId(id)).toBeOnTheScreen();
  if (best) expect(within(sheet).getByTestId(best)).toBeOnTheScreen();
  else expect(within(sheet).queryByTestId('category-best')).toBeNull();
  expect(within(sheet).queryByText(/pts|points/i)).toBeNull();
  await press(within(sheet).getAllByRole('button', { name: 'Close' }).at(-1)!);
  await waitFor(() => expect(screen.queryByTestId('category-sheet')).toBeNull());
});

test('with no drives at all, every category still opens: "No data yet"', async () => {
  mockData = () => mockEmpty();
  mockRating = null;
  await draw(<AnalyticsScreen />);
  for (const axis of ['accel', 'braking', 'cornering', 'phone', 'speeding']) {
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
  // Six drives in the week, a hard brake each, 72 mi.
  expect(within(sheet).getByTestId('metric-brakes-value')).toHaveTextContent('6');
  expect(within(sheet).getByTestId('metric-brakes-distance-value')).toHaveTextContent('72.0 mi');
  await press(within(sheet).getByRole('tab', { name: 'Month' }));
  expect(mockUseAnalytics).toHaveBeenLastCalledWith('month');
  expect(within(screen.getByTestId('category-sheet')).getByTestId('metric-brakes-value')).toHaveTextContent('10');
  expect(within(screen.getByTestId('category-sheet')).getByTestId('metrics-braking-title')).toHaveTextContent('Last 30 days');
  expect(screen.getByTestId('metric-drives-value')).toHaveTextContent('10');
});

test("a category's best closes the sheet and opens its drive", async () => {
  await draw(<AnalyticsScreen />);
  await press(screen.getByTestId('radar-axis-phone'));
  await press(screen.getByTestId('best-phone-free'));
  expect(mockRouter.push).toHaveBeenCalledWith(driveSummaryHref('d0'));
  await waitFor(() => expect(screen.queryByTestId('category-sheet')).toBeNull());
});

test('a drive in the list opens its summary page', async () => {
  await draw(<AnalyticsScreen />);
  await press(screen.getByTestId('analytics-drives-toggle'));
  await press(screen.getByTestId('analytics-drive-d2'));
  expect(mockRouter.push).toHaveBeenCalledWith(driveSummaryHref('d2'));
});

test('a personal best opens its drive', async () => {
  await draw(<AnalyticsScreen />);
  await press(screen.getByTestId('best-points'));
  expect(mockRouter.push).toHaveBeenCalledWith(driveSummaryHref('d0'));
});

test('a new driver sees short empty states, not errors', async () => {
  mockRating = null;
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

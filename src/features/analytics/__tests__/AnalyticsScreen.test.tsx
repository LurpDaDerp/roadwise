import { screen } from '@testing-library/react-native';
import type { ReactTestInstance } from 'react-test-renderer';

import { draw, press, summary as mockSummary } from '@/features/drives/__fixtures__/drives';
import { driveSummaryHref } from '@/features/drives/routes';

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

test('top to bottom: radar, summary, bests, range, metrics, when you drive, map, drives', async () => {
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

test('unranked (under 25 mi): a dash, as on Home and Profile', async () => {
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

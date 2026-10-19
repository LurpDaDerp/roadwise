import { screen } from '@testing-library/react-native';

import { draw, drive as mockDrive, event as mockEvent, press, summary as mockSummary } from '../__fixtures__/drives';
import { HOME_HREF } from '../routes';
import { DriveHistoryScreen, DriveSummaryScreen } from '../screens';

const mockRouter = { push: jest.fn(), navigate: jest.fn(), replace: jest.fn(), dismissTo: jest.fn(), back: jest.fn(), canGoBack: jest.fn(() => true) };
let mockParams: Record<string, string> = { clientTripId: 'a1' };
jest.mock('expo-router', () => ({ useRouter: () => mockRouter, useLocalSearchParams: () => mockParams }));

const mockNow = new Date(2026, 9, 5, 15, 0, 0).getTime();
const mockOk = <T,>(data: T) => ({ data, isLoading: false, isError: false, isRefetching: false, refetch: jest.fn() });
let mockDetail: unknown = { drive: mockDrive(), events: [mockEvent()] };
const mockReport = jest.fn(async () => 'queued');
const mockNotDriving = jest.fn(async () => 'queued');

jest.mock('@/data/queries', () => ({
  useDataSource: () => ({ now: () => mockNow }),
  useDb: () => 'db',
  useDriveDetail: () => (mockDetail === undefined ? { data: undefined, isLoading: true, isError: false } : mockOk(mockDetail)),
  useDriveHistory: () => mockOk([]),
  useRecentDrives: () => mockOk([mockDrive()]),
  useStatSums: () => mockOk(undefined),
}));
jest.mock('@/data/server/summary', () => ({ useMySummary: () => mockOk(mockSummary({ not_driving_left: 1 })) }));
jest.mock('@/data/sync/driveActions', () => ({
  reportEvent: (...a: unknown[]) => mockReport(...(a as [])),
  markNotDriving: (...a: unknown[]) => mockNotDriving(...(a as [])),
}));
jest.mock('@tanstack/react-query', () => ({ useQueryClient: () => 'qc' }));

beforeEach(() => {
  jest.clearAllMocks();
  mockParams = { clientTripId: 'a1' };
  mockDetail = { drive: mockDrive(), events: [mockEvent()] };
});

test('the summary reads the drive and the uses left, and reports through the drive actions', async () => {
  await draw(<DriveSummaryScreen />);
  expect(screen.getByTestId('not-driving')).toHaveTextContent("Wasn't driving (1 left this month)");
  await press(screen.getByTestId('breakdown-toggle'));
  await press(screen.getByTestId('report-e1'));
  await press(screen.getByTestId('reason-hazard'));
  await press(screen.getByTestId('report-send'));
  expect(mockReport).toHaveBeenCalledWith('a1', 'e1', 'hazard', { db: 'db', queryClient: 'qc' });
});

test("confirming \"wasn't driving\" marks the drive", async () => {
  await draw(<DriveSummaryScreen />);
  await press(screen.getByTestId('not-driving'));
  await press(screen.getByTestId('not-driving-confirm'));
  expect(mockNotDriving).toHaveBeenCalledWith('a1', { db: 'db', queryClient: 'qc' });
});

test('a drive that is not on this phone says so', async () => {
  mockDetail = null;
  await draw(<DriveSummaryScreen />);
  expect(screen.getByText('Drive not found')).toBeOnTheScreen();
});

test('loading shows placeholders', async () => {
  mockDetail = undefined;
  await draw(<DriveSummaryScreen />);
  expect(screen.getByTestId('summary-loading')).toBeOnTheScreen();
});

test('an empty history’s "Go to Home" pops back to the Home already open, never a second one', async () => {
  await draw(<DriveHistoryScreen />);
  await press(screen.getByText('Go to Home'));
  expect(mockRouter.dismissTo).toHaveBeenCalledTimes(1);
  expect(mockRouter.dismissTo).toHaveBeenCalledWith(HOME_HREF);
  expect(mockRouter.replace).not.toHaveBeenCalled();
  expect(mockRouter.push).not.toHaveBeenCalled();
});

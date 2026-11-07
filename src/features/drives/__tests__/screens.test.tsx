import { act, screen } from '@testing-library/react-native';

import { createFakeDriveDetect, type CarLinkState, type CarOutput } from '@drive-sense';
import { resetPairedCars } from '@/features/carLink/usePairedCars';

import { draw, drive as mockDrive, event as mockEvent, press, summary as mockSummary } from '../__fixtures__/drives';
import { HOME_HREF } from '../routes';
import { DriveHistoryScreen, DriveSummaryScreen } from '../screens';

const mockRouter = { push: jest.fn(), navigate: jest.fn(), replace: jest.fn(), dismissTo: jest.fn(), back: jest.fn(), canGoBack: jest.fn(() => true) };
let mockParams: Record<string, string> = { clientTripId: 'a1' };
jest.mock('expo-router', () => ({ useRouter: () => mockRouter, useLocalSearchParams: () => mockParams }));
// The "Save as Home?" card reads the phone's drives and places; it has its own tests (src/features/places).
jest.mock('@/features/places/DrivePlacePrompt', () => ({ DrivePlacePrompt: () => null }));

const mockNow = new Date(2026, 9, 5, 15, 0, 0).getTime();
const mockOk = <T,>(data: T) => ({ data, isLoading: false, isError: false, isRefetching: false, refetch: jest.fn() });
let mockDetail: unknown = { drive: mockDrive(), events: [mockEvent()] };
const mockReport = jest.fn(async () => 'queued');
const mockNotDriving = jest.fn(async () => 'queued');

jest.mock('@/data/queries', () => ({
  useDataSource: () => ({ now: () => mockNow }),
  useDb: () => 'db',
  useDriveDetail: () => (mockDetail === undefined ? { data: undefined, isLoading: true, isError: false } : mockOk(mockDetail)),
  useDriveHistory: (filter: string) => {
    mockHistoryFilters.push(filter);
    return mockOk(mockHistory);
  },
  useRecentDrives: () => mockOk([mockDrive()]),
  useStatSums: () => mockOk(undefined),
}));
jest.mock('@/data/server/summary', () => ({ useMySummary: () => mockOk(mockSummary({ not_driving_left: 1 })) }));
jest.mock('@/data/sync/driveActions', () => ({
  reportEvent: (...a: unknown[]) => mockReport(...(a as [])),
  markNotDriving: (...a: unknown[]) => mockNotDriving(...(a as [])),
}));
jest.mock('@tanstack/react-query', () => ({ useQueryClient: () => 'qc' }));
let mockScores = new Map<string, number>();
jest.mock('../useDriveScores', () => ({ useDriveScores: () => mockScores }));
// The recap's commute line reads the scored drives and the saved places; it has its own tests.
let mockCommute: unknown = null;
const mockCommuteFor = jest.fn();
jest.mock('../useCommuteCompare', () => ({
  useCommuteCompare: (d: { clientTripId: string }) => {
    mockCommuteFor(d.clientTripId);
    return mockCommute;
  },
}));
let mockAuto: { state: string } = { state: 'unsupported' };
jest.mock('@/features/autoDrives/useAutoDrives', () => ({ useAutoDrives: () => mockAuto, autoDrivesOn: (a: { state: string }) => a.state === 'on' }));
let mockHistory: unknown[] = [];
let mockHistoryFilters: string[] = [];
let mockDetect = createFakeDriveDetect();
jest.mock('@/features/carLink/port', () => ({
  readCarLink: () => mockDetect.carLinkState().catch(() => null),
  onCarLink: (fn: (s: CarLinkState) => void) => {
    const sub = mockDetect.addListener('carLink', fn);
    return () => sub.remove();
  },
}));
let mockArchived: unknown = undefined;
jest.mock('@/data/queries/archived', () => ({ useArchivedKinds: () => ({ data: mockArchived }) }));

beforeEach(() => {
  jest.clearAllMocks();
  mockParams = { clientTripId: 'a1' };
  mockDetail = { drive: mockDrive(), events: [mockEvent()] };
  mockScores = new Map();
  mockCommute = null;
  mockAuto = { state: 'unsupported' };
  mockHistory = [];
  mockHistoryFilters = [];
  mockArchived = undefined;
  resetPairedCars();
  mockDetect = createFakeDriveDetect();
});

test('the summary reads the drive and the uses left, and reports through the drive actions', async () => {
  await draw(<DriveSummaryScreen />);
  expect(screen.getByTestId('not-driving')).toHaveTextContent("Wasn't driving (1 left this month)");
  await press(screen.getByTestId('report-e1'));
  await press(screen.getByTestId('reason-hazard'));
  await press(screen.getByTestId('report-send'));
  expect(mockReport).toHaveBeenCalledWith('a1', 'e1', 'hazard', { db: 'db', queryClient: 'qc' });
});

test('the summary shows the commute line for the drive on show', async () => {
  await draw(<DriveSummaryScreen />);
  expect(mockCommuteFor).toHaveBeenCalledWith('a1');
  expect(screen.queryByTestId('summary-commute')).toBeNull();
  mockCommute = { kind: 'same', text: 'Same as your usual Home → School', spoken: 'Same as your usual Home to School' };
  await draw(<DriveSummaryScreen />);
  expect(screen.getByTestId('summary-commute')).toHaveProp('accessibilityLabel', 'Same as your usual Home to School');
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

test('the history shows each drive with its score, and the empty list words follow automatic drives', async () => {
  mockHistory = [mockDrive({ clientTripId: 'h1' })];
  mockScores = new Map([['h1', 97]]);
  await draw(<DriveHistoryScreen />);
  expect(screen.getByTestId('drive-h1-score')).toHaveTextContent('97');
  mockHistory = [];
  mockAuto = { state: 'on' };
  await draw(<DriveHistoryScreen />);
  expect(screen.getByText("Your drives show up here after you've driven. RoadWise notices them on its own.")).toBeOnTheScreen();
  // Drives past 183 days (archived) exist: the empty list says so instead of "yet".
  mockArchived = { all: true, clean: false, passenger: false };
  await draw(<DriveHistoryScreen />);
  expect(screen.getByText('No drives in the last 6 months')).toBeOnTheScreen();
});

const civic: CarOutput = { uid: '00:11:22:33:44:55-tacl', name: 'Civic', type: 'bluetoothA2DP' };
const volvo: CarOutput = { uid: '66:77:88:99:AA:BB-tacl', name: 'Volvo XC60', type: 'bluetoothA2DP' };
async function pairAll(...outputs: CarOutput[]) {
  for (const o of outputs) {
    mockDetect.setCarRoute([o]);
    await mockDetect.pairCar(o.uid);
  }
  mockDetect.setCarRoute([]);
}
const lastFilter = () => mockHistoryFilters[mockHistoryFilters.length - 1];

test('with 2 cars paired, the history filters by car: the chip asks for that car’s drives and a second tap all of them', async () => {
  await pairAll(civic, volvo);
  await draw(<DriveHistoryScreen />);
  await act(async () => {});
  await press(screen.getByTestId(`filter-car:${volvo.uid}`));
  expect(lastFilter()).toBe(`car:${volvo.uid}`);
  expect(screen.getByTestId(`filter-car:${volvo.uid}`)).toBeSelected();
  await press(screen.getByTestId(`filter-car:${volvo.uid}`));
  expect(lastFilter()).toBe('all');
});

test('a car filter on screen goes back to all when that car is forgotten, or fewer than 2 stay paired, and stays off when it is paired again', async () => {
  await pairAll(civic, volvo);
  await draw(<DriveHistoryScreen />);
  await act(async () => {});
  await press(screen.getByTestId(`filter-car:${volvo.uid}`));
  expect(lastFilter()).toBe(`car:${volvo.uid}`);
  await act(async () => {
    await mockDetect.forgetCar(volvo.uid);
  });
  expect(lastFilter()).toBe('all');
  expect(screen.queryByTestId(`filter-car:${volvo.uid}`)).toBeNull();
  expect(screen.queryByTestId(`filter-car:${civic.uid}`)).toBeNull();
  await act(async () => {
    mockDetect.setCarRoute([volvo]);
    await mockDetect.pairCar(volvo.uid);
  });
  expect(screen.getByTestId(`filter-car:${volvo.uid}`)).not.toBeSelected();
  expect(lastFilter()).toBe('all');
});

test('one car paired: no car chips, and the list is never asked for a car', async () => {
  await pairAll(civic);
  await draw(<DriveHistoryScreen />);
  await act(async () => {});
  expect(screen.queryByTestId(`filter-car:${civic.uid}`)).toBeNull();
  expect(mockHistoryFilters.every((f) => f === 'all')).toBe(true);
});

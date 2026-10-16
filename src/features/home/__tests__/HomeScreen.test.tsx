import { act, screen, waitFor } from '@testing-library/react-native';

import { draw, drive as mockDrive, press, summary as mockSummary, sums as mockSums } from '@/features/drives/__fixtures__/drives';

import { ThemeProvider } from '@/ui';

import { HomeScreen } from '../HomeScreen';
import { clearStartNotice, readStartNotice, showStartNotice } from '../startNotice';

const mockRouter = { push: jest.fn(), navigate: jest.fn(), replace: jest.fn(), back: jest.fn(), canGoBack: jest.fn(() => true) };
jest.mock('expo-router', () => ({ useRouter: () => mockRouter, useFocusEffect: jest.fn() }));

const mockOk = <T,>(data: T) => ({ data, isLoading: false, isError: false, isRefetching: false, refetch: jest.fn() });
const mockStart = jest.fn();
const mockDbHandle = {};

jest.mock('@/data/queries', () => ({
  useDataSource: () => ({ now: () => Date.now() }),
  useDb: () => mockDbHandle,
  useDriveCount: () => mockOk(12),
  useRecentDrives: () => mockOk([mockDrive()]),
  useStatSums: () => mockOk(mockSums()),
}));
jest.mock('@/data/server/summary', () => ({ useMySummary: () => mockOk(mockSummary()) }));
let mockRecording = false;
jest.mock('@/drive/useDrive', () => ({
  useDriveControls: () => ({ start: mockStart, end: jest.fn() }),
  useDrive: (sel: (d: { status: string; lastFinalized: null }) => unknown) => sel({ status: mockRecording ? 'recording' : 'idle', lastFinalized: null }),
}));
let mockNotice: { clientTripId: string; cause: string; reason: string; at: number } | null = null;
const mockClearNotice = jest.fn(async () => {
  mockNotice = null;
});
jest.mock('@/drive/dropNotice', () => ({
  readDropNotice: async () => mockNotice,
  clearDropNotice: () => mockClearNotice(),
}));
jest.mock('@/features/drive/DriveInProgressBanner', () => {
  const { Text } = jest.requireActual<typeof import('react-native')>('react-native');
  return { DriveInProgressBanner: () => <Text testID="drive-in-progress">Drive in progress</Text> };
});

beforeEach(() => {
  jest.clearAllMocks();
  mockRecording = false;
  mockNotice = null;
  clearStartNotice();
});

describe('the notice of a drive that was not kept', () => {
  const notice = { clientTripId: 'gone', cause: 'stopped', reason: 'no_movement', at: 1 };

  test('read from storage on mount (so it survives a relaunch), it shows above Start until OK, which clears it', async () => {
    mockNotice = { ...notice };
    await draw(<HomeScreen />);
    expect(await screen.findByTestId('drive-dropped')).toHaveTextContent(/the car didn’t move for 15 min, so it wasn’t saved\./);
    await press(screen.getByText('OK'));
    expect(screen.queryByTestId('drive-dropped')).toBeNull();
    expect(mockClearNotice).toHaveBeenCalledTimes(1);
  });

  test('hidden while a drive is recording (Start is not shown)', async () => {
    mockNotice = { ...notice };
    mockRecording = true;
    await draw(<HomeScreen />);
    await waitFor(() => expect(screen.getByTestId('drive-in-progress')).toBeOnTheScreen());
    expect(screen.queryByTestId('drive-dropped')).toBeNull();
  });

  test('a successful start takes it down; a refusal shows instead of it', async () => {
    mockNotice = { ...notice };
    mockStart.mockResolvedValue({ ok: false, reason: 'busy' });
    await draw(<HomeScreen />);
    expect(await screen.findByTestId('drive-dropped')).toBeOnTheScreen();
    await press(screen.getByTestId('start-drive'));
    expect(await screen.findByTestId('start-refusal')).toBeOnTheScreen();
    expect(screen.queryByTestId('drive-dropped')).toBeNull();
    mockStart.mockResolvedValue({ ok: true, clientTripId: 'x' });
    await press(screen.getByTestId('start-drive'));
    await waitFor(() => expect(mockRouter.push).toHaveBeenCalledWith('/drive'));
    expect(screen.queryByTestId('drive-dropped')).toBeNull();
    expect(screen.queryByTestId('start-refusal')).toBeNull();
  });
});

test('a successful start opens the driving screen', async () => {
  mockStart.mockResolvedValue({ ok: true, clientTripId: 'x' });
  await draw(<HomeScreen />);
  await press(screen.getByTestId('start-drive'));
  await waitFor(() => expect(mockRouter.push).toHaveBeenCalledWith('/drive'));
  expect(mockStart).toHaveBeenCalledWith();
});

test('no location: nothing is recorded, Home says location is needed and Fix it opens Permissions', async () => {
  mockStart.mockResolvedValue({ ok: false, reason: 'permission' });
  await draw(<HomeScreen />);
  await press(screen.getByTestId('start-drive'));
  expect(await screen.findByText('RoadWise needs location to record a drive.')).toBeOnTheScreen();
  expect(mockRouter.push).not.toHaveBeenCalled();
  await press(screen.getByText('Fix it'));
  expect(mockRouter.push).toHaveBeenCalledTimes(1);
  expect(mockRouter.push).not.toHaveBeenCalledWith('/drive');
});

test('while a drive is recording, the in-progress strip replaces Start', async () => {
  mockRecording = true;
  await draw(<HomeScreen />);
  expect(screen.getByTestId('drive-in-progress')).toBeOnTheScreen();
  expect(screen.queryByTestId('start-drive')).toBeNull();
});

describe('a tap on the forgot-to-start reminder that started no drive', () => {
  test('a notice set before Home mounts shows in the refusal line, with Fix it for permission, until the next start', async () => {
    showStartNotice('permission');
    await draw(<HomeScreen />);
    expect(await screen.findByText('RoadWise needs location to record a drive.')).toBeOnTheScreen();
    await press(screen.getByText('Fix it'));
    expect(mockRouter.push).toHaveBeenCalledTimes(1);
    expect(mockRouter.push).not.toHaveBeenCalledWith('/drive');
    mockStart.mockResolvedValue({ ok: true, clientTripId: 'x' });
    await press(screen.getByTestId('start-drive'));
    await waitFor(() => expect(mockRouter.push).toHaveBeenCalledWith('/drive'));
    expect(readStartNotice()).toBeNull();
    expect(screen.queryByTestId('start-refusal')).toBeNull();
  });

  test('a notice set while Home is on screen shows at once; an expired reminder says so, with no button', async () => {
    await draw(<HomeScreen />);
    expect(screen.queryByTestId('start-refusal')).toBeNull();
    await act(async () => showStartNotice('reminder-expired'));
    expect(await screen.findByTestId('start-refusal')).toHaveTextContent(/That reminder has expired. Tap Start Drive to record a drive./);
    expect(screen.queryByText('Fix it')).toBeNull();
    expect(screen.queryByText('Open it')).toBeNull();
  });

  test('a newer notice outranks an older refused Start', async () => {
    mockStart.mockResolvedValue({ ok: false, reason: 'busy' });
    await draw(<HomeScreen />);
    await press(screen.getByTestId('start-drive'));
    expect(await screen.findByText('A drive is already running.')).toBeOnTheScreen();
    await act(async () => showStartNotice('reminder-expired'));
    expect(await screen.findByText('That reminder has expired. Tap Start Drive to record a drive.')).toBeOnTheScreen();
  });

  test('a drive that starts (by the reminder too) takes an old refused Start down', async () => {
    mockStart.mockResolvedValue({ ok: false, reason: 'error' });
    const view = await draw(<HomeScreen />);
    await press(screen.getByTestId('start-drive'));
    expect(await screen.findByTestId('start-refusal')).toBeOnTheScreen();
    mockRecording = true;
    await view.rerender(
      <ThemeProvider scheme="light" reduceMotion>
        <HomeScreen />
      </ThemeProvider>
    );
    await waitFor(() => expect(screen.queryByTestId('start-refusal')).toBeNull());
    // and it does not come back when the drive is over
    mockRecording = false;
    await view.rerender(
      <ThemeProvider scheme="light" reduceMotion>
        <HomeScreen />
      </ThemeProvider>
    );
    expect(await screen.findByTestId('start-drive')).toBeOnTheScreen();
    expect(screen.queryByTestId('start-refusal')).toBeNull();
  });
});

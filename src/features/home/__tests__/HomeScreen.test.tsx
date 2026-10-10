import { screen, waitFor } from '@testing-library/react-native';

import { draw, drive as mockDrive, press, summary as mockSummary, sums as mockSums } from '@/features/drives/__fixtures__/drives';

import { HomeScreen } from '../HomeScreen';

const mockRouter = { push: jest.fn(), navigate: jest.fn(), replace: jest.fn(), back: jest.fn(), canGoBack: jest.fn(() => true) };
jest.mock('expo-router', () => ({ useRouter: () => mockRouter, useFocusEffect: jest.fn() }));

const mockOk = <T,>(data: T) => ({ data, isLoading: false, isError: false, isRefetching: false, refetch: jest.fn() });
const mockStart = jest.fn();

jest.mock('@/data/queries', () => ({
  useDataSource: () => ({ now: () => Date.now() }),
  useDriveCount: () => mockOk(12),
  useRecentDrives: () => mockOk([mockDrive()]),
  useStatSums: () => mockOk(mockSums()),
}));
jest.mock('@/data/server/summary', () => ({ useMySummary: () => mockOk(mockSummary()) }));
let mockRecording = false;
jest.mock('@/drive/useDrive', () => ({
  useDriveControls: () => ({ start: mockStart, end: jest.fn() }),
  useDrive: (sel: (d: { status: string }) => unknown) => sel({ status: mockRecording ? 'recording' : 'idle' }),
}));
jest.mock('@/features/drive/DriveInProgressBanner', () => {
  const { Text } = jest.requireActual<typeof import('react-native')>('react-native');
  return { DriveInProgressBanner: () => <Text testID="drive-in-progress">Drive in progress</Text> };
});
jest.mock('@/drive/forgottenDrive', () => ({ useForgottenDriveNotice: () => null }));

beforeEach(() => {
  jest.clearAllMocks();
  mockRecording = false;
});

test('a successful start opens the driving screen', async () => {
  mockStart.mockResolvedValue({ ok: true, clientTripId: 'x' });
  await draw(<HomeScreen />);
  await press(screen.getByTestId('start-drive'));
  await waitFor(() => expect(mockRouter.push).toHaveBeenCalledWith('/drive'));
  expect(mockStart).toHaveBeenCalledWith();
});

test('moving: nothing is recorded and Home says to pull over', async () => {
  mockStart.mockResolvedValue({ ok: false, reason: 'moving' });
  await draw(<HomeScreen />);
  await press(screen.getByTestId('start-drive'));
  expect(await screen.findByText(/Pull over to start a drive/)).toBeOnTheScreen();
  expect(mockRouter.push).not.toHaveBeenCalled();
});

test('while a drive is recording, the in-progress strip replaces Start', async () => {
  mockRecording = true;
  await draw(<HomeScreen />);
  expect(screen.getByTestId('drive-in-progress')).toBeOnTheScreen();
  expect(screen.queryByTestId('start-drive')).toBeNull();
});

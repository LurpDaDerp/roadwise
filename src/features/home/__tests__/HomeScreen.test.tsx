import { screen, waitFor } from '@testing-library/react-native';

import { draw, drive as mockDrive, press, summary as mockSummary, sums as mockSums } from '@/features/drives/__fixtures__/drives';

import { HomeScreen } from '../HomeScreen';

const mockRouter = { push: jest.fn(), navigate: jest.fn(), replace: jest.fn(), back: jest.fn(), canGoBack: jest.fn(() => true) };
jest.mock('expo-router', () => ({ useRouter: () => mockRouter, useFocusEffect: jest.fn() }));

const mockOk = <T,>(data: T) => ({ data, isLoading: false, isError: false, isRefetching: false, refetch: jest.fn() });
const mockStart = jest.fn();
const mockSetEnabled = jest.fn(async () => undefined);
let mockDms = { enabled: false, calibrated: true };

jest.mock('@/data/queries', () => ({
  useDataSource: () => ({ now: () => Date.now() }),
  useDriveCount: () => mockOk(12),
  useRecentDrives: () => mockOk([mockDrive()]),
  useStatSums: () => mockOk(mockSums()),
}));
jest.mock('@/data/server/summary', () => ({ useMySummary: () => mockOk(mockSummary()) }));
jest.mock('@/drive/useDrive', () => ({ useDriveControls: () => ({ start: mockStart, end: jest.fn() }) }));
jest.mock('@/drive/forgottenDrive', () => ({ useForgottenDriveNotice: () => null }));
jest.mock('../useDmsSetting', () => ({ useDmsSetting: () => ({ setting: mockDms, setEnabled: mockSetEnabled }) }));

beforeEach(() => {
  jest.clearAllMocks();
  mockDms = { enabled: false, calibrated: true };
});

test('a successful start opens the driving screen with the DMS choice', async () => {
  mockDms = { enabled: true, calibrated: true };
  mockStart.mockResolvedValue({ ok: true, clientTripId: 'x' });
  await draw(<HomeScreen />);
  await press(screen.getByTestId('start-drive'));
  await waitFor(() => expect(mockRouter.push).toHaveBeenCalledWith('/drive'));
  expect(mockStart).toHaveBeenCalledWith({ dmsOn: true });
});

test('moving: nothing is recorded and Home says to pull over', async () => {
  mockStart.mockResolvedValue({ ok: false, reason: 'moving' });
  await draw(<HomeScreen />);
  await press(screen.getByTestId('start-drive'));
  expect(await screen.findByText(/Pull over to start a drive/)).toBeOnTheScreen();
  expect(mockRouter.push).not.toHaveBeenCalled();
});

test('the DMS chip toggles the setting once calibrated, and opens setup before that', async () => {
  await draw(<HomeScreen />);
  await press(screen.getByTestId('dms-chip'));
  expect(mockSetEnabled).toHaveBeenCalledWith(true);

  mockDms = { enabled: false, calibrated: false };
  await draw(<HomeScreen />);
  await press(screen.getAllByTestId('dms-chip').at(-1)!);
  expect(mockRouter.push).toHaveBeenCalledWith('/(app)/settings/dms-setup');
});

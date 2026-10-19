import { act, screen, waitFor } from '@testing-library/react-native';
import { AppState, ScrollView, type AppStateStatus } from 'react-native';

import { draw, drive as mockDrive, press, result as mockResult, summary as mockSummary, sums as mockSums } from '@/features/drives/__fixtures__/drives';
import type { LocalDrive } from '@/features/drives/model';

import { ThemeProvider } from '@/ui';

import { HomeScreen } from '../HomeScreen';
import { clearStartNotice, readStartNotice, showStartNotice } from '../startNotice';

const mockRouter = { push: jest.fn(), navigate: jest.fn(), replace: jest.fn(), back: jest.fn(), canGoBack: jest.fn(() => true) };
// Focus runs its effect on mount (and again whenever the callback changes), as on a real focus.
jest.mock('expo-router', () => {
  const { useEffect } = jest.requireActual<typeof import('react')>('react');
  return { useRouter: () => mockRouter, useFocusEffect: (fn: () => void | (() => void)) => useEffect(fn, [fn]) };
});

// The permission board: what the card would show is the test's to set.
type MockBoard = { status: string; read: unknown; prefs: { hidden: string[]; toSettings: Record<string, string> }; refresh: jest.Mock; fix: jest.Mock; hide: jest.Mock; show: jest.Mock };
let mockBoard: MockBoard;
jest.mock('@/features/permissions/usePermissionBoard', () => ({ usePermissionBoard: () => mockBoard }));
jest.mock('@/features/permissions/PermissionCard', () => {
  const { Text } = jest.requireActual<typeof import('react-native')>('react-native');
  const { homeCard } = jest.requireActual<typeof import('@/features/permissions/board')>('@/features/permissions/board');
  return {
    PermissionCard: ({ board, recording }: { board: MockBoard; recording: boolean }) =>
      board.status === 'ready' && board.read && homeCard(board.read as never, board.prefs as never, recording).row ? <Text testID="home-permissions">a permission row</Text> : null,
  };
});

const mockOk = <T,>(data: T) => ({ data, isLoading: false, isError: false, isRefetching: false, refetch: jest.fn() });
const mockStart = jest.fn();
const mockDbHandle = {};

let mockRecent: LocalDrive[] = [];
jest.mock('@/data/queries', () => ({
  useDataSource: () => ({ now: () => Date.now() }),
  useDb: () => mockDbHandle,
  useDriveCount: () => mockOk(12),
  useRecentDrives: () => mockOk(mockRecent),
  useStatSums: () => mockOk(mockSums()),
}));
// The device settings (the streak card's dismissal), in memory.
const mockSettings = new Map<string, unknown>();
jest.mock('@/data/db/settings', () => ({
  createSettingsRepo: () => ({
    get: async (k: string) => mockSettings.get(k) ?? null,
    set: async (k: string, v: unknown) => {
      mockSettings.set(k, v);
    },
  }),
}));
// The 30-day coaching behind the tip card.
let mockCoaching: { level: string | null; axis: string | null; title: string; tip: string } = { level: 'good', axis: null, title: 'Driving well', tip: 'Smooth driving lately. Keep it up.' };
jest.mock('@/features/analytics/useAnalytics', () => ({ useCoaching: () => ({ coaching: mockCoaching }) }));
jest.mock('@/features/weather/HomeWeatherAlert', () => {
  const { Text } = jest.requireActual<typeof import('react-native')>('react-native');
  return { HomeWeatherAlert: () => <Text testID="home-weather">weather</Text> };
});
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

function boardWith(read: unknown): MockBoard {
  return { status: read ? 'ready' : 'loading', read, prefs: { hidden: [], toSettings: {} }, refresh: jest.fn(async () => {}), fix: jest.fn(async () => null), hide: jest.fn(), show: jest.fn() };
}
const ALL_ON = {
  snapshot: { platform: 'ios', location: 'foreground', precise: true, locationCanAskAgain: true, locationServices: true, motion: 'granted', notifications: 'granted', notificationsCanAskAgain: true, batteryOptimization: 'exempt', lowPowerMode: false, checkedAt: 1 },
  androidApi: null,
  paired: false,
  bluetooth: null,
  camera: null,
  reminder: null,
};
const MOTION_OFF = { ...ALL_ON, snapshot: { ...ALL_ON.snapshot, motion: 'denied' } };

beforeEach(() => {
  jest.clearAllMocks();
  mockRecent = [mockDrive()];
  mockSettings.clear();
  mockCoaching = { level: 'good', axis: null, title: 'Driving well', tip: 'Smooth driving lately. Keep it up.' };
  mockBoard = boardWith(null);
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
    expect(await screen.findByTestId('start-refusal')).toHaveTextContent(/That reminder has expired. Tap Start drive instead./);
    expect(screen.queryByText('Fix it')).toBeNull();
    expect(screen.queryByText('Open it')).toBeNull();
  });

  test('a newer notice outranks an older refused Start', async () => {
    mockStart.mockResolvedValue({ ok: false, reason: 'busy' });
    await draw(<HomeScreen />);
    await press(screen.getByTestId('start-drive'));
    expect(await screen.findByText('A drive is already running.')).toBeOnTheScreen();
    await act(async () => showStartNotice('reminder-expired'));
    expect(await screen.findByText('That reminder has expired. Tap Start drive instead.')).toBeOnTheScreen();
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

describe('the permission card', () => {
  const scrollTo = () => (ScrollView.prototype as unknown as { scrollTo: jest.Mock }).scrollTo;
  let appStateListeners: ((s: AppStateStatus) => void)[] = [];
  beforeEach(() => {
    appStateListeners = [];
    jest.spyOn(AppState, 'addEventListener').mockImplementation((_t, fn) => {
      appStateListeners.push(fn as (s: AppStateStatus) => void);
      return { remove: () => {} } as never;
    });
  });
  afterEach(() => jest.restoreAllMocks());

  test('a row shows under the greeting and Home opens at the top on focus; the board is read (deduped) on focus', async () => {
    mockBoard = boardWith(MOTION_OFF);
    await draw(<HomeScreen />);
    expect(screen.getByTestId('home-permissions')).toBeOnTheScreen();
    expect(scrollTo()).toHaveBeenCalledWith({ y: 0, animated: false });
    expect(mockBoard.refresh).toHaveBeenCalledWith('focus');
  });

  test('back in front with a row showing: Home returns to the top again', async () => {
    mockBoard = boardWith(MOTION_OFF);
    await draw(<HomeScreen />);
    scrollTo().mockClear();
    await act(async () => {
      for (const fn of appStateListeners) fn('active');
    });
    expect(scrollTo()).toHaveBeenCalledWith({ y: 0, animated: false });
  });

  test('no row: Home keeps its place (no scroll), on focus and on return', async () => {
    mockBoard = boardWith(ALL_ON);
    await draw(<HomeScreen />);
    await act(async () => {
      for (const fn of appStateListeners) fn('active');
    });
    expect(screen.queryByTestId('home-permissions')).toBeNull();
    expect(scrollTo()).not.toHaveBeenCalled();
  });

  test('a board read that is in before the stored prefs (still loading): no card and no scroll', async () => {
    mockBoard = { ...boardWith(MOTION_OFF), status: 'loading' };
    await draw(<HomeScreen />);
    expect(screen.queryByTestId('home-permissions')).toBeNull();
    expect(scrollTo()).not.toHaveBeenCalled();
  });

  test('while a drive records: no card and no scroll', async () => {
    mockBoard = boardWith(MOTION_OFF);
    mockRecording = true;
    await draw(<HomeScreen />);
    expect(screen.queryByTestId('home-permissions')).toBeNull();
    expect(scrollTo()).not.toHaveBeenCalled();
  });

  test('pull to refresh reads the board again', async () => {
    mockBoard = boardWith(MOTION_OFF);
    await draw(<HomeScreen />);
    const { refreshControl } = screen.getByTestId('home').props as { refreshControl: { props: { onRefresh: () => void } } };
    await act(async () => refreshControl.props.onRefresh());
    expect(mockBoard.refresh).toHaveBeenCalledWith('shared');
  });
});

describe('a Start refused for Precise Location or Location Services', () => {
  test.each([
    ['precise', 'RoadWise needs Precise Location to record a drive.', 'precise'],
    ['services', 'Location Services are off. Turn them on to record a drive.', 'location'],
  ] as const)('%s: one line, and Fix it runs that row’s own fix', async (reason, line, id) => {
    mockBoard = boardWith(ALL_ON);
    mockBoard.fix.mockResolvedValue({ kind: 'opened' });
    mockStart.mockResolvedValue({ ok: false, reason });
    await draw(<HomeScreen />);
    await press(screen.getByTestId('start-drive'));
    expect(await screen.findByText(line)).toBeOnTheScreen();
    expect(line.length).toBeLessThanOrEqual(60);
    await press(screen.getByText('Fix it'));
    await waitFor(() => expect(mockBoard.fix).toHaveBeenCalledWith(id));
    expect(mockRouter.push).not.toHaveBeenCalled();
  });

  test('a fix that cannot run there (the board reads it as fine, or it fails) opens Settings › Permissions', async () => {
    mockBoard = boardWith(ALL_ON);
    mockBoard.fix.mockResolvedValue(null);
    mockStart.mockResolvedValue({ ok: false, reason: 'precise' });
    await draw(<HomeScreen />);
    await press(screen.getByTestId('start-drive'));
    await press(await screen.findByText('Fix it'));
    await waitFor(() => expect(mockRouter.push).toHaveBeenCalledWith('/(app)/settings/permissions'));
    mockRouter.push.mockClear();
    mockBoard.fix.mockRejectedValue(new Error('bridge'));
    await press(screen.getByText('Fix it'));
    await waitFor(() => expect(mockRouter.push).toHaveBeenCalledWith('/(app)/settings/permissions'));
  });

  test('a reminder tap refused the same way shows the same line', async () => {
    showStartNotice('services');
    await draw(<HomeScreen />);
    expect(await screen.findByText('Location Services are off. Turn them on to record a drive.')).toBeOnTheScreen();
    expect(screen.getByText('Fix it')).toBeOnTheScreen();
  });
});

describe('Analytics and the action items', () => {
  test('the Safety Rating badge, "All stats" and the tip card open the Analytics tab', async () => {
    mockCoaching = { level: 'poor', axis: 'speeding', title: 'Watch your speed', tip: 'Ease off a little over the limit.' };
    await draw(<HomeScreen />);
    await press(screen.getByTestId('rating-badge'));
    expect(mockRouter.navigate).toHaveBeenLastCalledWith('/(tabs)/analytics');
    await press(screen.getByText('All stats'));
    expect(mockRouter.navigate).toHaveBeenLastCalledWith('/(tabs)/analytics');
    await press(screen.getByTestId('home-tip'));
    expect(mockRouter.navigate).toHaveBeenLastCalledWith('/(tabs)/analytics');
    expect(mockRouter.navigate).toHaveBeenCalledTimes(3);
    expect(mockRouter.push).not.toHaveBeenCalled();
  });

  test('no tip card while driving is good', async () => {
    await draw(<HomeScreen />);
    expect(screen.queryByTestId('home-tip')).toBeNull();
  });

  test('the dangerous-weather card has its slot on Home (its order is pinned in the HomeView tests)', async () => {
    await draw(<HomeScreen />);
    expect(screen.getByTestId('home-weather')).toBeOnTheScreen();
  });
});

describe('the streak card', () => {
  const lost = (id: string) => mockDrive({ clientTripId: id, result: mockResult({ streak: { before: 6, after: 0, outcome: 'reset', nextMult: 1, atRisk: false, freezes: 0, freezeEarned: false } }) });
  const saved = (id: string) => mockDrive({ clientTripId: id, result: mockResult({ streak: { before: 6, after: 6, outcome: 'freeze_used', nextMult: 1.1, atRisk: false, freezes: 1, freezeEarned: false } }) });

  test('the latest drive lost the streak: the card shows until ✕, and stays away (stored by drive)', async () => {
    mockRecent = [lost('t1'), mockDrive({ clientTripId: 'older' })];
    const view = await draw(<HomeScreen />);
    expect(await screen.findByText('Streak lost')).toBeOnTheScreen();
    expect(screen.getByText('2 freezes left')).toBeOnTheScreen();
    await press(screen.getByTestId('home-streak-card-dismiss'));
    expect(screen.queryByTestId('home-streak-card')).toBeNull();
    await waitFor(() => expect(mockSettings.get('home.streakCard.dismissed')).toBe('t1'));
    await view.unmount();
    await draw(<HomeScreen />);
    await act(async () => {});
    expect(screen.queryByTestId('home-streak-card')).toBeNull();
  });

  test('a newer drive with news shows again after an older dismissal; one that grew the streak takes it down', async () => {
    mockSettings.set('home.streakCard.dismissed', 't1');
    mockRecent = [saved('t2'), lost('t1')];
    const view = await draw(<HomeScreen />);
    expect(await screen.findByText('A freeze saved your streak')).toBeOnTheScreen();
    await view.unmount();
    mockRecent = [mockDrive({ clientTripId: 't3' }), saved('t2')];
    await draw(<HomeScreen />);
    await act(async () => {});
    expect(screen.queryByTestId('home-streak-card')).toBeNull();
  });
});

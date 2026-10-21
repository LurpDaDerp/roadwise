import { act, screen, waitFor } from '@testing-library/react-native';
import { AppState, ScrollView, type AppStateStatus } from 'react-native';

import { draw, drive as mockDrive, press, summary as mockSummary, sums as mockSums, swipe } from '@/features/drives/__fixtures__/drives';
import type { LocalDrive } from '@/features/drives/model';
import type { AutoDrives } from '@/features/autoDrives/useAutoDrives';

import { ThemeProvider } from '@/ui';

import { HomeScreen, isManualDrop } from '../HomeScreen';
import { clearHomeNotice, readHomeNotice, showHomeNotice } from '../homeNotice';

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
// Whether drives start on their own (the native status), the test's to set.
let mockAuto: AutoDrives = { state: 'unsupported' };
jest.mock('@/features/autoDrives/useAutoDrives', () => ({
  useAutoDrives: () => mockAuto,
  autoDrivesOn: (a: AutoDrives) => a.state === 'on',
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
let mockWaiting = false;
jest.mock('@/drive/useDrive', () => ({
  useDriveControls: () => ({ start: mockStart, end: jest.fn() }),
  useDrive: (sel: (d: { status: string; waiting: unknown; lastFinalized: null }) => unknown) =>
    sel({
      status: mockRecording ? 'recording' : 'idle',
      waiting: mockWaiting ? { since: 1, phase: 'waiting', deadlineAt: 2, speedMps: null, limitMph: null } : null,
      lastFinalized: null,
    }),
}));
let mockNotice: { clientTripId: string; cause: string; reason: string; at: number } | null = null;
const mockClearNotice = jest.fn(async () => {
  mockNotice = null;
});
jest.mock('@/drive/dropNotice', () => ({
  readDropNotice: async () => mockNotice,
  clearDropNotice: () => mockClearNotice(),
}));
jest.mock('@/features/drives/useDriveScores', () => ({ useDriveScores: () => new Map([['a1', 97]]) }));
// The DashPal slot has its own tests.
jest.mock('@/dashcam/ui/HomeDashpal', () => ({ HomeDashpal: () => null }));
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
  mockAuto = { state: 'unsupported' };
  mockCoaching = { level: 'good', axis: null, title: 'Driving well', tip: 'Smooth driving lately. Keep it up.' };
  mockBoard = boardWith(null);
  mockRecording = false;
  mockWaiting = false;
  mockNotice = null;
  clearHomeNotice();
});

describe('the notice of a drive that was not kept', () => {
  const notice = { clientTripId: 'gone', cause: 'stopped', reason: 'no_movement', at: 1 };

  test('read from storage on mount (so it survives a relaunch), it shows above Start until OK, which clears it', async () => {
    mockNotice = { ...notice };
    await draw(<HomeScreen />);
    expect(await screen.findByTestId('drive-dropped')).toHaveTextContent(/the car didn’t move for 5 min, so it wasn’t saved\./);
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
    await swipe(screen.getByTestId('start-drive'));
    expect(await screen.findByTestId('start-refusal')).toBeOnTheScreen();
    expect(screen.queryByTestId('drive-dropped')).toBeNull();
    mockStart.mockResolvedValue({ ok: true, clientTripId: 'x' });
    await swipe(screen.getByTestId('start-drive'));
    await waitFor(() => expect(mockRouter.push).toHaveBeenCalledWith('/drive'));
    expect(screen.queryByTestId('drive-dropped')).toBeNull();
    expect(screen.queryByTestId('start-refusal')).toBeNull();
  });
});

test('a successful start opens the driving screen', async () => {
  mockStart.mockResolvedValue({ ok: true, clientTripId: 'x' });
  await draw(<HomeScreen />);
  await swipe(screen.getByTestId('start-drive'));
  await waitFor(() => expect(mockRouter.push).toHaveBeenCalledWith('/drive'));
  expect(mockStart).toHaveBeenCalledWith();
});

test('no location: nothing is recorded, Home says location is needed and Fix it opens Permissions', async () => {
  mockStart.mockResolvedValue({ ok: false, reason: 'permission' });
  await draw(<HomeScreen />);
  await swipe(screen.getByTestId('start-drive'));
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

describe('the line Home keeps in memory', () => {
  test('a refusal set before Home mounts shows in the refusal line, with Fix it for permission, until the next start', async () => {
    showHomeNotice('permission');
    await draw(<HomeScreen />);
    expect(await screen.findByText('RoadWise needs location to record a drive.')).toBeOnTheScreen();
    await press(screen.getByText('Fix it'));
    expect(mockRouter.push).toHaveBeenCalledTimes(1);
    expect(mockRouter.push).not.toHaveBeenCalledWith('/drive');
    mockStart.mockResolvedValue({ ok: true, clientTripId: 'x' });
    await swipe(screen.getByTestId('start-drive'));
    await waitFor(() => expect(mockRouter.push).toHaveBeenCalledWith('/drive'));
    expect(readHomeNotice()).toBeNull();
    expect(screen.queryByTestId('start-refusal')).toBeNull();
  });

  test('after "Not driving?": the acknowledgement once, until OK; it outranks an older drop line', async () => {
    mockNotice = { clientTripId: 'gone', cause: 'stopped', reason: 'no_movement', at: 1 };
    await draw(<HomeScreen />);
    expect(await screen.findByTestId('drive-dropped')).toBeOnTheScreen();
    await act(async () => showHomeNotice('notDriving'));
    expect(await screen.findByTestId('not-driving-ack')).toHaveTextContent(/Got it. That trip won't count./);
    expect(screen.queryByTestId('drive-dropped')).toBeNull();
    expect(screen.queryByText('Fix it')).toBeNull();
    await press(screen.getByText('OK'));
    expect(readHomeNotice()).toBeNull();
    expect(screen.queryByTestId('not-driving-ack')).toBeNull();
    expect(await screen.findByTestId('drive-dropped')).toBeOnTheScreen();
  });

  test('a refused Start outranks the "Not driving?" line; a start takes the line down', async () => {
    showHomeNotice('notDriving');
    mockStart.mockResolvedValue({ ok: false, reason: 'busy' });
    await draw(<HomeScreen />);
    expect(await screen.findByTestId('not-driving-ack')).toBeOnTheScreen();
    await swipe(screen.getByTestId('start-drive'));
    expect(await screen.findByText('A drive is already running.')).toBeOnTheScreen();
    expect(readHomeNotice()).toBeNull();
    expect(screen.queryByTestId('not-driving-ack')).toBeNull();
  });

  test('a drive that starts any way takes an old refused Start down', async () => {
    mockStart.mockResolvedValue({ ok: false, reason: 'error' });
    const view = await draw(<HomeScreen />);
    await swipe(screen.getByTestId('start-drive'));
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
    await swipe(screen.getByTestId('start-drive'));
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
    await swipe(screen.getByTestId('start-drive'));
    await press(await screen.findByText('Fix it'));
    await waitFor(() => expect(mockRouter.push).toHaveBeenCalledWith('/(app)/settings/permissions'));
    mockRouter.push.mockClear();
    mockBoard.fix.mockRejectedValue(new Error('bridge'));
    await press(screen.getByText('Fix it'));
    await waitFor(() => expect(mockRouter.push).toHaveBeenCalledWith('/(app)/settings/permissions'));
  });

  test('a refusal from elsewhere shows the same line', async () => {
    showHomeNotice('services');
    await draw(<HomeScreen />);
    expect(await screen.findByText('Location Services are off. Turn them on to record a drive.')).toBeOnTheScreen();
    expect(screen.getByText('Fix it')).toBeOnTheScreen();
  });
});

describe('Analytics and the action items', () => {
  test('the rating block, "All stats" and the tip card open the Analytics tab', async () => {
    mockCoaching = { level: 'poor', axis: 'speeding', title: 'Watch your speed', tip: 'Ease off a little over the limit.' };
    await draw(<HomeScreen />);
    await press(screen.getByTestId('rating-block'));
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

describe('automatic drives and the waiting Start', () => {
  test('with automatic drives on, Start gets its quiet line and How it works says drives record themselves', async () => {
    mockAuto = { state: 'on' };
    await draw(<HomeScreen />);
    expect(screen.getByTestId('start-caption')).toHaveTextContent('Or just drive. RoadWise notices on its own.');
    expect(screen.getByText('Drives record themselves')).toBeOnTheScreen();
  });

  test.each([{ state: 'unsupported' }, { state: 'unknown' }, { state: 'off', missing: ['locationAlways'] }] as AutoDrives[])('%o: the manual words', async (a) => {
    mockAuto = a;
    await draw(<HomeScreen />);
    expect(screen.queryByTestId('start-caption')).toBeNull();
    expect(screen.getByText('Start, then drive')).toBeOnTheScreen();
  });

  test('a Start waiting for the car to move shows the strip in place of Start, like a recording drive', async () => {
    mockWaiting = true;
    await draw(<HomeScreen />);
    expect(screen.getByTestId('drive-in-progress')).toBeOnTheScreen();
    expect(screen.queryByTestId('start-drive')).toBeNull();
  });

  test("an automatic drive that wasn't kept says nothing; a manual one says why", async () => {
    expect(isManualDrop({ clientTripId: 'x', cause: 'stopped', reason: 'not_driven', at: 1, origin: 'auto' } as never)).toBe(false);
    expect(isManualDrop({ clientTripId: 'x', cause: 'stopped', reason: 'not_driven', at: 1, origin: 'manual' } as never)).toBe(true);
    expect(isManualDrop({ clientTripId: 'x', cause: 'stopped', reason: 'not_driven', at: 1 } as never)).toBe(true);
    mockNotice = { clientTripId: 'gone', cause: 'stopped', reason: 'not_driven', at: 1, origin: 'auto' } as never;
    await draw(<HomeScreen />);
    await act(async () => {});
    expect(screen.queryByTestId('drive-dropped')).toBeNull();
  });
});

test('recent drives carry their scores', async () => {
  await draw(<HomeScreen />);
  expect(screen.getByTestId('recent-a1-score')).toHaveTextContent('97');
});

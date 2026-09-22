import { act, fireEvent, render, screen } from '@testing-library/react-native';
import { AccessibilityInfo } from 'react-native';

import { UNKNOWN_LIMIT } from '@/core/detectors/common';
import { DriveProvider } from '@/drive/DriveProvider';
import type { DriveHost, DriveState, LastFinalized } from '@/drive/host';
import { END_WAIT_MS, EndScreen } from '@/features/drive/EndScreen';
import { startCopy as copy } from '@/features/drive/startCopy';
import { attachSummaryNotifier, type SummaryNotificationPort } from '@/features/drive/summaryNotifier';
import { tripSummaryHref } from '@/features/trips/routes';
import { ThemeProvider } from '@/ui';

const mockRouter = { replace: jest.fn(), dismissTo: jest.fn(), back: jest.fn(), canGoBack: () => false };
jest.mock('expo-router', () => ({ useRouter: () => mockRouter }));
// The notifier is given a port here; the real module only warns about Expo Go on import.
jest.mock('expo-notifications', () => ({}));

const T = 1_700_000_000_000;

function state(over: Partial<DriveState> = {}): DriveState {
  return {
    status: 'finalizing',
    mode: 'mounted',
    role: 'driver',
    clientTripId: 'mine',
    startedAt: T,
    lastRowTs: T,
    speedMps: 0,
    speedKnown: true,
    awaitingSpeedAfterResume: false,
    limit: UNKNOWN_LIMIT,
    distanceM: 0,
    stationarySinceTs: null,
    lockedOut: false,
    stoppedPanel: false,
    activeAlert: null,
    mutedForDrive: false,
    gps: 'good',
    thermal: 'nominal',
    callActive: false,
    screenLocked: false,
    lastFinalized: null,
    tripIndex: 0,
    dryRun: false,
    ...over,
  };
}

function stubHost(initial: DriveState) {
  let current = initial;
  const listeners = new Set<(s: DriveState) => void>();
  const host = {
    snapshot: () => current,
    subscribe: (fn: (s: DriveState) => void) => {
      listeners.add(fn);
      return () => listeners.delete(fn);
    },
    isBusy: () => ['candidate', 'recording', 'ending', 'finalizing'].includes(current.status),
  } as unknown as DriveHost;
  return {
    host,
    push(next: Partial<DriveState>) {
      current = { ...current, ...next };
      for (const fn of listeners) fn(current);
    },
  };
}

const saved = (id: string, short = false): LastFinalized => ({
  clientTripId: id,
  ok: true,
  status: 'provisional',
  short,
  at: T,
});

async function renderEnd(host: DriveHost, clientTripId?: string) {
  const r = await render(
    <ThemeProvider>
      <DriveProvider host={host}>
        <EndScreen clientTripId={clientTripId} />
      </DriveProvider>
    </ThemeProvider>
  );
  await act(async () => {});
  return r;
}

beforeEach(() => {
  jest.clearAllMocks();
  jest.useFakeTimers();
  jest.spyOn(AccessibilityInfo, 'isReduceMotionEnabled').mockResolvedValue(false);
});
afterEach(() => {
  jest.useRealTimers();
});

describe('EndScreen (C8)', () => {
  test('while the save is in flight it says so — never "Drive saved" before the answer', async () => {
    const h = stubHost(state());
    await renderEnd(h.host);
    expect(screen.getByText(copy.end.saving)).toBeOnTheScreen();
    expect(screen.queryByText(/saved/i)).toBeNull();
  });

  test('its own trip saved → the summary of that trip', async () => {
    const h = stubHost(state());
    await renderEnd(h.host);
    await act(async () => h.push({ status: 'armed', clientTripId: null, lastFinalized: saved('mine') }));
    expect(mockRouter.replace).toHaveBeenCalledWith(tripSummaryHref('mine'));
  });

  test('ignores a stale lastFinalized carried over from an earlier trip, and waits for its own', async () => {
    const h = stubHost(state({ lastFinalized: saved('earlier') }));
    await renderEnd(h.host);
    expect(mockRouter.replace).not.toHaveBeenCalled();
    expect(screen.getByText(copy.end.saving)).toBeOnTheScreen();
    await act(async () => h.push({ lastFinalized: saved('someone-else') }));
    expect(mockRouter.replace).not.toHaveBeenCalled();
    await act(async () => h.push({ status: 'armed', clientTripId: null, lastFinalized: saved('mine') }));
    expect(mockRouter.replace).toHaveBeenCalledWith(tripSummaryHref('mine'));
  });

  test('its own trip already finalized before the screen mounted (a fast finalize, id passed by the route)', async () => {
    const h = stubHost(state({ status: 'armed', clientTripId: null, lastFinalized: saved('mine') }));
    await renderEnd(h.host, 'mine');
    expect(mockRouter.replace).toHaveBeenCalledWith(tripSummaryHref('mine'));
  });

  test('a short drive: "Short drive saved — too short to score", and Done goes home', async () => {
    const h = stubHost(state());
    await renderEnd(h.host);
    await act(async () => h.push({ status: 'armed', clientTripId: null, lastFinalized: saved('mine', true) }));
    expect(screen.getByRole('header', { name: copy.end.short })).toBeOnTheScreen();
    expect(mockRouter.replace).not.toHaveBeenCalled();
    await fireEvent.press(screen.getByRole('button', { name: copy.end.done }));
    expect(mockRouter.dismissTo).toHaveBeenCalledWith('/(tabs)/home');
  });

  test('ok: false → the honest failure copy and Done', async () => {
    const h = stubHost(state());
    await renderEnd(h.host);
    await act(async () =>
      h.push({ status: 'armed', clientTripId: null, lastFinalized: { clientTripId: 'mine', ok: false, at: T } })
    );
    expect(screen.getByText(copy.end.failed)).toBeOnTheScreen();
    expect(screen.getByRole('button', { name: copy.end.done })).toBeOnTheScreen();
    expect(mockRouter.replace).not.toHaveBeenCalled();
  });

  test('no answer in 10 s → the same honest fallback with Done', async () => {
    const h = stubHost(state());
    await renderEnd(h.host);
    await act(async () => jest.advanceTimersByTime(END_WAIT_MS - 1));
    expect(screen.queryByText(copy.end.failed)).toBeNull();
    await act(async () => jest.advanceTimersByTime(1));
    expect(END_WAIT_MS).toBe(10_000);
    expect(screen.getByText(copy.end.failed)).toBeOnTheScreen();
    expect(screen.getByRole('button', { name: copy.end.done })).toBeOnTheScreen();
  });

  test('a dry run (the parked simulation) never claims a save or a failure', async () => {
    const h = stubHost(state({ dryRun: true }));
    await renderEnd(h.host);
    await act(async () => h.push({ status: 'armed', clientTripId: null }));
    expect(screen.getByRole('header', { name: copy.end.simulation })).toBeOnTheScreen();
    await act(async () => jest.advanceTimersByTime(END_WAIT_MS));
    expect(screen.queryByText(copy.end.failed)).toBeNull();
    expect(mockRouter.replace).not.toHaveBeenCalled();
  });

  test('no trip to wait for (reached with nothing recording): Home, with no claim at all', async () => {
    const h = stubHost(state({ status: 'armed', clientTripId: null, lastFinalized: saved('earlier') }));
    await renderEnd(h.host);
    expect(mockRouter.dismissTo).toHaveBeenCalledWith('/(tabs)/home');
    expect(mockRouter.replace).not.toHaveBeenCalled();
  });

  test('while it is on screen in the foreground, the finalize schedules no notification', async () => {
    const h = stubHost(state({ status: 'recording' }));
    const port: SummaryNotificationPort = {
      permissionGranted: jest.fn(async () => true),
      scheduled: jest.fn(async () => []),
      schedule: jest.fn(async () => {}),
      cancel: jest.fn(async () => {}),
    };
    const n = attachSummaryNotifier(h.host, { port, appState: { currentState: 'active' } });
    h.push({ status: 'finalizing' });
    await renderEnd(h.host);
    h.push({ status: 'armed', clientTripId: null, lastFinalized: saved('mine') });
    jest.useRealTimers();
    await n.settled();
    expect(port.schedule).not.toHaveBeenCalled();
    n.detach();
  });
});

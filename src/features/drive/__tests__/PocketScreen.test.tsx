import { act, fireEvent, render, screen } from '@testing-library/react-native';
import { AppState, StyleSheet } from 'react-native';

import { UNKNOWN_LIMIT } from '@/core/detectors/common';
import { DriveProvider } from '@/drive/DriveProvider';
import type { DriveHost, DriveState } from '@/drive/host';
import { contrastRatio, ThemeProvider } from '@/ui';

import { hudCopy } from '../hudCopy';
import { PocketScreen } from '../PocketScreen';

const mockRouter = { replace: jest.fn(), push: jest.fn() };
jest.mock('expo-router', () => ({
  useRouter: () => mockRouter,
  usePathname: () => '/drive/pocket',
}));

const T = 1_790_000_000_000;
const MPH = 0.44704;

function state(over: Partial<DriveState> = {}): DriveState {
  return {
    status: 'recording',
    mode: 'pocket',
    role: 'driver',
    clientTripId: 't1',
    startedAt: T,
    lastRowTs: T,
    speedMps: 30 * MPH,
    speedKnown: true,
    awaitingSpeedAfterResume: false,
    limit: UNKNOWN_LIMIT,
    distanceM: 0,
    stationarySinceTs: null,
    lockedOut: true,
    stoppedPanel: false,
    activeAlert: null,
    mutedForDrive: false,
    gps: 'good',
    thermal: 'nominal',
    callActive: false,
    screenLocked: false,
    lastFinalized: null,
    tripIndex: 5,
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
    end: jest.fn(async () => {}),
    setPassenger: jest.fn(async () => {}),
    muteForDrive: jest.fn(async () => {}),
    muteCurrentAlert: jest.fn(async () => {}),
  };
  return {
    host,
    async push(next: Partial<DriveState>) {
      current = { ...current, ...next };
      await act(() => {
        for (const fn of listeners) fn(current);
      });
    },
  };
}

async function renderPocket(over: Partial<DriveState> = {}) {
  const h = stubHost(state(over));
  await render(
    <ThemeProvider scheme="light">
      <DriveProvider host={h.host as unknown as DriveHost}>
        <PocketScreen />
      </DriveProvider>
    </ThemeProvider>
  );
  return h;
}

beforeAll(() => {
  (AppState as { currentState: string }).currentState = 'active';
});
beforeEach(() => {
  jest.useFakeTimers();
  jest.clearAllMocks();
});
afterEach(() => jest.useRealTimers());

describe('PocketScreen (C4c)', () => {
  test('near-black with a dim but legible "Recording"', async () => {
    await renderPocket();
    const root = StyleSheet.flatten(screen.getByTestId('pocket-screen').props.style);
    expect(root.backgroundColor).toBe('#000000');
    const label = screen.getByText(hudCopy.pocket.recording);
    const ink = StyleSheet.flatten(label.props.style).color as string;
    const ratio = contrastRatio(ink, '#000000');
    expect(ratio).toBeGreaterThanOrEqual(4.5);
    expect(ratio).toBeLessThan(10); // dim: well below the HUD's white numerals
  });

  test('"Recording" only while recording; the gap window says "Stopped"', async () => {
    const h = await renderPocket();
    expect(screen.getByText(hudCopy.pocket.recording)).toBeTruthy();
    await h.push({ status: 'ending', lockedOut: false, speedMps: 0 });
    expect(screen.queryByText(hudCopy.pocket.recording)).toBeNull();
    expect(screen.getByText(hudCopy.pocket.stopped)).toBeTruthy();
  });

  test('a passenger trip says so', async () => {
    await renderPocket({ role: 'passenger', lockedOut: false });
    expect(screen.getByText(hudCopy.pocket.passenger)).toBeTruthy();
  });

  test('a tap while moving does nothing', async () => {
    await renderPocket({ lockedOut: true });
    await fireEvent.press(screen.getByTestId('pocket-tap-area'));
    expect(screen.queryByRole('button', { name: hudCopy.stopped.endDrive })).toBeNull();
  });

  test('the stopped panel stays hidden in the pocket until a tap asks for it', async () => {
    await renderPocket({ lockedOut: false, stoppedPanel: true, speedMps: 0, stationarySinceTs: T });
    expect(screen.queryByRole('button', { name: hudCopy.stopped.endDrive })).toBeNull();
    await fireEvent.press(screen.getByTestId('pocket-tap-area'));
    expect(screen.getByRole('button', { name: hudCopy.stopped.endDrive })).toBeTruthy();
  });

  test('End drive from the revealed panel routes to the end screen and ends the drive', async () => {
    const h = await renderPocket({
      lockedOut: false,
      stoppedPanel: true,
      speedMps: 0,
      stationarySinceTs: T,
    });
    await fireEvent.press(screen.getByTestId('pocket-tap-area'));
    await fireEvent.press(screen.getByRole('button', { name: hudCopy.stopped.endDrive }));
    await act(() => jest.advanceTimersByTime(300));
    expect(mockRouter.replace).toHaveBeenCalledWith('/drive/end');
    expect(h.host.end).toHaveBeenCalledTimes(1);
  });

  test('the revealed panel goes away as the car moves off', async () => {
    const h = await renderPocket({
      lockedOut: false,
      stoppedPanel: true,
      speedMps: 0,
      stationarySinceTs: T,
    });
    await fireEvent.press(screen.getByTestId('pocket-tap-area'));
    await h.push({
      stoppedPanel: false,
      speedMps: 8 * MPH,
      stationarySinceTs: null,
      lockedOut: true,
    });
    expect(screen.queryByRole('button', { name: hudCopy.stopped.endDrive })).toBeNull();
    // Stopping again does not bring it back on its own; it waits for a new tap.
    await h.push({ stoppedPanel: true, speedMps: 0, stationarySinceTs: T, lockedOut: false });
    expect(screen.queryByRole('button', { name: hudCopy.stopped.endDrive })).toBeNull();
  });

  test('finalizing replaces the pocket screen with the end screen', async () => {
    const h = await renderPocket({ lockedOut: false });
    await h.push({ status: 'finalizing' });
    expect(mockRouter.replace).toHaveBeenCalledWith('/drive/end');
  });
});

import { act, fireEvent, render, screen } from '@testing-library/react-native';
import { AppState } from 'react-native';

import { UNKNOWN_LIMIT } from '@/core/detectors/common';
import { DriveProvider } from '@/drive/DriveProvider';
import type { DriveHost, DriveState } from '@/drive/host';
import { ThemeProvider } from '@/ui';

import { DriveInProgressBanner } from '../DriveInProgressBanner';
import { hudCopy } from '../hudCopy';

const mockRouter = { replace: jest.fn(), push: jest.fn() };
jest.mock('expo-router', () => ({ useRouter: () => mockRouter, usePathname: () => '/home' }));

const T = 1_790_000_000_000;
const MPH = 0.44704;

function state(over: Partial<DriveState> = {}): DriveState {
  return {
    status: 'recording',
    mode: 'auto',
    role: 'driver',
    clientTripId: 't1',
    startedAt: T,
    lastRowTs: T,
    speedMps: 0,
    speedKnown: true,
    awaitingSpeedAfterResume: false,
    limit: UNKNOWN_LIMIT,
    distanceM: 0,
    stationarySinceTs: T,
    lockedOut: false,
    stoppedPanel: true,
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

async function renderBanner(over: Partial<DriveState> = {}) {
  let current = state(over);
  const listeners = new Set<(s: DriveState) => void>();
  const order: string[] = [];
  const host = {
    snapshot: () => current,
    subscribe: (fn: (s: DriveState) => void) => {
      listeners.add(fn);
      return () => listeners.delete(fn);
    },
    end: jest.fn(async () => {
      order.push('end');
    }),
    setPassenger: jest.fn(async () => {}),
    setMode: jest.fn(async () => {
      order.push('setMode');
    }),
  };
  mockRouter.push.mockImplementation((path: string) => order.push(`push ${path}`));
  await render(
    <ThemeProvider scheme="light">
      <DriveProvider host={host as unknown as DriveHost}>
        <DriveInProgressBanner />
      </DriveProvider>
    </ThemeProvider>
  );
  return {
    host,
    order,
    async push(next: Partial<DriveState>) {
      current = { ...current, ...next };
      await act(() => {
        for (const fn of listeners) fn(current);
      });
    },
  };
}

beforeAll(() => {
  (AppState as { currentState: string }).currentState = 'active';
});
beforeEach(() => jest.clearAllMocks());

describe('DriveInProgressBanner (rev1 I10)', () => {
  test.each([
    ['armed', {}],
    ['off', { status: 'off' as const }],
    ['a candidate (not yet a drive)', { status: 'candidate' as const }],
    ['finalizing', { status: 'finalizing' as const }],
  ])('hidden when %s', async (_name, over) => {
    await renderBanner({ status: 'armed', ...over });
    expect(screen.queryByText(hudCopy.banner.title)).toBeNull();
  });

  test('hidden while locked out (the gate covers the screen then)', async () => {
    await renderBanner({
      lockedOut: true,
      speedMps: 30 * MPH,
      stationarySinceTs: null,
      stoppedPanel: false,
    });
    expect(screen.queryByText(hudCopy.banner.title)).toBeNull();
  });

  test('rolling slowly: "Drive in progress" with Open HUD only — no passenger, no end', async () => {
    await renderBanner({ speedMps: 3 * MPH, stationarySinceTs: null, stoppedPanel: false });
    expect(screen.getByText(hudCopy.banner.title)).toBeTruthy();
    expect(screen.getByRole('button', { name: hudCopy.banner.openHud })).toBeTruthy();
    expect(screen.queryByRole('button', { name: hudCopy.banner.passenger })).toBeNull();
    expect(screen.queryByRole('button', { name: hudCopy.banner.endDrive })).toBeNull();
    expect(screen.queryByRole('button', { name: hudCopy.banner.useMounted })).toBeNull();
  });

  test("stationary: I'm a passenger tells the host, and nothing changes the mode", async () => {
    const b = await renderBanner();
    await fireEvent.press(screen.getByRole('button', { name: hudCopy.banner.passenger }));
    expect(b.host.setPassenger).toHaveBeenCalledWith(true);
    expect(b.host.setMode).not.toHaveBeenCalled();
  });

  test("a passenger is offered I'm driving", async () => {
    const b = await renderBanner({ role: 'passenger' });
    expect(screen.getByText(hudCopy.banner.passengerStamp)).toBeTruthy();
    await fireEvent.press(screen.getByRole('button', { name: hudCopy.banner.driving }));
    expect(b.host.setPassenger).toHaveBeenCalledWith(false);
  });

  test('Open HUD opens the HUD without changing the mode', async () => {
    const b = await renderBanner({ mode: 'pocket' });
    await fireEvent.press(screen.getByRole('button', { name: hudCopy.banner.openHud }));
    expect(mockRouter.push).toHaveBeenCalledWith('/drive/hud');
    expect(b.host.setMode).not.toHaveBeenCalled();
  });

  test('only "Use as mounted HUD" sets mounted mode, then opens the HUD', async () => {
    const b = await renderBanner({ mode: 'auto' });
    await act(async () => {
      await fireEvent.press(screen.getByRole('button', { name: hudCopy.banner.useMounted }));
    });
    expect(b.host.setMode).toHaveBeenCalledWith('mounted');
    expect(b.order).toEqual(['setMode', 'push /drive/hud']);
  });

  test('a mounted trip is not offered "Use as mounted HUD"', async () => {
    await renderBanner({ mode: 'mounted' });
    expect(screen.queryByRole('button', { name: hudCopy.banner.useMounted })).toBeNull();
  });

  test('End drive (stationary) opens the end screen first, then ends the drive', async () => {
    const b = await renderBanner();
    await act(async () => {
      await fireEvent.press(screen.getByRole('button', { name: hudCopy.banner.endDrive }));
    });
    expect(b.order).toEqual(['push /drive/end', 'end']);
  });

  test('the gap window (ending) counts as stationary', async () => {
    await renderBanner({ status: 'ending', stoppedPanel: false });
    expect(screen.getByRole('button', { name: hudCopy.banner.endDrive })).toBeTruthy();
  });

  test('stationary controls vanish as the car moves off', async () => {
    const b = await renderBanner();
    await b.push({ speedMps: 4 * MPH, stationarySinceTs: null, stoppedPanel: false });
    expect(screen.queryByRole('button', { name: hudCopy.banner.endDrive })).toBeNull();
    expect(screen.queryByRole('button', { name: hudCopy.banner.passenger })).toBeNull();
  });

  test('controls meet the 44 pt floor', async () => {
    await renderBanner();
    for (const b of screen.getAllByRole('button')) {
      const style =
        typeof b.props.style === 'function' ? b.props.style({ pressed: false }) : b.props.style;
      expect(style.minHeight).toBeGreaterThanOrEqual(44);
    }
  });
});

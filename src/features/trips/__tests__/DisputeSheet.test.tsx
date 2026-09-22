import { act, render, screen } from '@testing-library/react-native';
import { AppState } from 'react-native';

import { UNKNOWN_LIMIT } from '@/core/detectors/common';
import { DriveProvider } from '@/drive/DriveProvider';
import type { DriveHost, DriveState } from '@/drive/host';
import { ThemeProvider } from '@/ui';

import { tripCopy } from '../copy';
import { DisputeSheet, parseStatedLimit } from '../DisputeSheet';

function state(over: Partial<DriveState> = {}): DriveState {
  return {
    status: 'recording',
    mode: 'auto',
    role: 'driver',
    clientTripId: 't1',
    startedAt: 1,
    lastRowTs: 1,
    speedMps: 0,
    speedKnown: true,
    awaitingSpeedAfterResume: false,
    limit: UNKNOWN_LIMIT,
    distanceM: 0,
    stationarySinceTs: 1,
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

const sheet = (
  <DisputeSheet
    visible
    busy={false}
    failed={false}
    onSubmit={() => {}}
    onNotDriver={() => {}}
    onClose={() => {}}
    testID="dispute-sheet"
  />
);

beforeAll(() => {
  (AppState as { currentState: string }).currentState = 'active';
});

describe('DisputeSheet', () => {
  test('parseStatedLimit keeps an out-of-range limit visible rather than dropping it', async () => {
    expect(parseStatedLimit('')).toBeUndefined();
    expect(parseStatedLimit('35')).toBe(35);
    expect(parseStatedLimit('500')).toBe('out_of_range');
  });

  test('opens with no drive runtime at all (screens outside the drive provider)', async () => {
    await render(<ThemeProvider scheme="light">{sheet}</ThemeProvider>);
    expect(screen.getByTestId('dispute-sheet').props.visible).toBe(true);
    expect(screen.getByText(tripCopy.dispute.title)).toBeTruthy();
  });

  test('closes the moment the driving lockout begins (rev1 I12), and may open again once stopped', async () => {
    let current = state();
    const listeners = new Set<(s: DriveState) => void>();
    const host = {
      snapshot: () => current,
      subscribe: (fn: (s: DriveState) => void) => {
        listeners.add(fn);
        return () => listeners.delete(fn);
      },
    } as unknown as DriveHost;
    const push = async (next: Partial<DriveState>) => {
      current = { ...current, ...next };
      await act(() => {
        for (const fn of listeners) fn(current);
      });
    };
    await render(
      <ThemeProvider scheme="light">
        <DriveProvider host={host}>{sheet}</DriveProvider>
      </ThemeProvider>
    );
    expect(screen.getByTestId('dispute-sheet').props.visible).toBe(true);
    await push({ lockedOut: true, speedMps: 20, stoppedPanel: false, stationarySinceTs: null });
    // React Native's Jest Modal renders nothing while not visible.
    expect(screen.queryByTestId('dispute-sheet', { includeHiddenElements: true })).toBeNull();
    expect(screen.queryByText(tripCopy.dispute.title)).toBeNull();
    await push({ lockedOut: false, speedMps: 0 });
    expect(screen.getByTestId('dispute-sheet').props.visible).toBe(true);
  });
});

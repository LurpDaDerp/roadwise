import { act, render, screen } from '@testing-library/react-native';
import { AppState, StyleSheet } from 'react-native';

import { UNKNOWN_LIMIT } from '@/core/detectors/common';
import { DriveProvider } from '@/drive/DriveProvider';
import type { DriveHost, DriveState } from '@/drive/host';
import { contrastRatio, ThemeProvider } from '@/ui';
import { countWords } from '@/ui/drive';

import { hudCopy } from '../hudCopy';
import { ParkedOnlyCard } from '../ParkedOnlyCard';

function state(over: Partial<DriveState> = {}): DriveState {
  return {
    status: 'recording',
    mode: 'auto',
    role: 'driver',
    clientTripId: 't1',
    startedAt: 1,
    lastRowTs: 1,
    speedMps: 20,
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

async function renderCard(over: Partial<DriveState> = {}) {
  let current = state(over);
  const listeners = new Set<(s: DriveState) => void>();
  const host = {
    snapshot: () => current,
    subscribe: (fn: (s: DriveState) => void) => {
      listeners.add(fn);
      return () => listeners.delete(fn);
    },
  } as unknown as DriveHost;
  await render(
    <ThemeProvider scheme="light">
      <DriveProvider host={host}>
        <ParkedOnlyCard />
      </DriveProvider>
    </ThemeProvider>
  );
  return async (next: Partial<DriveState>) => {
    current = { ...current, ...next };
    await act(() => {
      for (const fn of listeners) fn(current);
    });
  };
}

beforeAll(() => {
  (AppState as { currentState: string }).currentState = 'active';
});

describe('ParkedOnlyCard (SR8)', () => {
  test('says the app is available when parked, in at most three words, and nothing else to do', async () => {
    await renderCard();
    const title = screen.getByText(hudCopy.parked.title);
    expect(countWords(hudCopy.parked.title)).toBeLessThanOrEqual(3);
    expect(StyleSheet.flatten(title.props.style).fontSize).toBeGreaterThanOrEqual(28);
    expect(screen.queryByRole('button')).toBeNull();
  });

  test('true black, legible print', async () => {
    await renderCard();
    const root = StyleSheet.flatten(screen.getByTestId('parked-only-card').props.style);
    expect(root.backgroundColor).toBe('#000000');
    const ink = StyleSheet.flatten(screen.getByText(hudCopy.parked.title).props.style)
      .color as string;
    expect(contrastRatio(ink, '#000000')).toBeGreaterThanOrEqual(7);
  });

  test('the recording line follows the engine: shown while recording only', async () => {
    const push = await renderCard();
    expect(screen.getByText(hudCopy.parked.recording)).toBeTruthy();
    expect(screen.getByTestId('parked-only-card').props.accessibilityLabel).toBe(
      hudCopy.parked.labelRecording
    );
    await push({ status: 'ending' });
    expect(screen.queryByText(hudCopy.parked.recording)).toBeNull();
    expect(screen.getByTestId('parked-only-card').props.accessibilityLabel).toBe(
      hudCopy.parked.label
    );
  });

  test('announces itself to a screen reader as one element', async () => {
    await renderCard();
    expect(screen.getByTestId('parked-only-card').props.accessible).toBe(true);
  });
});

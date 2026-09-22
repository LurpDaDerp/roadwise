import { act, render, screen } from '@testing-library/react-native';
import { AppState, Text } from 'react-native';

import { UNKNOWN_LIMIT } from '@/core/detectors/common';
import { DriveProvider } from '@/drive/DriveProvider';
import type { DriveHost, DriveState } from '@/drive/host';
import { createDriveStore } from '@/drive/store';
import { useDrive, useDriveHost } from '@/drive/useDrive';

const T = 1_700_000_000_000;

function state(over: Partial<DriveState> = {}): DriveState {
  return {
    status: 'recording',
    mode: 'mounted',
    role: 'driver',
    clientTripId: 't',
    startedAt: T,
    lastRowTs: T,
    speedMps: 10,
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
    tripIndex: 0,
    dryRun: false,
    ...over,
  };
}

/** Just enough host for the store: a snapshot and a subscription it can push through. */
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
  } as unknown as DriveHost;
  return {
    host,
    push(next: Partial<DriveState>) {
      current = { ...current, ...next };
      for (const fn of listeners) fn(current);
    },
    listeners: () => listeners.size,
  };
}

function fakeAppState(initial: string) {
  const listeners = new Set<(s: string) => void>();
  const api = {
    currentState: initial as string | null,
    addEventListener(_type: 'change', fn: (s: string) => void) {
      listeners.add(fn);
      return { remove: () => listeners.delete(fn) };
    },
    set(s: string) {
      api.currentState = s;
      for (const fn of listeners) fn(s);
    },
    count: () => listeners.size,
  };
  return api;
}

describe('createDriveStore', () => {
  test('publishes every host change while the app is active', () => {
    const h = stubHost(state());
    const app = fakeAppState('active');
    const store = createDriveStore(h.host, app);
    h.push({ speedMps: 11 });
    h.push({ speedMps: 12 });
    expect(store.getState().speedMps).toBe(12);
  });

  test('backgrounded: status changes only; the rest catches up on return', () => {
    const h = stubHost(state());
    const app = fakeAppState('background');
    const store = createDriveStore(h.host, app);
    const seen: DriveState[] = [];
    store.subscribe((s) => seen.push(s));
    h.push({ speedMps: 11 });
    h.push({ speedMps: 12, lastRowTs: T + 2000 });
    expect(seen).toHaveLength(0);
    expect(store.getState().speedMps).toBe(10);
    h.push({ status: 'ending' });
    expect(seen).toHaveLength(1);
    expect(store.getState().status).toBe('ending');
    h.push({ speedMps: 0 });
    expect(seen).toHaveLength(1);
    app.set('active');
    expect(store.getState()).toMatchObject({ status: 'ending', speedMps: 0 });
    h.push({ speedMps: 3 });
    expect(store.getState().speedMps).toBe(3);
  });

  test('dispose unsubscribes from the host and the app state', () => {
    const h = stubHost(state());
    const app = fakeAppState('active');
    const store = createDriveStore(h.host, app);
    expect(h.listeners()).toBe(1);
    expect(app.count()).toBe(1);
    store.dispose();
    expect(h.listeners()).toBe(0);
    expect(app.count()).toBe(0);
  });
});

describe('DriveProvider and the hooks', () => {
  function Speed() {
    const speed = useDrive((s) => s.speedMps);
    return <Text testID="speed">{speed}</Text>;
  }
  let objectRenders = 0;
  function Flags() {
    const { status, lockedOut } = useDrive((s) => ({ status: s.status, lockedOut: s.lockedOut }));
    objectRenders += 1;
    return <Text testID="flags">{`${status}:${String(lockedOut)}`}</Text>;
  }
  let seenHost: DriveHost | null = null;
  function HostReader() {
    seenHost = useDriveHost();
    return null;
  }

  test('a selector re-renders on its own slice; an object selector is shallow-compared', async () => {
    // RoadWise in front, whatever the react-native mock starts with.
    Object.defineProperty(AppState, 'currentState', { value: 'active', configurable: true, writable: true });
    const h = stubHost(state());
    await render(
      <DriveProvider host={h.host}>
        <Speed />
        <Flags />
        <HostReader />
      </DriveProvider>
    );
    expect(screen.getByTestId('speed').props.children).toBe(10);
    expect(screen.getByTestId('flags').props.children).toBe('recording:true');
    expect(seenHost).toBe(h.host);
    const before = objectRenders;
    await act(async () => {
      h.push({ speedMps: 14 });
    });
    expect(screen.getByTestId('speed').props.children).toBe(14);
    // The object selector's slice did not change, so it did not re-render (rev1: m).
    expect(objectRenders).toBe(before);
    await act(async () => {
      h.push({ status: 'ending', lockedOut: false });
    });
    expect(screen.getByTestId('flags').props.children).toBe('ending:false');
  });

  test('the hooks refuse to run outside the provider', async () => {
    const spy = jest.spyOn(console, 'error').mockImplementation(() => {});
    await expect(render(<Speed />)).rejects.toThrow(/DriveProvider/);
    spy.mockRestore();
  });
});

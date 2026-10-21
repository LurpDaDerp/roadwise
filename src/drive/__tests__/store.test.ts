import type { AppStateLike } from '@/data/foreground';
import type { DriveHost, DriveState } from '@/drive/host';
import { createDriveStore } from '@/drive/store';

function hostStub(initial: Partial<DriveState>) {
  let s = { status: 'idle', lockedOut: false, speedMps: 0 } as DriveState;
  s = { ...s, ...initial };
  const listeners = new Set<(s: DriveState) => void>();
  const host = {
    snapshot: () => s,
    subscribe: (fn: (s: DriveState) => void) => {
      listeners.add(fn);
      return () => listeners.delete(fn);
    },
  } as unknown as DriveHost;
  const set = (over: Partial<DriveState>) => {
    s = { ...s, ...over };
    for (const fn of listeners) fn(s);
  };
  return { host, set, listeners };
}

function appState(initial: string): AppStateLike & { set(next: string): void } {
  const listeners = new Set<(state: string) => void>();
  return {
    currentState: initial,
    addEventListener: (_t, l) => {
      listeners.add(l);
      return { remove: () => listeners.delete(l) };
    },
    set(next) {
      this.currentState = next;
      for (const l of [...listeners]) l(next);
    },
  };
}

test('in front every host change is published; in the background only status and lockedOut; the store catches up on active', () => {
  const h = hostStub({});
  const app = appState('background');
  const store = createDriveStore(h.host, app);
  let renders = 0;
  store.subscribe(() => (renders += 1));
  h.set({ status: 'recording' });
  h.set({ speedMps: 10 });
  h.set({ speedMps: 11 });
  expect(renders).toBe(1);
  expect(store.getState().speedMps).toBe(0);
  h.set({ lockedOut: true });
  expect(renders).toBe(2);
  expect(store.getState().speedMps).toBe(11);
  app.set('active'); // already current: nothing to publish
  expect(renders).toBe(2);
  h.set({ speedMps: 12 });
  expect(renders).toBe(3);
  store.dispose();
  h.set({ speedMps: 13 });
  expect(renders).toBe(3);
  store.resume();
  expect(store.getState().speedMps).toBe(13);
  expect(h.listeners.size).toBe(1);
});

test('in the background the wait, its phase, the "Not driving?" offer and the weather kind are published too', () => {
  const h = hostStub({ waiting: null, notDrivingAvailable: false, weather: null });
  const app = appState('background');
  const store = createDriveStore(h.host, app);
  let renders = 0;
  store.subscribe(() => (renders += 1));
  const wait = { since: 1, phase: 'waiting' as const, deadlineAt: 2, speedMps: null, limitMph: null };
  h.set({ waiting: wait });
  expect(renders).toBe(1);
  h.set({ waiting: { ...wait, speedMps: 3 } });
  expect(renders).toBe(1);
  h.set({ waiting: { ...wait, phase: 'popup' } });
  expect(renders).toBe(2);
  h.set({ waiting: null, status: 'recording', notDrivingAvailable: true });
  expect(renders).toBe(3);
  h.set({ notDrivingAvailable: false });
  expect(renders).toBe(4);
  h.set({ weather: { kind: 'heavy_rain', text: 'Heavy rain' } });
  expect(renders).toBe(5);
  store.dispose();
});

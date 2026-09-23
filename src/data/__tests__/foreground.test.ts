/** @jest-environment node */
import { createSqlJsDb } from '@/data/db/__fixtures__/sqljsDriver';
import type { Db } from '@/data/db/driver';
import { migrate } from '@/data/db/migrate';
import { createSettingsRepo } from '@/data/db/settings';
import { foregroundStampKey, runWhenForeground, type AppStateLike } from '@/data/foreground';

const HOUR = 3600 * 1000;
const T0 = Date.UTC(2026, 8, 21, 9, 0, 0);

interface FakeAppState extends AppStateLike {
  emit(state: string): void;
  listeners: number;
}

function appState(currentState?: string): FakeAppState {
  const listeners = new Set<(state: string) => void>();
  return {
    currentState,
    get listeners() {
      return listeners.size;
    },
    addEventListener(_type, listener) {
      listeners.add(listener);
      return { remove: () => listeners.delete(listener) };
    },
    emit(state) {
      this.currentState = state;
      for (const listener of [...listeners]) listener(state);
    },
  };
}

/**
 * Let the settings reads and the job's promise settle. The sql.js driver and the job are promise-only, so
 * the whole attempt is microtasks; each `setImmediate` turn drains them all. It was `setTimeout(0)`, which
 * waits out the OS timer resolution (about 15.6 ms on Windows) on each of the 20 turns: the transition test
 * spent almost 4 s idle in its 12 settles, and past its 5 s timeout under load (the full-suite flake).
 */
async function settle(): Promise<void> {
  for (let i = 0; i < 20; i += 1) {
    await new Promise<void>((resolve) => {
      setImmediate(resolve);
    });
  }
}

let db: Db;
let clock: number;

beforeEach(async () => {
  db = await createSqlJsDb();
  await migrate(db);
  clock = T0;
});

test('runs on a transition to active, then not again until the interval has passed', async () => {
  const app = appState('background');
  let runs = 0;
  const off = runWhenForeground('job', 6 * HOUR, async () => {
    runs += 1;
  }, { appState: app, now: () => clock, db });

  await settle();
  expect(runs).toBe(0);

  app.emit('active');
  await settle();
  expect(runs).toBe(1);
  await expect(createSettingsRepo(db).get(foregroundStampKey('job'))).resolves.toBe(T0);

  // Ten more foregrounds inside the window: nothing.
  for (let i = 0; i < 10; i += 1) {
    clock += 10 * 60 * 1000;
    app.emit('background');
    app.emit('active');
    await settle();
  }
  expect(runs).toBe(1);

  clock = T0 + 6 * HOUR;
  app.emit('active');
  await settle();
  expect(runs).toBe(2);
  off();
});

test('the throttle survives a new registration, because it lives in settings', async () => {
  const app = appState('active');
  let runs = 0;
  const job = async () => {
    runs += 1;
  };
  const off = runWhenForeground('job', 6 * HOUR, job, { appState: app, now: () => clock, db });
  await settle();
  expect(runs).toBe(1);
  off();

  clock += HOUR;
  const again = runWhenForeground('job', 6 * HOUR, job, { appState: app, now: () => clock, db });
  await settle();
  expect(runs).toBe(1);
  again();
});

test('never runs while the app is not active — background, inactive, or unknown', async () => {
  let runs = 0;
  const job = async () => {
    runs += 1;
  };
  for (const state of ['background', 'inactive', undefined]) {
    const app = appState(state);
    const off = runWhenForeground('job', HOUR, job, { appState: app, now: () => clock, db });
    await settle();
    app.emit('background');
    app.emit('inactive');
    await settle();
    off();
  }
  expect(runs).toBe(0);
});

test('an app that leaves the foreground before the job starts does not run it', async () => {
  const app = appState('background');
  let runs = 0;
  const off = runWhenForeground('job', HOUR, async () => {
    runs += 1;
  }, { appState: app, now: () => clock, db });
  // Active, then straight back to the background inside the settings read.
  app.emit('active');
  app.emit('background');
  await settle();
  expect(runs).toBe(0);
  off();
});

test('a job that fails stamps nothing and is tried again at the next foreground', async () => {
  const app = appState('background');
  let attempts = 0;
  const errors: string[] = [];
  const off = runWhenForeground(
    'job',
    6 * HOUR,
    async () => {
      attempts += 1;
      if (attempts === 1) throw new Error('offline');
    },
    { appState: app, now: () => clock, db, onError: (_e, ctx) => errors.push(ctx) }
  );
  app.emit('active');
  await settle();
  expect(attempts).toBe(1);
  expect(errors).toEqual(['foreground job job']);
  await expect(createSettingsRepo(db).get(foregroundStampKey('job'))).resolves.toBeNull();

  app.emit('active');
  await settle();
  expect(attempts).toBe(2);
  off();
});

test('a foreground during a run does not start a second one; unsubscribing detaches', async () => {
  const app = appState('background');
  let release: () => void = () => undefined;
  let runs = 0;
  const off = runWhenForeground('job', 0, async () => {
    runs += 1;
    await new Promise<void>((resolve) => {
      release = resolve;
    });
  }, { appState: app, now: () => clock, db });
  app.emit('active');
  await settle();
  app.emit('active');
  await settle();
  expect(runs).toBe(1);
  release();
  await settle();

  off();
  expect(app.listeners).toBe(0);
  app.emit('active');
  await settle();
  expect(runs).toBe(1);
});

import { act, fireEvent, render, screen } from '@testing-library/react-native';
import { Text } from 'react-native';

import type { AlertDecision } from '@/core/alerts/types';
import type { Db } from '@/data/db';
import { createTestDb, seedTrips } from '@/data/queries/__fixtures__/harness';
import { tripRow } from '@/data/queries/__fixtures__/rows';
import { DataProvider } from '@/data/queries/context';
import { useDrive } from '@/drive/useDrive';
import { ThemeProvider } from '@/ui';

import { corridorOf, createFakeLimits, FAKE_TILE_DELAY_LOOKUPS } from '../fakeLimits';
import {
  countTables,
  createSimulation,
  loadSimTrace,
  SimulationPanel,
  type SimulationOutcome,
} from '../SimulationPanel';

const TRACKED = ['trips', 'samples', 'trip_events', 'settings', 'sync_queue', 'speed_limit_tiles'] as const;

let db: Db;
beforeEach(async () => {
  db = await createTestDb();
  // A driver with history and a stored tile: the simulation must leave both exactly as found.
  await seedTrips(db, [tripRow({ client_trip_id: 'real-1' })]);
  await db.execute(
    "INSERT INTO speed_limit_tiles (tile_key, expires_at, segments_json) VALUES ('14/1/1', 9999999999999, '[]')"
  );
});

afterEach(() => {
  jest.useRealTimers();
});

function fakePlayer() {
  return {
    deliver: jest.fn(async (_d: AlertDecision) => {}),
    stopCurrent: jest.fn(async () => {}),
    announce: jest.fn(async () => {}),
  };
}

/** Run timers until `p` settles (the replay paces itself on setTimeout). */
async function runToEnd<T>(p: Promise<T>): Promise<T> {
  let done = false;
  let value: T | undefined;
  void p.then((v) => {
    done = true;
    value = v;
  });
  for (let i = 0; i < 2000 && !done; i += 1) {
    await jest.advanceTimersByTimeAsync(250);
  }
  if (!done) throw new Error('the simulation never finished');
  return value as T;
}

describe('fakeLimits', () => {
  const trace = loadSimTrace('speeding-corrected');

  test('answers the corridor limit at a trace position after the tile delay, and "—" before it', () => {
    const limits = createFakeLimits(corridorOf(trace));
    const r = trace.rows[40]!;
    const opts = { gnssValid: true, speedMps: r.speed };
    for (let i = 0; i < FAKE_TILE_DELAY_LOOKUPS; i += 1) {
      expect(limits.lookup(r.lat, r.lng, r.course, opts)).toBeNull();
    }
    expect(limits.lookup(r.lat, r.lng, r.course, opts)).toMatchObject({
      limitMps: trace.limits[0]!.limitMps,
      source: 'posted',
    });
  });

  test('off the corridor it is loaded-but-unknown; an invalid fix is null', () => {
    const limits = createFakeLimits(corridorOf(trace), { tileDelayLookups: 0 });
    expect(limits.lookup(10, 10, 90, { gnssValid: true, speedMps: 10 })).toMatchObject({
      source: 'unknown',
      limitMps: null,
    });
    const r = trace.rows[40]!;
    expect(limits.lookup(r.lat, r.lng, r.course, { gnssValid: false, speedMps: null })).toBeNull();
  });

  test('never asks anything of the network or SQLite', async () => {
    const limits = createFakeLimits(corridorOf(trace));
    limits.startTrip(0, 0, 0);
    limits.prefetch(0, 0, 0);
    expect(await limits.purgeExpired()).toBe(0);
    expect(limits.stats().requestsThisTrip).toBe(0);
  });
});

describe('createSimulation (a dry-run host over a fixture trace)', () => {
  test.each(['speeding-corrected', 'phone-pickup'] as const)(
    '%s at 5x: rows flow through the real host, alerts reach the player, and nothing is stored',
    async (name) => {
      const before = await countTables(db);
      const player = fakePlayer();
      jest.useFakeTimers();
      const sim = createSimulation({ db, trace: loadSimTrace(name), speed: 5, player: () => player });
      expect(sim.host.snapshot().dryRun).toBe(true);
      const outcome: SimulationOutcome = await runToEnd(sim.run());
      jest.useRealTimers();

      expect(outcome.cancelled).toBe(false);
      expect(outcome.rowsPlayed).toBe(150);
      expect(player.deliver).toHaveBeenCalled();
      expect(sim.host.snapshot().lastFinalized).toBeNull();
      // The sql.js assert the brief names: no trip, no sample, no tile — and nothing else either.
      const after = await countTables(db);
      expect(after).toEqual(before);
      for (const t of TRACKED) expect(after[t]).toBe(before[t]);
      expect(outcome.unchanged).toBe(true);
      expect(outcome.before).toEqual(before);
    }
  );

  test('at 1x a row takes a second; at 5x a fifth of one', async () => {
    jest.useFakeTimers();
    const slow = createSimulation({ db, trace: loadSimTrace('phone-pickup'), speed: 1, player: fakePlayer });
    void slow.run();
    await jest.advanceTimersByTimeAsync(10_050);
    const slowRows = slow.rowsPlayed();
    slow.cancel();
    const fast = createSimulation({ db, trace: loadSimTrace('phone-pickup'), speed: 5, player: fakePlayer });
    void fast.run();
    await jest.advanceTimersByTimeAsync(10_050);
    const fastRows = fast.rowsPlayed();
    fast.cancel();
    await jest.advanceTimersByTimeAsync(1000);
    expect(slowRows).toBeGreaterThanOrEqual(9);
    expect(slowRows).toBeLessThanOrEqual(10);
    expect(fastRows).toBeGreaterThanOrEqual(45);
    expect(fastRows).toBeLessThanOrEqual(50);
  });

  test('cancel stops the replay, ends the drive and still stores nothing', async () => {
    const before = await countTables(db);
    jest.useFakeTimers();
    const sim = createSimulation({ db, trace: loadSimTrace('speeding-corrected'), speed: 1, player: fakePlayer });
    const run = sim.run();
    await jest.advanceTimersByTimeAsync(20_000);
    expect(sim.host.snapshot().status).toBe('recording');
    sim.cancel();
    const outcome = await runToEnd(run);
    jest.useRealTimers();
    expect(outcome.cancelled).toBe(true);
    expect(outcome.rowsPlayed).toBeLessThan(150);
    expect(sim.host.isBusy()).toBe(false);
    expect(await countTables(db)).toEqual(before);
  });
});

describe('SimulationPanel', () => {
  /** A stand-in HUD that reads the provider it is rendered under. */
  function StubHud() {
    const s = useDrive((d) => ({ status: d.status, speed: d.speedMps, dryRun: d.dryRun }));
    return <Text testID="stub-hud">{`${s.status} ${s.dryRun ? 'dry' : 'real'}`}</Text>;
  }

  async function renderPanel(player = fakePlayer()) {
    await render(
      <ThemeProvider>
        <DataProvider db={db}>
          <SimulationPanel Hud={StubHud} createPlayer={async () => player} />
        </DataProvider>
      </ThemeProvider>
    );
    return player;
  }

  test('swaps in a dry-run host under the HUD, and says nothing was stored once it checked', async () => {
    await renderPanel();
    await fireEvent.press(screen.getByRole('button', { name: /5×/ }));
    jest.useFakeTimers();
    await fireEvent.press(screen.getByRole('button', { name: 'Simulate a drive' }));
    await act(async () => {
      await jest.advanceTimersByTimeAsync(3000);
    });
    expect(screen.getByTestId('stub-hud').props.children).toBe('recording dry');
    for (let i = 0; i < 200 && !screen.queryByText(/Nothing was stored/); i += 1) {
      await act(async () => {
        await jest.advanceTimersByTimeAsync(500);
      });
    }
    jest.useRealTimers();
    expect(screen.queryByTestId('stub-hud')).toBeNull();
    expect(screen.getByText(/Nothing was stored/)).toBeTruthy();
  });

  test('offers both fixture drives', async () => {
    await renderPanel();
    expect(screen.getByRole('button', { name: /Speeding, then slowing down/ })).toBeTruthy();
    expect(screen.getByRole('button', { name: /Phone picked up/ })).toBeTruthy();
  });
});

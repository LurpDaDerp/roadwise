/** @jest-environment node */
// A report or "Wasn't driving" refreshes the drive's queries itself and waits on that refresh, so
// the recap shows the change as its sheet closes. Its announcement still wakes the runner, but the
// cache listener does not read every mounted query a second time (cancelling the first read).
import { QueryObserver } from '@tanstack/react-query';

import { createSqlJsDb } from '@/data/db/__fixtures__/sqljsDriver';
import { createSettingsRepo, migrate, type Db } from '@/data/db';
import { onDataChanged, type DataChange } from '@/data/events';
import { createQueryClient } from '@/data/queries/client';
import { subscribeInvalidation } from '@/data/queries/invalidate';
import { finishedDrive, speeding, T0, uuid } from '@/data/sync/__fixtures__/drives';
import { markNotDriving, reportEvent } from '@/data/sync/driveActions';

let db: Db;
beforeEach(async () => {
  db = await createSqlJsDb();
  await migrate(db);
  await createSettingsRepo(db).set('device.lastUserId', 'user-1');
  await finishedDrive(db, uuid(10), { events: [speeding(uuid(1), T0)] });
  await macrotask();
});

function macrotask(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

/** The app's cache, wired to the change event as the runtime wires it, with one mounted list that counts its reads. */
async function mountedList() {
  const qc = createQueryClient();
  const detach = subscribeInvalidation(qc);
  let reads = 0;
  const observer = new QueryObserver(qc, {
    queryKey: ['drives', 'recent', 5],
    queryFn: async () => {
      reads += 1;
      return reads;
    },
  });
  const unsubscribe = observer.subscribe(() => {});
  await macrotask();
  const heard: DataChange[] = [];
  const offHeard = onDataChanged((c) => heard.push(c));
  return {
    qc,
    reads: () => reads,
    heard,
    close() {
      offHeard();
      unsubscribe();
      detach();
      qc.clear();
    },
  };
}

test('a report from the recap reads each mounted query once, with fresh rows by the time it resolves, and still wakes the runner', async () => {
  const list = await mountedList();
  expect(list.reads()).toBe(1);
  expect(await reportEvent(uuid(10), uuid(1), 'wrong_limit', { db, queryClient: list.qc })).toBe('queued');
  expect(list.reads()).toBe(2);
  await macrotask();
  await macrotask();
  expect(list.reads()).toBe(2);
  expect(list.heard.map((c) => c.source)).toEqual(['enqueue']);
  list.close();
});

test('"Wasn’t driving" from the recap does the same', async () => {
  const list = await mountedList();
  expect(await markNotDriving(uuid(10), { db, queryClient: list.qc })).toBe('queued');
  expect(list.reads()).toBe(2);
  await macrotask();
  await macrotask();
  expect(list.reads()).toBe(2);
  expect(list.heard.map((c) => c.source)).toEqual(['enqueue']);
  list.close();
});

test('the notification’s "I wasn’t driving" (no cache in hand) still refreshes the cache through the change event', async () => {
  const list = await mountedList();
  expect(await markNotDriving(uuid(10), { db }, { via: 'notification' })).toBe('queued');
  expect(list.reads()).toBe(1);
  await macrotask();
  await macrotask();
  expect(list.reads()).toBe(2);
  expect(list.heard).toEqual([{ source: 'enqueue' }]);
  list.close();
});

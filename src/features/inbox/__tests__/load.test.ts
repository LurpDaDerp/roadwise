import type { Db } from '@/data/db/driver';
import { createSettingsRepo } from '@/data/db/settings';
import { createTestDb } from '@/data/queries/__fixtures__/harness';
import { T0 } from '@/data/queries/__fixtures__/rows';
import { InboxOfflineError } from '@/features/inbox/api';
import { createInboxCache, flushPending } from '@/features/inbox/cache';
import { loadInbox } from '@/features/inbox/useInbox';
import { OPENED_TRIPS_KEY } from '@/notifications/keys';

import { fakeApi } from '../__fixtures__/harness';
import { inboxRow, iso, nextId } from '../__fixtures__/rows';

jest.mock('@/data/supabase/client', () => ({ supabase: {} }));

let db: Db;
beforeEach(async () => {
  db = await createTestDb();
});

describe('loadInbox', () => {
  it('flushes pending reads and dismissals BEFORE the fetch, then clears them', async () => {
    const a = inboxRow({ id: nextId() });
    const b = inboxRow({ id: nextId() });
    const { api, log } = fakeApi([a, b]);
    const cache = createInboxCache(db);
    await cache.addPending('read', [a.id]);
    await cache.addPending('dismiss', [b.id]);
    const snap = await loadInbox(db, { api, online: true, now: T0 });
    expect(log).toEqual([`read:${a.id}`, `dismiss:${b.id}`, 'fetch']);
    expect(snap.offline).toBe(false);
    expect(await cache.readPending('read')).toEqual([]);
    expect(await cache.readPending('dismiss')).toEqual([]);
    const byId = new Map(snap.rows.map((r) => [r.id, r]));
    expect(byId.get(a.id)?.read_at).not.toBeNull();
    expect(byId.get(b.id)?.dismissed_at).not.toBeNull();
  });

  it('writes the fetched rows to the cache', async () => {
    const a = inboxRow({ id: nextId() });
    const { api } = fakeApi([a]);
    await loadInbox(db, { api, online: true, now: T0 });
    expect(await createInboxCache(db).list()).toEqual([a]);
  });

  it('offline: answers from the cache with offline: true and makes no call', async () => {
    const a = inboxRow({ id: nextId() });
    await createInboxCache(db).replaceAll([a]);
    const { api, log } = fakeApi([]);
    const snap = await loadInbox(db, { api, online: false, now: T0 });
    expect(snap).toEqual({ rows: [a], offline: true });
    expect(log).toEqual([]);
  });

  it('a transport failure falls back to the cache; the pending set is kept for next time', async () => {
    const a = inboxRow({ id: nextId() });
    const cache = createInboxCache(db);
    await cache.replaceAll([a]);
    await cache.addPending('read', [a.id]);
    const { api, fail } = fakeApi([a]);
    fail.mark = new InboxOfflineError();
    const snap = await loadInbox(db, { api, online: true, now: T0 });
    expect(snap.offline).toBe(true);
    expect(snap.rows.map((r) => r.id)).toEqual([a.id]);
    expect(await cache.readPending('read')).toEqual([a.id]);

    const second = fakeApi([a]);
    second.fail.fetch = new InboxOfflineError();
    expect((await loadInbox(db, { api: second.api, online: true, now: T0 })).offline).toBe(true);
  });

  it('a server refusal of the fetch is thrown, for the screen’s error and retry', async () => {
    const { api, fail } = fakeApi([]);
    const refused = Object.assign(new Error('permission denied'), { code: '42501' });
    fail.fetch = refused;
    await expect(loadInbox(db, { api, online: true, now: T0 })).rejects.toBe(refused);
  });

  it('a pending batch the server refuses as malformed (22023) is dropped, not retried forever', async () => {
    const cache = createInboxCache(db);
    await cache.addPending('read', ['not-a-row']);
    const { api, fail } = fakeApi([]);
    fail.mark = Object.assign(new Error('ids must be 1 to 100 inbox ids'), { code: '22023' });
    await flushPending(db, api);
    expect(await cache.readPending('read')).toEqual([]);
  });

  it('ids queued while a flush is in flight survive it', async () => {
    const cache = createInboxCache(db);
    await cache.addPending('read', ['a']);
    const { api } = fakeApi([]);
    const original = api.markInboxRead;
    api.markInboxRead = async (ids) => {
      await cache.addPending('read', ['late']);
      return original(ids);
    };
    await flushPending(db, api);
    expect(await cache.readPending('read')).toEqual(['late']);
  });

  it('a row whose drive the driver already opened is marked read, and that trip id is cleared', async () => {
    const opened = inboxRow({ id: nextId() }); // trip-1
    const other = inboxRow({
      id: nextId(),
      payload: { ...inboxRow().payload, clientTripId: 'trip-2' },
    });
    const settings = createSettingsRepo(db);
    await settings.set(OPENED_TRIPS_KEY, ['trip-9', 'trip-1']);
    const { api, log, server } = fakeApi([opened, other]);
    const snap = await loadInbox(db, { api, online: true, now: T0 + 1000 });
    const byId = new Map(snap.rows.map((r) => [r.id, r]));
    expect(byId.get(opened.id)?.read_at).not.toBeNull();
    expect(byId.get(other.id)?.read_at).toBeNull();
    // Reported to the server after the fetch, and nothing left queued.
    expect(log).toEqual(['fetch', `read:${opened.id}`]);
    expect(server.rows.find((r) => r.id === opened.id)?.read_at).not.toBeNull();
    expect(await createInboxCache(db).readPending('read')).toEqual([]);
    // trip-9 has no row yet (its row may not be due): it stays until one appears.
    expect(await settings.get(OPENED_TRIPS_KEY)).toEqual(['trip-9']);
  });

  it('a local mark made while the fetch was in flight is not undone by the stale reply', async () => {
    const a = inboxRow({ id: nextId() });
    const cache = createInboxCache(db);
    await cache.replaceAll([a]);
    const { api } = fakeApi([a]);
    const fetch = api.fetchInbox;
    api.fetchInbox = async (limit) => {
      const rows = await fetch(limit); // the server's answer: still unread
      await cache.markReadLocal([a.id], iso(T0));
      await cache.addPending('read', [a.id]);
      api.markInboxRead = async () => {
        throw new InboxOfflineError(); // the follow-up flush cannot reach the server
      };
      return rows;
    };
    const snap = await loadInbox(db, { api, online: true, now: T0 });
    expect(snap.rows[0]?.read_at).toBe(iso(T0));
    expect(await cache.readPending('read')).toEqual([a.id]);
  });
});

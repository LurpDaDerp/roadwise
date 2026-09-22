import type { Db } from '@/data/db/driver';
import { createSettingsRepo } from '@/data/db/settings';
import { createTestDb } from '@/data/queries/__fixtures__/harness';
import { T0 } from '@/data/queries/__fixtures__/rows';
import {
  CACHE_LIST_MAX,
  createInboxCache,
  PENDING_DISMISS_KEY,
  PENDING_MAX,
  PENDING_READ_KEY,
  queueInboxRead,
} from '@/features/inbox/cache';

import { inboxRow, iso, nextId } from '../__fixtures__/rows';

jest.mock('@/data/supabase/client', () => ({ supabase: {} }));

let db: Db;
beforeEach(async () => {
  db = await createTestDb();
});

describe('inbox cache over inbox_cache', () => {
  it('replaceAll replaces every row; list is newest first', async () => {
    const cache = createInboxCache(db);
    await cache.replaceAll([inboxRow({ id: nextId() })]);
    const older = inboxRow({ id: nextId(), created_at: iso(T0 - 60_000) });
    const newer = inboxRow({ id: nextId(), created_at: iso(T0 + 60_000) });
    await cache.replaceAll([older, newer]);
    expect(await cache.list()).toEqual([newer, older]);
  });

  it('list keeps at most 200 and skips a row that no longer parses', async () => {
    const cache = createInboxCache(db);
    const rows = Array.from({ length: CACHE_LIST_MAX + 5 }, (_, i) =>
      inboxRow({ id: nextId(), created_at: iso(T0 + i * 1000) })
    );
    await cache.replaceAll(rows);
    await db.execute('INSERT INTO inbox_cache (id, payload_json, read_at) VALUES (?, ?, NULL)', [
      'broken',
      '{"id":',
    ]);
    const listed = await cache.list();
    expect(listed).toHaveLength(CACHE_LIST_MAX);
    expect(listed[0]?.created_at).toBe(iso(T0 + (CACHE_LIST_MAX + 4) * 1000));
  });

  it('markReadLocal stamps unread rows only; dismissLocal stamps dismissed_at', async () => {
    const cache = createInboxCache(db);
    const a = inboxRow({ id: nextId() });
    const b = inboxRow({ id: nextId(), read_at: iso(T0 - 5000), created_at: iso(T0 - 1) });
    await cache.replaceAll([a, b]);
    expect(await cache.markReadLocal([a.id, b.id], iso(T0))).toBe(1);
    expect(await cache.dismissLocal([b.id], iso(T0))).toBe(1);
    const [ra, rb] = await cache.list();
    expect(ra?.read_at).toBe(iso(T0));
    expect(rb?.read_at).toBe(iso(T0 - 5000));
    expect(rb?.dismissed_at).toBe(iso(T0));
    const { rows } = await db.execute('SELECT read_at FROM inbox_cache WHERE id = ?', [a.id]);
    expect(rows[0]?.read_at).toBe(T0);
  });

  it('pending sets are deduplicated and bounded to the newest 500', async () => {
    const cache = createInboxCache(db);
    await cache.addPending('read', ['a', 'b']);
    await cache.addPending('read', ['b', 'c']);
    expect(await cache.readPending('read')).toEqual(['a', 'b', 'c']);
    await cache.removePending('read', ['a', 'c']);
    expect(await cache.readPending('read')).toEqual(['b']);
    const many = Array.from({ length: PENDING_MAX + 10 }, (_, i) => `id-${i}`);
    await cache.addPending('dismiss', many);
    const kept = await cache.readPending('dismiss');
    expect(kept).toHaveLength(PENDING_MAX);
    expect(kept[kept.length - 1]).toBe(`id-${PENDING_MAX + 9}`);
    const settings = createSettingsRepo(db);
    expect(await settings.get(PENDING_READ_KEY)).toEqual(['b']);
    expect((await settings.get<string[]>(PENDING_DISMISS_KEY))?.length).toBe(PENDING_MAX);
  });

  it('queueInboxRead marks locally and queues for the server (a pushed notification’s inboxId)', async () => {
    const cache = createInboxCache(db);
    const a = inboxRow({ id: nextId() });
    await cache.replaceAll([a]);
    await queueInboxRead(db, [a.id], T0);
    expect((await cache.list())[0]?.read_at).toBe(iso(T0));
    expect(await cache.readPending('read')).toEqual([a.id]);
  });
});

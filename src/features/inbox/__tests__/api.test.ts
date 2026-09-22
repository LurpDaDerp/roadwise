import {
  chunk,
  dismissInbox,
  fetchInbox,
  INBOX_COLUMNS,
  InboxOfflineError,
  InboxRowSchema,
  markInboxRead,
  type InboxClient,
} from '@/features/inbox/api';

import { inboxRow } from '../__fixtures__/rows';

jest.mock('@/data/supabase/client', () => ({ supabase: {} }));

/** A fake of the two client entry points, recording every call. */
function fakeClient(opts: {
  select?: { data: unknown; error: unknown; status: number };
  rpc?: (fn: string, args: { p_ids: string[] }) => { data: unknown; error: unknown; status: number };
}) {
  const calls: { from: string[]; select: string[]; order: unknown[]; limit: number[]; rpc: [string, string[]][] } = {
    from: [],
    select: [],
    order: [],
    limit: [],
    rpc: [],
  };
  const client = {
    from(table: string) {
      calls.from.push(table);
      const builder = {
        select(cols: string) {
          calls.select.push(cols);
          return builder;
        },
        order(col: string, o: unknown) {
          calls.order.push([col, o]);
          return builder;
        },
        limit(n: number) {
          calls.limit.push(n);
          return Promise.resolve(opts.select ?? { data: [], error: null, status: 200 });
        },
      };
      return builder;
    },
    rpc(fn: string, args: { p_ids: string[] }) {
      calls.rpc.push([fn, args.p_ids]);
      return Promise.resolve(
        opts.rpc ? opts.rpc(fn, args) : { data: args.p_ids.length, error: null, status: 200 }
      );
    },
  };
  return { client: client as unknown as InboxClient, calls };
}

const ids = (n: number) =>
  Array.from({ length: n }, (_, i) => `00000000-0000-4000-8000-${String(i).padStart(12, '0')}`);

describe('InboxRowSchema', () => {
  it('accepts exactly the granted columns', () => {
    expect(InboxRowSchema.safeParse(inboxRow()).success).toBe(true);
  });

  it('refuses a row carrying push_state (the sender’s column is never read or cached)', () => {
    expect(InboxRowSchema.safeParse({ ...inboxRow(), push_state: 'sent' }).success).toBe(false);
  });

  it('refuses dedupe_key, a missing pushed_at and a bad timestamp', () => {
    expect(InboxRowSchema.safeParse({ ...inboxRow(), dedupe_key: 'x' }).success).toBe(false);
    const { pushed_at: _omit, ...noPushed } = inboxRow();
    void _omit;
    expect(InboxRowSchema.safeParse(noPushed).success).toBe(false);
    expect(InboxRowSchema.safeParse({ ...inboxRow(), created_at: 'yesterday' }).success).toBe(false);
  });

  it('the column list names every schema key and nothing else, and never *', () => {
    expect(INBOX_COLUMNS.split(',').sort()).toEqual(Object.keys(InboxRowSchema.shape).sort());
    expect(INBOX_COLUMNS).not.toContain('*');
    expect(INBOX_COLUMNS).toContain('pushed_at');
  });
});

describe('fetchInbox', () => {
  it('selects the listed columns, newest first, 100 by default', async () => {
    const { client, calls } = fakeClient({ select: { data: [inboxRow()], error: null, status: 200 } });
    const rows = await fetchInbox(undefined, client);
    expect(rows).toHaveLength(1);
    expect(calls.from).toEqual(['inbox']);
    expect(calls.select).toEqual([INBOX_COLUMNS]);
    expect(calls.order).toEqual([['created_at', { ascending: false }]]);
    expect(calls.limit).toEqual([100]);
  });

  it('drops a row the schema refuses and keeps the rest', async () => {
    const good = inboxRow();
    const { client } = fakeClient({
      select: { data: [{ ...inboxRow({ id: ids(2)[1] }), push_state: 'sent' }, good], error: null, status: 200 },
    });
    expect(await fetchInbox(10, client)).toEqual([good]);
  });

  it('a transport failure (status 0) is InboxOfflineError; a server refusal is rethrown', async () => {
    const offline = fakeClient({
      select: { data: null, error: { message: 'TypeError: Network request failed', code: '' }, status: 0 },
    });
    await expect(fetchInbox(10, offline.client)).rejects.toBeInstanceOf(InboxOfflineError);
    const refused = { message: 'permission denied', code: '42501' };
    const server = fakeClient({ select: { data: null, error: refused, status: 403 } });
    await expect(fetchInbox(10, server.client)).rejects.toBe(refused);
  });
});

describe('markInboxRead / dismissInbox', () => {
  it('chunks 250 ids into 100 + 100 + 50 and sums the counts', async () => {
    const { client, calls } = fakeClient({});
    expect(await markInboxRead(ids(250), client)).toBe(250);
    expect(calls.rpc.map(([fn, p]) => [fn, p.length])).toEqual([
      ['mark_inbox_read', 100],
      ['mark_inbox_read', 100],
      ['mark_inbox_read', 50],
    ]);
  });

  it('dismiss uses dismiss_inbox with the same chunking', async () => {
    const { client, calls } = fakeClient({});
    await dismissInbox(ids(101), client);
    expect(calls.rpc.map(([fn, p]) => [fn, p.length])).toEqual([
      ['dismiss_inbox', 100],
      ['dismiss_inbox', 1],
    ]);
  });

  it('never calls with an empty list, and deduplicates', async () => {
    const { client, calls } = fakeClient({});
    await markInboxRead([], client);
    expect(calls.rpc).toEqual([]);
    const [a] = ids(1) as [string];
    await markInboxRead([a, a], client);
    expect(calls.rpc).toEqual([['mark_inbox_read', [a]]]);
  });

  it('stops at the first failing chunk and reports offline as InboxOfflineError', async () => {
    let n = 0;
    const { client, calls } = fakeClient({
      rpc: () => (++n === 2 ? { data: null, error: { message: 'x', code: '' }, status: 0 } : { data: 100, error: null, status: 200 }),
    });
    await expect(markInboxRead(ids(300), client)).rejects.toBeInstanceOf(InboxOfflineError);
    expect(calls.rpc).toHaveLength(2);
  });

  it('chunk() keeps order', () => {
    expect(chunk(['a', 'b', 'c'], 2)).toEqual([['a', 'b'], ['c']]);
  });
});

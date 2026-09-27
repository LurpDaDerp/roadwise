import { functionsHttpError } from '@/data/sync/__fixtures__/fakes';

import {
  ACCOUNT_DELETE_FUNCTION,
  ACCOUNT_EXPORT_FUNCTION,
  deleteMyAccount,
  exportMyData,
  runAccountDeletion,
  type AccountClient,
} from '../api';

jest.mock('@/data/supabase/client', () => ({ supabase: {} }));

function client(reply: { data: unknown; error: unknown } | Error) {
  const invoke = jest.fn(async (_name: string, _opts: { body: unknown }) => {
    if (reply instanceof Error) throw reply;
    return reply;
  });
  return { invoke, client: { functions: { invoke } } as unknown as AccountClient };
}

const DOC = { format: 'roadwise-export', exported_at: '2026-09-26T10:00:00Z', account: { user_id: 'u1' } };

describe('exportMyData', () => {
  test('asks the export function and hands back the document as readable JSON', async () => {
    const c = client({ data: DOC, error: null });
    const r = await exportMyData({ client: c.client, online: () => true });
    expect(c.invoke).toHaveBeenCalledWith(ACCOUNT_EXPORT_FUNCTION, { body: {} });
    expect(r).toEqual({ ok: true, json: JSON.stringify(DOC, null, 2) });
  });

  test('offline: no request at all', async () => {
    const c = client({ data: DOC, error: null });
    expect(await exportMyData({ client: c.client, online: () => false })).toEqual({ ok: false, reason: 'offline' });
    expect(c.invoke).not.toHaveBeenCalled();
  });

  test('429 is "too many today"; a dropped connection is offline; anything else failed', async () => {
    const tooMany = client(functionsHttpError(429, { code: 'too_many_requests' }) as { data: unknown; error: unknown });
    expect(await exportMyData({ client: tooMany.client, online: () => true })).toEqual({ ok: false, reason: 'too_many' });
    const dropped = client({ data: null, error: { name: 'FunctionsFetchError', message: 'Failed to send a request' } });
    expect(await exportMyData({ client: dropped.client, online: () => true })).toEqual({ ok: false, reason: 'offline' });
    const broken = client(functionsHttpError(500, { code: 'internal' }) as { data: unknown; error: unknown });
    expect(await exportMyData({ client: broken.client, online: () => true })).toEqual({ ok: false, reason: 'failed' });
    const thrown = client(new Error('boom'));
    expect(await exportMyData({ client: thrown.client, online: () => true })).toEqual({ ok: false, reason: 'failed' });
  });

  test('a 200 that is not an export document is a failure, never shared', async () => {
    for (const data of [null, 'x', [], { account: null }]) {
      const c = client({ data, error: null });
      expect(await exportMyData({ client: c.client, online: () => true })).toEqual({ ok: false, reason: 'failed' });
    }
  });
});

describe('deleteMyAccount', () => {
  test('sends the confirmation word; a 200 that says deleted is done', async () => {
    const c = client({ data: { deleted: true, objectsRemoved: 2, objectsLeft: 0 }, error: null });
    expect(await deleteMyAccount({ client: c.client, online: () => true })).toEqual({ ok: true });
    expect(c.invoke).toHaveBeenCalledWith(ACCOUNT_DELETE_FUNCTION, { body: { confirm: 'DELETE' } });
  });

  test('offline: no request; 401: the session proves no account; else failed', async () => {
    const c = client({ data: { deleted: true }, error: null });
    expect(await deleteMyAccount({ client: c.client, online: () => false })).toEqual({ ok: false, reason: 'offline' });
    expect(c.invoke).not.toHaveBeenCalled();
    const gone = client(functionsHttpError(401, { code: 'unauthorized' }) as { data: unknown; error: unknown });
    expect(await deleteMyAccount({ client: gone.client, online: () => true })).toEqual({ ok: false, reason: 'session_gone' });
    const down = client(functionsHttpError(503, { code: 'retry' }) as { data: unknown; error: unknown });
    expect(await deleteMyAccount({ client: down.client, online: () => true })).toEqual({ ok: false, reason: 'failed' });
    const odd = client({ data: { deleted: false }, error: null });
    expect(await deleteMyAccount({ client: odd.client, online: () => true })).toEqual({ ok: false, reason: 'failed' });
  });
});

describe('runAccountDeletion', () => {
  function deps(result: Awaited<ReturnType<typeof deleteMyAccount>>) {
    const order: string[] = [];
    return {
      order,
      d: {
        remove: jest.fn(async () => {
          order.push('remove');
          return result;
        }),
        signOut: jest.fn(async () => {
          order.push('signOut');
        }),
        wipe: jest.fn(async () => {
          order.push('wipe');
        }),
      },
    };
  }

  test('deleted: signed out on this phone, then the phone is emptied', async () => {
    const { d, order } = deps({ ok: true });
    expect(await runAccountDeletion(d)).toEqual({ ok: true });
    expect(order).toEqual(['remove', 'signOut', 'wipe']);
  });

  test('the session proves no account: signed out too, but nothing is wiped or claimed', async () => {
    const { d, order } = deps({ ok: false, reason: 'session_gone' });
    expect(await runAccountDeletion(d)).toEqual({ ok: false, reason: 'session_gone' });
    expect(order).toEqual(['remove', 'signOut']);
  });

  test('a failure changes nothing on the phone', async () => {
    const { d, order } = deps({ ok: false, reason: 'failed' });
    expect(await runAccountDeletion(d)).toEqual({ ok: false, reason: 'failed' });
    expect(order).toEqual(['remove']);
  });

  test('a sign-out or wipe that throws never turns a done deletion into an error', async () => {
    const { d } = deps({ ok: true });
    d.signOut.mockRejectedValueOnce(new Error('revoke failed'));
    d.wipe.mockRejectedValueOnce(new Error('disk'));
    expect(await runAccountDeletion(d)).toEqual({ ok: true });
    expect(d.wipe).toHaveBeenCalled();
  });
});

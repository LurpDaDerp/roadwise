import { act, renderHook, waitFor } from '@testing-library/react-native';

import { T0 } from '@/data/queries/__fixtures__/rows';
import { wrapperFor } from '@/data/queries/__fixtures__/harness';
import { INBOX_STALE_MS, useInbox, useServerPushesToday } from '@/features/inbox/useInbox';
import { INBOX_QUERY_KEY } from '@/notifications/keys';

import {
  clearInboxClients,
  fakeApi,
  fakeAppState,
  inboxWorld,
  setOnline,
} from '../__fixtures__/harness';
import { inboxRow, iso, lapseRow, nextId } from '../__fixtures__/rows';

jest.mock('@/data/supabase/client', () => ({ supabase: {} }));
const mockSession: { session: { user: { id: string } } | null } = { session: { user: { id: 'u1' } } };
jest.mock('@/data/supabase/session', () => ({ useSession: () => mockSession }));

let clock = T0;
beforeEach(() => {
  clock = T0;
  jest.spyOn(Date, 'now').mockImplementation(() => clock);
});
afterEach(async () => {
  await clearInboxClients();
  setOnline(null);
  mockSession.session = { user: { id: 'u1' } };
  jest.restoreAllMocks();
});

async function mountInbox(rows = [inboxRow({ id: nextId() })]) {
  const w = await inboxWorld({}, () => clock);
  const server = fakeApi(rows);
  const appState = fakeAppState();
  const wrapper = wrapperFor(w.db, w.client, () => clock);
  const hook = await renderHook(() => useInbox({ api: server.api, appState }), { wrapper });
  return { ...w, ...server, appState, hook, wrapper };
}

const fetches = (api: { fetchInbox: unknown }) => (api.fetchInbox as jest.Mock).mock.calls.length;

describe('useInbox freshness — no polling', () => {
  it('fetches on mount and serves the result for 5 minutes', async () => {
    const { api, hook, wrapper, appState } = await mountInbox();
    await waitFor(() => expect(hook.result.current.data?.rows).toHaveLength(1));
    expect(hook.result.current.data?.offline).toBe(false);
    await hook.unmount();

    clock = T0 + INBOX_STALE_MS - 1000;
    const again = await renderHook(() => useInbox({ api, appState }), { wrapper });
    await waitFor(() => expect(again.result.current.data?.rows).toHaveLength(1));
    expect(fetches(api)).toBe(1);
    await again.unmount();

    clock = T0 + INBOX_STALE_MS + 1000;
    const stale = await renderHook(() => useInbox({ api, appState }), { wrapper });
    await waitFor(() => expect(fetches(api)).toBe(2));
    await stale.unmount();
  });

  it('refreshes on a return to the foreground only when stale, and never in the background', async () => {
    const { api, hook, appState } = await mountInbox();
    await waitFor(() => expect(fetches(api)).toBe(1));
    await act(async () => appState.emit('active'));
    expect(fetches(api)).toBe(1);

    clock = T0 + INBOX_STALE_MS + 1;
    await act(async () => appState.emit('background'));
    expect(fetches(api)).toBe(1);
    await act(async () => appState.emit('active'));
    await waitFor(() => expect(fetches(api)).toBe(2));
    await hook.unmount();
    expect(appState.count()).toBe(0);
  });

  it('a notification’s invalidation of INBOX_QUERY_KEY refetches (the host does this on receipt)', async () => {
    const { api, client, hook } = await mountInbox();
    await waitFor(() => expect(fetches(api)).toBe(1));
    await act(async () => {
      await client.invalidateQueries({ queryKey: INBOX_QUERY_KEY });
    });
    expect(fetches(api)).toBe(2);
    await hook.unmount();
  });

  it('offline, then back online: one fetch when the connection returns', async () => {
    setOnline(false);
    const { api, hook } = await mountInbox();
    await waitFor(() => expect(hook.result.current.data?.offline).toBe(true));
    expect(fetches(api)).toBe(0);
    await act(async () => setOnline(true));
    await waitFor(() => expect(hook.result.current.data?.offline).toBe(false));
    expect(fetches(api)).toBe(1);
    await hook.unmount();
  });

  it('does nothing while signed out', async () => {
    mockSession.session = null;
    const { api, hook, appState } = await mountInbox();
    await act(async () => appState.emit('active'));
    expect(fetches(api)).toBe(0);
    expect(hook.result.current.fetchStatus).toBe('idle');
    await hook.unmount();
  });
});

describe('useServerPushesToday', () => {
  it('counts today’s capped pushes in the zone asked for', async () => {
    const w = await inboxWorld({}, () => clock);
    const { api } = fakeApi([
      lapseRow({ id: nextId(), pushed_at: iso(T0 - 60_000) }),
      lapseRow({ id: nextId(), pushed_at: iso(T0 - 2 * 86_400_000) }),
      inboxRow({ id: nextId(), type: 'family_digest', pushed_at: iso(T0 - 60_000) }),
    ]);
    const wrapper = wrapperFor(w.db, w.client, () => clock);
    const hook = await renderHook(() => useServerPushesToday('UTC', { api, appState: fakeAppState() }), {
      wrapper,
    });
    await waitFor(() => expect(hook.result.current).toBe(1));
    await hook.unmount();
  });
});

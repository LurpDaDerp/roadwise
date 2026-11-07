import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { renderHook, waitFor } from '@testing-library/react-native';
import type { ReactNode } from 'react';

import { createWrappedShare, deleteWrappedShare, useMyWrapped, useSharedWrapped, useWrappedArchive } from '../wrapped';

const mockCallRpc = jest.fn<Promise<unknown>, [string, unknown?]>(async () => null);
jest.mock('../rpc', () => ({ callRpc: (fn: string, args?: unknown) => mockCallRpc(fn, args) }));
jest.mock('@/data/supabase/session', () => ({ useSession: () => ({ session: { user: { id: 'u1' } } }) }));
jest.mock('expo-router', () => {
  const { useEffect } = jest.requireActual<typeof import('react')>('react');
  return { useFocusEffect: (cb: () => void | (() => void)) => useEffect(cb, [cb]) };
});

const clients: QueryClient[] = [];
function wrapper({ children }: { children: ReactNode }) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  clients.push(qc);
  return <QueryClientProvider client={qc}>{children}</QueryClientProvider>;
}

beforeEach(() => mockCallRpc.mockReset());
afterEach(() => {
  for (const c of clients.splice(0)) c.clear();
});

test('the archive, a month and a shared copy each ask their RPC with their argument', async () => {
  mockCallRpc.mockImplementation(async (fn) => (fn === 'list_my_wrapped' ? [] : { month: '2026-10' }));
  const list = await renderHook(() => useWrappedArchive(), { wrapper });
  await waitFor(() => expect(list.result.current.data).toEqual([]));
  const month = await renderHook(() => useMyWrapped('2026-10'), { wrapper });
  await waitFor(() => expect(month.result.current.data).toEqual({ month: '2026-10' }));
  const shared = await renderHook(() => useSharedWrapped('Ab3dEf7hJk9m'), { wrapper });
  await waitFor(() => expect(shared.result.current.data).toEqual({ month: '2026-10' }));
  expect(mockCallRpc.mock.calls).toEqual([
    ['list_my_wrapped', undefined],
    ['get_my_wrapped', { p_month: '2026-10' }],
    ['get_shared_wrapped', { p_id: 'Ab3dEf7hJk9m' }],
  ]);
});

test('a malformed month or id, or a switched-off archive, never asks', async () => {
  await renderHook(() => useMyWrapped('2026-13'), { wrapper });
  await renderHook(() => useMyWrapped('../x'), { wrapper });
  await renderHook(() => useSharedWrapped('short'), { wrapper });
  await renderHook(() => useWrappedArchive({ enabled: false }), { wrapper });
  await new Promise((r) => setTimeout(r, 10));
  expect(mockCallRpc).not.toHaveBeenCalled();
});

test('sharing answers the share id, and refuses anything that is not one', async () => {
  mockCallRpc.mockResolvedValueOnce('Ab3dEf7hJk9m');
  await expect(createWrappedShare('2026-10')).resolves.toBe('Ab3dEf7hJk9m');
  expect(mockCallRpc).toHaveBeenLastCalledWith('create_wrapped_share', { p_month: '2026-10' });
  mockCallRpc.mockResolvedValueOnce('roadwise://evil');
  await expect(createWrappedShare('2026-10')).rejects.toThrow('bad share id');
});

test('stopping a share answers whether there was one', async () => {
  mockCallRpc.mockResolvedValueOnce(true);
  await expect(deleteWrappedShare('2026-10')).resolves.toBe(true);
  expect(mockCallRpc).toHaveBeenLastCalledWith('delete_wrapped_share', { p_month: '2026-10' });
  mockCallRpc.mockResolvedValueOnce(false);
  await expect(deleteWrappedShare('2026-10')).resolves.toBe(false);
});

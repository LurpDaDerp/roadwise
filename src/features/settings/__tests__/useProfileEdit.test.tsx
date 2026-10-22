/**
 * useProfileEdit: saves run one after another in tap order (a quick second toggle is never dropped),
 * and a failed older save never wipes a newer optimistic value.
 */
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, renderHook } from '@testing-library/react-native';
import type { ReactNode } from 'react';

import { useProfileEdit } from '../useProfileEdit';

interface Call {
  fn: string;
  args: Record<string, unknown> | undefined;
  resolve: () => void;
  reject: (e: Error) => void;
}
const mockCalls: Call[] = [];
jest.mock('@/data/server/rpc', () => {
  const actual = jest.requireActual<typeof import('@/data/server/rpc')>('@/data/server/rpc');
  return {
    ...actual,
    callRpc: (fn: string, args?: Record<string, unknown>) =>
      new Promise<unknown>((resolve, reject) => mockCalls.push({ fn, args, resolve: () => resolve({}), reject })),
  };
});
jest.mock('@/data/supabase/client', () => ({ supabase: {} }));

beforeEach(() => {
  mockCalls.length = 0;
});

async function hook() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const wrapper = ({ children }: { children: ReactNode }) => <QueryClientProvider client={qc}>{children}</QueryClientProvider>;
  return renderHook(() => useProfileEdit(), { wrapper });
}

const flush = () => act(async () => {});

it('a second toggle during the first save waits for it, then saves too: both stay as tapped', async () => {
  const { result } = await hook();
  let a: Promise<boolean> | undefined;
  let b: Promise<boolean> | undefined;
  await act(async () => {
    a = result.current.save('share_stats', false);
    b = result.current.save('share_rating', false);
  });
  expect(mockCalls.map((c) => c.args)).toEqual([{ p_share_stats: false }]);
  expect(result.current.value('share_stats', true)).toBe(false);
  expect(result.current.value('share_rating', true)).toBe(false);
  expect(result.current.saving).toBe(true);
  await act(async () => mockCalls[0]!.resolve());
  await flush();
  expect(mockCalls.map((c) => [c.fn, c.args])).toEqual([
    ['update_profile', { p_share_stats: false }],
    ['update_profile', { p_share_rating: false }],
  ]);
  await act(async () => mockCalls[1]!.resolve());
  await expect(a).resolves.toBe(true);
  await expect(b).resolves.toBe(true);
  expect(result.current.value('share_stats', true)).toBe(false);
  expect(result.current.value('share_rating', true)).toBe(false);
  expect(result.current.saving).toBe(false);
  expect(result.current.error).toBeNull();
});

it('the first save fails and the second lands: only the first falls back, and the error stands', async () => {
  const { result } = await hook();
  let a: Promise<boolean> | undefined;
  let b: Promise<boolean> | undefined;
  await act(async () => {
    a = result.current.save('share_stats', false);
    b = result.current.save('share_rating', false);
  });
  await act(async () => mockCalls[0]!.reject(new Error('offline')));
  await flush();
  await act(async () => mockCalls[1]!.resolve());
  await expect(a).resolves.toBe(false);
  await expect(b).resolves.toBe(true);
  expect(result.current.value('share_stats', true)).toBe(true);
  expect(result.current.value('share_rating', true)).toBe(false);
  expect(result.current.error).not.toBeNull();
});

it('a failed older save of the same field leaves the newer value shown', async () => {
  const { result } = await hook();
  await act(async () => {
    void result.current.save('share_stats', true);
    void result.current.save('share_stats', false);
  });
  await act(async () => mockCalls[0]!.reject(new Error('offline')));
  await flush();
  expect(result.current.value('share_stats', true)).toBe(false);
  expect(mockCalls.map((c) => c.args)).toEqual([{ p_share_stats: true }, { p_share_stats: false }]);
  await act(async () => mockCalls[1]!.resolve());
  expect(result.current.value('share_stats', true)).toBe(false);
});

it('a failed save alone falls back to the server value', async () => {
  const { result } = await hook();
  let a: Promise<boolean> | undefined;
  await act(async () => {
    a = result.current.save('units', 'km');
  });
  expect(result.current.value('units', 'mi')).toBe('km');
  await act(async () => mockCalls[0]!.reject(new Error('offline')));
  await expect(a).resolves.toBe(false);
  expect(result.current.value('units', 'mi')).toBe('mi');
  expect(result.current.error).not.toBeNull();
});

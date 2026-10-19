/**
 * Screen harness for the Leaderboards suites: a fresh QueryClient, the theme, and doubles for
 * the three seams a screen touches — the RPC helper, the session, and expo-router. Each suite
 * wires them with (Jest hoists `jest.mock` per file, so the factories `require` this module):
 *
 *   jest.mock('@/data/server/rpc', () => require('@/features/leagues/__fixtures__/harness').rpcModule);
 *   jest.mock('@/data/supabase/session', () => require('@/features/leagues/__fixtures__/harness').sessionModule);
 *   jest.mock('expo-router', () => require('@/features/leagues/__fixtures__/harness').routerModule);
 */
import { notifyManager, QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, render, waitFor, type RenderResult } from '@testing-library/react-native';
import { useEffect, type ReactElement } from 'react';
import { Alert, type AlertButton } from 'react-native';

import { ThemeProvider } from '@/ui/theme';

// ---------------------------------------------------------------------------
// rpc
// ---------------------------------------------------------------------------

class RpcError extends Error {
  constructor(
    message: string,
    readonly code: string | null
  ) {
    super(message);
    this.name = 'RpcError';
  }
}

export const callRpc = jest.fn<Promise<unknown>, [string, Record<string, unknown>?]>();
export const rpcModule = { RpcError, callRpc };

export const rpcError = (message: string, code = '42501') => new RpcError(message, code);

type Handler = unknown | ((args: Record<string, unknown>) => unknown);

/** Answer each RPC by name: a value, a function of the args, or an Error to throw. */
export function respond(handlers: Record<string, Handler>): void {
  callRpc.mockImplementation(async (fn, args = {}) => {
    if (!(fn in handlers)) throw new Error(`unexpected rpc ${fn}`);
    const h = handlers[fn];
    const out = typeof h === 'function' ? (h as (a: Record<string, unknown>) => unknown)(args) : h;
    if (out instanceof Error) throw out;
    return out;
  });
}

export const callsTo = (fn: string) => callRpc.mock.calls.filter(([name]) => name === fn).map(([, args]) => args);

// ---------------------------------------------------------------------------
// session + router
// ---------------------------------------------------------------------------

export const ME = 'id-me';
export const sessionModule = { useSession: () => ({ session: { user: { id: ME } } }) };

export const router = {
  push: jest.fn(),
  replace: jest.fn(),
  back: jest.fn(),
  canGoBack: jest.fn(() => true),
};
export const searchParams: { current: Record<string, string> } = { current: {} };

export const routerModule = {
  useRouter: () => router,
  useLocalSearchParams: () => searchParams.current,
  // the screen counts as focused while mounted
  useFocusEffect: (cb: () => void | (() => void)) => {
    useEffect(() => cb(), [cb]);
  },
};

// ---------------------------------------------------------------------------
// alerts
// ---------------------------------------------------------------------------

/**
 * Answers every native Alert by pressing the button with `choose`'s label (default: the last,
 * which is the confirm in `confirm()`). Returns the spy so a suite can read titles and bodies.
 */
export function answerAlerts(choose?: string): jest.SpyInstance {
  return jest.spyOn(Alert, 'alert').mockImplementation((_title, _body, buttons?: AlertButton[]) => {
    if (!buttons?.length) return;
    const b = choose ? buttons.find((x) => x.text === choose) : buttons[buttons.length - 1];
    b?.onPress?.();
  });
}

// ---------------------------------------------------------------------------
// render
// ---------------------------------------------------------------------------

const clients = new Set<QueryClient>();

// React Query delivers observer updates on a timer, which lands between RNTL's act() windows;
// a microtask lands inside the act() that started the work.
notifyManager.setScheduler((cb) => queueMicrotask(cb));

/**
 * Lets every query and write still in flight land inside `act` (a write's invalidation refetches
 * after the assertion that waited for the write), then resets the doubles. Use as `afterEach`.
 */
export async function resetHarness(): Promise<void> {
  await waitFor(() => {
    for (const c of clients) expect(c.isFetching() + c.isMutating()).toBe(0);
  });
  // React Query batches its observer notifications onto a timer; let that land inside act too
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 10));
  });
  for (const c of clients) c.clear();
  clients.clear();
  callRpc.mockReset();
  router.push.mockReset();
  router.replace.mockReset();
  router.back.mockReset();
  searchParams.current = {};
  jest.restoreAllMocks();
}

export async function renderScreen(ui: ReactElement): Promise<RenderResult & { client: QueryClient }> {
  const client = new QueryClient({
    defaultOptions: { queries: { retryDelay: 0, gcTime: Infinity }, mutations: { gcTime: Infinity } },
  });
  clients.add(client);
  const result = await render(
    <QueryClientProvider client={client}>
      <ThemeProvider scheme="light" reduceMotion>
        {ui}
      </ThemeProvider>
    </QueryClientProvider>
  );
  return { ...result, client };
}

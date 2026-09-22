import { act, renderHook } from '@testing-library/react-native';

import {
  createExpoNet,
  createNetAdapter,
  getSharedOnline,
  resetNetForTests,
  toNetState,
  type ExpoNetworkLike,
  type NetworkStateLike,
} from '@/data/net/net';
import { useOnline } from '@/data/net/useOnline';

/** A stand-in for `expo-network`: one listener slot, and a way to push a change through it. */
function fakeNetwork(initial: NetworkStateLike) {
  const listeners: ((s: NetworkStateLike) => void)[] = [];
  let reads = 0;
  const module: ExpoNetworkLike = {
    async getNetworkStateAsync() {
      reads += 1;
      return initial;
    },
    addNetworkStateListener(listener) {
      listeners.push(listener);
      return {
        remove() {
          listeners.splice(listeners.indexOf(listener), 1);
        },
      };
    },
  };
  return {
    module,
    listeners,
    reads: () => reads,
    change: (s: NetworkStateLike) => listeners.forEach((l) => l(s)),
  };
}

const WIFI = { type: 'WIFI', isConnected: true, isInternetReachable: true };
const CELL = { type: 'CELLULAR', isConnected: true, isInternetReachable: true };
const NONE = { type: 'NONE', isConnected: false, isInternetReachable: false };

afterEach(() => resetNetForTests());

describe('toNetState', () => {
  test.each([
    ['Wi-Fi', WIFI, { online: true, wifi: true }],
    ['Ethernet', { type: 'ETHERNET', isConnected: true, isInternetReachable: true }, { online: true, wifi: true }],
    ['cellular', CELL, { online: true, wifi: false }],
    ['a VPN, whose link the OS will not name', { type: 'VPN', isConnected: true, isInternetReachable: true }, { online: true, wifi: false }],
    ['no connection', NONE, { online: false, wifi: false }],
    ['unknown type', { type: 'UNKNOWN', isConnected: false }, { online: false, wifi: false }],
    // Android: a captive portal is connected but not validated.
    ['Wi-Fi behind a captive portal', { type: 'WIFI', isConnected: true, isInternetReachable: false }, { online: false, wifi: false }],
    // Reachability not reported yet: connected is enough.
    ['connected, reachability unknown', { type: 'WIFI', isConnected: true }, { online: true, wifi: true }],
    ['nothing reported at all', {}, { online: false, wifi: false }],
  ])('%s', (_name, state, expected) => {
    expect(toNetState(state)).toEqual(expected);
  });
});

test('the adapter starts from the first read and follows the OS callback', () => {
  const net = fakeNetwork(CELL);
  const adapter = createNetAdapter(net.module, CELL);
  const seen: unknown[] = [];
  adapter.subscribe((s) => seen.push(s));

  expect(adapter.isOnline()).toBe(true);
  expect(adapter.isWifi()).toBe(false);

  net.change(WIFI);
  expect(adapter.isWifi()).toBe(true);
  net.change(NONE);
  expect(adapter.isOnline()).toBe(false);
  expect(adapter.isWifi()).toBe(false);

  expect(seen).toEqual([
    { online: true, wifi: true },
    { online: false, wifi: false },
  ]);
});

test('a repeat of the same state is not delivered, and an unsubscribed listener hears nothing', () => {
  const net = fakeNetwork(WIFI);
  const adapter = createNetAdapter(net.module, WIFI);
  const seen: unknown[] = [];
  const off = adapter.subscribe((s) => seen.push(s));

  net.change({ ...WIFI });
  expect(seen).toEqual([]);
  off();
  net.change(NONE);
  expect(seen).toEqual([]);
  // The state is still kept current for `isOnline()`.
  expect(adapter.isOnline()).toBe(false);
});

test('a listener that throws does not keep the change from the others', () => {
  const warn = jest.spyOn(console, 'warn').mockImplementation(() => {});
  const net = fakeNetwork(WIFI);
  const adapter = createNetAdapter(net.module, WIFI);
  const seen: unknown[] = [];
  adapter.subscribe(() => {
    throw new Error('boom');
  });
  adapter.subscribe((s) => seen.push(s));
  net.change(NONE);
  expect(seen).toEqual([{ online: false, wifi: false }]);
  warn.mockRestore();
});

test('createExpoNet reads once, attaches one native listener, and is shared by every caller', async () => {
  const net = fakeNetwork(WIFI);
  const load = jest.fn(async () => net.module);

  const a = await createExpoNet(load);
  const b = await createExpoNet(load);

  expect(a).toBe(b);
  expect(load).toHaveBeenCalledTimes(1);
  expect(net.reads()).toBe(1);
  expect(net.listeners).toHaveLength(1);
  expect(a.isWifi()).toBe(true);
});

test('createExpoNet rejects without the native module, and a later call tries again', async () => {
  await expect(
    createExpoNet(async () => {
      throw new Error('Cannot find native module ExpoNetwork');
    })
  ).rejects.toThrow('ExpoNetwork');

  const net = fakeNetwork(CELL);
  const adapter = await createExpoNet(async () => net.module);
  expect(adapter.isOnline()).toBe(true);
});

test('a first read that never answers rejects after the timeout instead of holding the launch', async () => {
  const hung: ExpoNetworkLike = {
    getNetworkStateAsync: () => new Promise(() => {}),
    addNetworkStateListener: () => ({ remove() {} }),
  };
  await expect(createExpoNet(async () => hung, 10)).rejects.toThrow('not read within 10 ms');
});

describe('useOnline', () => {
  test('before any adapter exists it does not claim offline', async () => {
    const { result } = await renderHook(() => useOnline());
    expect(result.current).toBe(true);
    expect(getSharedOnline()).toBe(true);
  });

  test('follows the shared adapter, including one created after the screen mounted', async () => {
    const net = fakeNetwork(NONE);
    const { result } = await renderHook(() => useOnline());
    expect(result.current).toBe(true);

    await act(async () => {
      await createExpoNet(async () => net.module);
    });
    expect(result.current).toBe(false);

    await act(async () => net.change(CELL));
    expect(result.current).toBe(true);
    await act(async () => net.change(NONE));
    expect(result.current).toBe(false);
  });
});

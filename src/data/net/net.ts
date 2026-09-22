/**
 * The device's network state, from `expo-network` (plan D2).
 *
 * One adapter per process. It reads the state once when it is created and then keeps it current
 * from the OS's own change callback (`NWPathMonitor` on iOS, `ConnectivityManager` on Android):
 * nothing here polls, runs a timer or makes a request (design §3.5), so holding it while the app
 * is armed but idle costs nothing but a listener the OS calls on a real change.
 *
 * Two readings come out of it:
 * - **online** — there is a connection *and* the OS has not said the internet is unreachable
 *   through it. On Android `isInternetReachable` needs a validated network, so a captive portal
 *   reads offline; on iOS it always equals `isConnected`.
 * - **wifi** — online over an unmetered link: Wi-Fi, or Ethernet. It is what the sync runner's
 *   `isWifi()` answers for "send the megabytes of a trace now". Cellular, a VPN whose underlying
 *   link the OS will not name, Bluetooth tethering and anything unknown are `false` — the safe
 *   answer for a driver's data plan.
 */
import type { NetStatus } from '@/data/sync/runner';

/** What a network change delivers to a subscriber. */
export interface NetState {
  online: boolean;
  wifi: boolean;
}

export interface NetAdapter extends NetStatus {
  isOnline(): boolean;
  /** Called on every change of either reading (not on a repeat of the same state). */
  subscribe(fn: (s: NetState) => void): () => void;
}

/** The slice of `expo-network`'s `NetworkState` this reads. */
export interface NetworkStateLike {
  type?: string;
  isConnected?: boolean;
  isInternetReachable?: boolean;
}

/** The slice of `expo-network` the adapter touches, or a test's stand-in for it. */
export interface ExpoNetworkLike {
  getNetworkStateAsync(): Promise<NetworkStateLike>;
  addNetworkStateListener(listener: (state: NetworkStateLike) => void): { remove(): void };
}

/** Link types that do not bill by the megabyte. Values of `expo-network`'s `NetworkStateType`. */
const UNMETERED = new Set(['WIFI', 'ETHERNET']);

/** `expo-network`'s state as the two readings the app acts on. */
export function toNetState(state: NetworkStateLike): NetState {
  const online = state.isConnected === true && state.isInternetReachable !== false;
  return { online, wifi: online && state.type !== undefined && UNMETERED.has(state.type) };
}

/**
 * An adapter over `network`, starting from `initial`. The listener is attached here and held for
 * the adapter's life, which is the process's: the runner and the screens subscribe to the adapter,
 * never to the native module, so there is only ever one native listener.
 */
export function createNetAdapter(network: ExpoNetworkLike, initial: NetworkStateLike): NetAdapter {
  let state = toNetState(initial);
  const listeners = new Set<(s: NetState) => void>();

  network.addNetworkStateListener((next) => {
    const mapped = toNetState(next);
    if (mapped.online === state.online && mapped.wifi === state.wifi) return;
    state = mapped;
    for (const listener of [...listeners]) {
      try {
        listener(mapped);
      } catch (error) {
        // One subscriber's bug must not keep the change from the others.
        if (__DEV__) console.warn('[net] listener threw:', error);
      }
    }
  });

  return {
    isOnline: () => state.online,
    isWifi: () => state.wifi,
    subscribe(fn) {
      listeners.add(fn);
      return () => {
        listeners.delete(fn);
      };
    },
  };
}

let created: Promise<NetAdapter> | null = null;

/**
 * The process's network adapter over `expo-network`, created once: a second call returns the
 * same one, so the launch and anything later share one native listener. It also becomes the
 * adapter `useOnline` reads. Rejects when the native module is missing (a build from before P1)
 * or the first read fails; the caller falls back to "never on Wi-Fi", and a later call tries again.
 */
export function createExpoNet(load?: () => Promise<ExpoNetworkLike>): Promise<NetAdapter> {
  if (created) return created;
  const attempt = (async () => {
    const network = await (load
      ? load()
      : (import('expo-network') as unknown as Promise<ExpoNetworkLike>));
    const initial = await network.getNetworkStateAsync();
    const adapter = createNetAdapter(network, initial);
    setSharedNet(adapter);
    return adapter;
  })();
  created = attempt;
  attempt.catch(() => {
    if (created === attempt) created = null;
  });
  return attempt;
}

// ---------------------------------------------------------------------------------------------
// The shared adapter, for screens (`useOnline`)
// ---------------------------------------------------------------------------------------------

let shared: NetAdapter | null = null;
let detachShared: (() => void) | null = null;
const onlineListeners = new Set<() => void>();

const notifyOnline = (): void => {
  for (const listener of [...onlineListeners]) listener();
};

/**
 * Make `adapter` the one screens read (`createExpoNet` does this itself). `null` detaches it, and
 * screens fall back to "assume online".
 */
export function setSharedNet(adapter: NetAdapter | null): void {
  detachShared?.();
  detachShared = null;
  shared = adapter;
  if (adapter) detachShared = adapter.subscribe(notifyOnline);
  notifyOnline();
}

/**
 * Whether screens should treat the device as online. With no adapter — before the launch has
 * created one, or in a build without the native module — the answer is `true`: a screen must not
 * say "you're offline" on a state nobody has read, and the map's own Hide control is the escape.
 */
export function getSharedOnline(): boolean {
  return shared?.isOnline() ?? true;
}

export function subscribeSharedOnline(listener: () => void): () => void {
  onlineListeners.add(listener);
  return () => {
    onlineListeners.delete(listener);
  };
}

/** Tests only: forget the created adapter and the shared one. */
export function resetNetForTests(): void {
  created = null;
  setSharedNet(null);
}

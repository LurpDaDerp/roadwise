// The DashPal byte pipe over react-native-ble-manager 12.5.3 (plan §3.3, §7.4). The only module that
// imports ble-manager, and only lazily (`getDashcamTransport`): its module constructor throws where
// the native module is missing (Jest, Expo Go). Everything else here runs on an injected `BleApi`,
// so the reconnect, restore, bond-loss and write-queue rules are tested against a fake.
//
// A process singleton, started from `index.ts` at module load when the SecureStore flag
// `dashpal.enabled` is set: it registers its listeners BEFORE `start()` (iOS state restoration emits
// once, during start), buffers frames until bootstrap attaches the link, and survives runtime stop and
// handover rebuilds (the link attaches and detaches; the listeners stay registered once).
//
// Connecting: iOS keeps a pending connect by peripheral id (it never times out); Android re-issues
// `connect(id, { autoconnect: true })` after every disconnect (ble-manager closes the GATT on
// disconnect). A connect call that errors backs off 1 → 30 s. After a connect: Android
// `requestMTU(247)`, `retrieveServices`, read INFO (open), let the link decide, then subscribe to TX;
// the link then asks for HELLO. One GATT operation is in flight at a time; ALERT_ACK jumps the queue.
//
// Bond loss → needs_repair (no reconnect loop, never an OS pairing dialog outside setup): iOS
// CBError 14 (peer removed pairing information) or ATT 5/15 (insufficient authentication or
// encryption); Android status 5, 15, 0x3D (MIC failure) or 0x06 (key missing); INFO peer_bonded = 0
// (the link's call); the paired MAC seen advertising the pairing service while the link has been down
// 20 s (the dashcam lost its bonds: reflashed).
import { IDENTIFY_BYTE, IDENTIFY_CHAR, INFO_CHAR, PAIRING_SERVICE, RX_CHAR, TX_CHAR, DASHPAL_SERVICE, decodeInfo, type DashcamInfo } from './protocol';
import type { BluetoothState, RepairCause } from './link';

export interface BleSub {
  remove(): void;
}

export interface BlePeripheralEvent {
  id: string;
  name?: string;
  rssi: number;
  advertising?: { serviceUUIDs?: string[]; localName?: string; isConnectable?: boolean };
}

/** The slice of react-native-ble-manager the transport uses (the real module satisfies it). */
export interface BleApi {
  start(opts: { showAlert?: boolean; restoreIdentifierKey?: string }): Promise<void>;
  checkState(): Promise<string>;
  scan(opts: { serviceUUIDs: string[]; seconds: number; allowDuplicates: boolean }): Promise<void>;
  stopScan(): Promise<void>;
  connect(id: string, opts?: { autoconnect?: boolean }): Promise<void>;
  disconnect(id: string, force?: boolean): Promise<void>;
  retrieveServices(id: string, serviceUUIDs?: string[]): Promise<unknown>;
  requestMTU(id: string, mtu: number): Promise<number>;
  read(id: string, service: string, characteristic: string): Promise<number[]>;
  write(id: string, service: string, characteristic: string, data: number[], maxByteSize?: number): Promise<void>;
  writeWithoutResponse(id: string, service: string, characteristic: string, data: number[], maxByteSize?: number): Promise<void>;
  startNotification(id: string, service: string, characteristic: string): Promise<void>;
  createBond(id: string): Promise<void>;
  removeBond(id: string): Promise<void>;
  getBondedPeripherals(): Promise<{ id: string }[]>;
  onDidUpdateState(cb: (e: { state: string }) => void): BleSub;
  onDisconnectPeripheral(cb: (e: { peripheral: string; status?: number; domain?: string; code?: number }) => void): BleSub;
  onDidUpdateValueForCharacteristic(cb: (e: { peripheral: string; characteristic: string; service: string; value: number[] }) => void): BleSub;
  onDiscoverPeripheral(cb: (e: BlePeripheralEvent) => void): BleSub;
  onCentralManagerWillRestoreState(cb: (e: { peripherals: { id: string }[] }) => void): BleSub;
}

/** What the transport tells the link (`DashcamLink` satisfies it). */
export interface TransportSink {
  setBluetooth(state: BluetoothState): void;
  connecting(): void;
  infoRead(info: DashcamInfo): boolean;
  linkUp(info: DashcamInfo): void;
  linkDown(): void;
  needsRepair(cause: RepairCause): void;
  frame(bytes: number[]): void;
}

export interface ScanHit {
  id: string;
  name: string | null;
  rssi: number;
  pairing: boolean;
}

export interface DashcamTransport {
  /** Create the central (iOS: the first time may show the Bluetooth permission prompt). Idempotent. */
  start(): Promise<void>;
  started(): boolean;
  bluetoothState(): BluetoothState;
  /** The first state that is not unknown/resetting (iOS answers the permission through it). */
  settledBluetoothState(timeoutMs?: number): Promise<BluetoothState>;
  onBluetoothState(fn: (s: BluetoothState) => void): () => void;
  attach(sink: TransportSink): () => void;
  /** The paired dashcam to keep connected; null cancels any connect. Clears a needs-repair halt. */
  setTarget(target: { peripheralId: string; dashcamId: string } | null): void;
  target(): { peripheralId: string; dashcamId: string } | null;
  /** Write one frame to the paired dashcam's RX. Rejects when not linked or on failure. */
  write(bytes: number[], opts: { withResponse: boolean; urgent?: boolean }): Promise<void>;
  linked(): boolean;
  // ——— setup (foreground, the driver's explicit action) ———
  scan(opts: { service: string; seconds: number; onHit(hit: ScanHit): void }): Promise<{ stop(): Promise<void> }>;
  setupConnect(peripheralId: string, timeoutMs?: number): Promise<void>;
  readInfo(peripheralId: string): Promise<DashcamInfo | null>;
  identify(peripheralId: string): Promise<void>;
  /** Make the OS bond (Android: drop a stale bond first, then createBond; iOS: an encrypted read). */
  bond(peripheralId: string): Promise<void>;
  subscribe(peripheralId: string, onFrame: (bytes: number[]) => void): Promise<() => void>;
  writeTo(peripheralId: string, bytes: number[]): Promise<void>;
  disconnect(peripheralId: string): Promise<void>;
  removeBond(peripheralId: string): Promise<void>;
}

export interface TransportOptions {
  platform: 'ios' | 'android';
  now?: () => number;
  setTimer?: (fn: () => void, ms: number) => unknown;
  clearTimer?: (h: unknown) => void;
  onError?: (e: unknown, ctx: string) => void;
}

export const RESTORE_ID = 'roadwise.dashpal.central';
export const MTU = 247;
export const BACKOFF_MIN_MS = 1000;
export const BACKOFF_MAX_MS = 30_000;
export const OP_TIMEOUT_MS = 10_000;
export const BOND_TIMEOUT_MS = 60_000;
export const SETUP_CONNECT_TIMEOUT_MS = 15_000;
export const FRAME_BUFFER_MAX = 256;
/** The paired MAC advertising the pairing service this long after the link went down: reflashed. */
export const REFLASH_DOWN_MS = 20_000;

const IOS_BOND_LOST_CODE = 14; // CBError.peerRemovedPairingInformation
const ATT_AUTH_CODES = new Set([5, 15]); // insufficient authentication / encryption
const ANDROID_BOND_LOST_STATUS = new Set([5, 15, 0x3d, 0x06]);

const same = (a: string, b: string): boolean => a.toLowerCase() === b.toLowerCase();

const STATES: readonly BluetoothState[] = ['unknown', 'resetting', 'unsupported', 'unauthorized', 'off', 'on', 'turning_on', 'turning_off'];
export const asBluetoothState = (s: unknown): BluetoothState => (STATES.includes(s as BluetoothState) ? (s as BluetoothState) : 'unknown');

/** Did this error (a ble-manager rejection) say the bond is gone? */
export function isBondLoss(err: unknown, platform: 'ios' | 'android'): boolean {
  if (err && typeof err === 'object') {
    const e = err as { code?: unknown; domain?: unknown };
    if (typeof e.code === 'number') {
      const domain = typeof e.domain === 'string' ? e.domain : '';
      if (domain === 'CBErrorDomain' && e.code === IOS_BOND_LOST_CODE) return true;
      if (domain === 'CBATTErrorDomain' && ATT_AUTH_CODES.has(e.code)) return true;
    }
  }
  if (platform === 'android') {
    const text = typeof err === 'string' ? err : err instanceof Error ? err.message : '';
    const m = /status=(\d+)/.exec(text);
    if (m && ANDROID_BOND_LOST_STATUS.has(Number(m[1]))) return true;
  }
  return false;
}

/** A disconnect event that says the bond is gone. */
function isBondLossDisconnect(e: { status?: number; domain?: string; code?: number }, platform: 'ios' | 'android'): boolean {
  if (platform === 'ios') return e.domain === 'CBErrorDomain' && e.code === IOS_BOND_LOST_CODE;
  return typeof e.status === 'number' && ANDROID_BOND_LOST_STATUS.has(e.status);
}

class TimeoutError extends Error {
  constructor(what: string) {
    super(`${what} timed out`);
    this.name = 'TimeoutError';
  }
}

export function createBleTransport(api: BleApi, opts: TransportOptions): DashcamTransport {
  const platform = opts.platform;
  const now = opts.now ?? Date.now;
  const setTimer = opts.setTimer ?? ((fn, ms) => setTimeout(fn, ms));
  const clearTimer = opts.clearTimer ?? ((h) => clearTimeout(h as ReturnType<typeof setTimeout>));

  let startPromise: Promise<void> | null = null;
  let isStarted = false;
  let bt: BluetoothState = 'unknown';
  const btListeners = new Set<(s: BluetoothState) => void>();
  let sink: TransportSink | null = null;
  const buffer: number[][] = [];
  let tgt: { peripheralId: string; dashcamId: string } | null = null;
  /** connection state of the target */
  let conn: 'down' | 'connecting' | 'setting_up' | 'up' = 'down';
  let linkInfo: DashcamInfo | null = null;
  /** a needs-repair halt: no reconnect until a new target */
  let halted = false;
  let repairCause: RepairCause | null = null;
  let attempt = 0;
  let backoffMs = BACKOFF_MIN_MS;
  let retryTimer: unknown = null;
  let downSince: number | null = null;
  /** peripherals restored by iOS before the target was known */
  let restored: string[] = [];
  const setupFrames = new Map<string, (bytes: number[]) => void>();
  let scanHit: ((e: BlePeripheralEvent) => void) | null = null;

  function report(e: unknown, ctx: string): void {
    try {
      opts.onError?.(e, ctx);
    } catch {
      // nobody left to tell
    }
  }

  function bounded<T>(p: Promise<T>, ms: number, what: string): Promise<T> {
    let timer: unknown = null;
    return Promise.race([
      p,
      new Promise<never>((_, reject) => {
        timer = setTimer(() => reject(new TimeoutError(what)), ms);
      }),
    ]).finally(() => clearTimer(timer));
  }

  // ——— one GATT op at a time; urgent ops first ———

  type Op = { run: () => Promise<unknown>; resolve: (v: unknown) => void; reject: (e: unknown) => void; what: string };
  const urgentOps: Op[] = [];
  const ops: Op[] = [];
  let opBusy = false;

  function gatt<T>(what: string, run: () => Promise<T>, urgent = false, timeoutMs = OP_TIMEOUT_MS): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      const op: Op = { run: () => bounded(run(), timeoutMs, what), resolve: resolve as (v: unknown) => void, reject, what };
      (urgent ? urgentOps : ops).push(op);
      drain();
    });
  }

  function drain(): void {
    if (opBusy) return;
    const op = urgentOps.shift() ?? ops.shift();
    if (!op) return;
    opBusy = true;
    let p: Promise<unknown>;
    try {
      p = op.run();
    } catch (e) {
      p = Promise.reject(e);
    }
    p.then(op.resolve, op.reject).finally(() => {
      opBusy = false;
      drain();
    });
  }

  function failQueued(reason: string): void {
    for (const op of [...urgentOps.splice(0), ...ops.splice(0)]) op.reject(new Error(reason));
  }

  // ——— state ———

  function setBt(s: BluetoothState): void {
    bt = s;
    sink?.setBluetooth(s);
    for (const fn of [...btListeners]) {
      try {
        fn(s);
      } catch (e) {
        report(e, 'bt listener');
      }
    }
    if (s === 'on') armConnect(0);
    if (s === 'off' || s === 'turning_off' || s === 'unauthorized' || s === 'unsupported') {
      if (conn !== 'down') markDown();
      cancelRetry();
    }
  }

  function markDown(): void {
    conn = 'down';
    linkInfo = null;
    downSince = now();
    buffer.length = 0;
    failQueued('the dashcam disconnected');
    sink?.linkDown();
  }

  function cancelRetry(): void {
    if (retryTimer !== null) clearTimer(retryTimer);
    retryTimer = null;
  }

  function needsRepair(cause: RepairCause): void {
    halted = true;
    repairCause = cause;
    cancelRetry();
    const id = tgt?.peripheralId;
    conn = 'down';
    linkInfo = null;
    failQueued('needs pairing again');
    sink?.needsRepair(cause);
    if (id) api.disconnect(id, true).catch((e: unknown) => report(e, 'disconnect (repair)'));
  }

  // ——— connecting ———

  function armConnect(delayMs: number): void {
    cancelRetry();
    if (!tgt || halted || !isStarted || conn !== 'down') return;
    // iOS refuses a connect before the central is powered on (API misuse: the request is dropped),
    // so it waits for the state event; Android reads its state at start.
    if (bt !== 'on' && !(platform === 'android' && bt === 'unknown')) return;
    if (delayMs <= 0) {
      connect();
      return;
    }
    retryTimer = setTimer(() => {
      retryTimer = null;
      connect();
    }, delayMs);
  }

  function connect(): void {
    const t = tgt;
    if (!t || halted || conn !== 'down') return;
    conn = 'connecting';
    attempt += 1;
    const mine = attempt;
    sink?.connecting();
    const call = platform === 'android' ? api.connect(t.peripheralId, { autoconnect: true }) : api.connect(t.peripheralId);
    call.then(
      () => {
        if (mine !== attempt || tgt !== t) {
          api.disconnect(t.peripheralId, true).catch((e: unknown) => report(e, 'disconnect (stale connect)'));
          return;
        }
        backoffMs = BACKOFF_MIN_MS;
        void onConnected(t);
      },
      (e: unknown) => {
        if (mine !== attempt || tgt !== t) return;
        report(e, 'connect');
        conn = 'down';
        if (isBondLoss(e, platform)) {
          needsRepair('bond_lost');
          return;
        }
        // Close a half-open GATT before the next try (Android 133 practice).
        api.disconnect(t.peripheralId, true).catch(() => {});
        const wait = backoffMs;
        backoffMs = Math.min(BACKOFF_MAX_MS, backoffMs * 2);
        armConnect(wait);
      }
    );
  }

  async function onConnected(t: { peripheralId: string; dashcamId: string }): Promise<void> {
    const id = t.peripheralId;
    conn = 'setting_up';
    try {
      if (platform === 'android') {
        await gatt('requestMTU', () => api.requestMTU(id, MTU)).catch((e: unknown) => report(e, 'requestMTU'));
      }
      await gatt('retrieveServices', () => api.retrieveServices(id));
      const info = decodeInfo(await gatt('read INFO', () => api.read(id, DASHPAL_SERVICE, INFO_CHAR)));
      if (tgt !== t) return;
      if (!info) throw new Error('INFO unreadable');
      // Checked here too, so it holds before bootstrap attached the link: a dashcam that does not
      // hold this phone's bond, or another dashcam, stops the sequence before anything encrypted
      // (which would raise the OS pairing dialog, possibly mid-drive). No reconnect loop.
      if (info.dashcamId !== t.dashcamId) {
        needsRepair('wrong_dashcam');
        return;
      }
      if (!info.peerBonded) {
        needsRepair('peer_not_bonded');
        return;
      }
      if (sink && !sink.infoRead(info)) {
        halted = true;
        conn = 'down';
        await api.disconnect(id, true).catch((e: unknown) => report(e, 'disconnect (info)'));
        return;
      }
      await gatt('startNotification', () => api.startNotification(id, DASHPAL_SERVICE, TX_CHAR));
      if (tgt !== t) return;
      conn = 'up';
      linkInfo = info;
      downSince = null;
      sink?.linkUp(info);
      flush();
    } catch (e) {
      report(e, 'link setup');
      if (tgt !== t) return;
      if (isBondLoss(e, platform)) {
        needsRepair('bond_lost');
        return;
      }
      // Drop the connection; the disconnect event re-arms the connect.
      api.disconnect(id, true).catch(() => {});
    }
  }

  function flush(): void {
    if (!sink || conn !== 'up') return;
    for (const bytes of buffer.splice(0)) sink.frame(bytes);
  }

  // ——— native events (registered once, before start) ———

  let listening = false;
  function listen(): void {
    if (listening) return;
    listening = true;
    api.onDidUpdateState((e) => setBt(asBluetoothState(e.state)));
    api.onCentralManagerWillRestoreState((e) => {
      const ids = (e.peripherals ?? []).map((p) => p.id);
      if (tgt === null) {
        restored = ids;
        return;
      }
      settleRestored(ids);
    });
    api.onDisconnectPeripheral((e) => {
      const t = tgt;
      if (!t || !same(e.peripheral, t.peripheralId)) return;
      if (halted) return;
      if (isBondLossDisconnect(e, platform)) {
        needsRepair('bond_lost');
        return;
      }
      const prev = conn;
      if (prev === 'up' || prev === 'setting_up') {
        markDown();
        // A link that was up: iOS a pending connect again at once; Android autoConnect again (the
        // GATT was closed).
        armConnect(0);
      } else if (prev === 'down' && retryTimer === null) {
        armConnect(backoffMs);
      }
      // 'connecting': the connect call's own rejection re-arms it, with the backoff.
    });
    api.onDidUpdateValueForCharacteristic((e) => {
      if (!same(e.characteristic, TX_CHAR)) return;
      const setup = [...setupFrames.entries()].find(([id]) => same(id, e.peripheral));
      if (setup) {
        setup[1](e.value);
        return;
      }
      const t = tgt;
      if (!t || !same(e.peripheral, t.peripheralId)) return;
      if (sink && conn === 'up') sink.frame(e.value);
      else if (buffer.length < FRAME_BUFFER_MAX) buffer.push(e.value);
    });
    api.onDiscoverPeripheral((e) => {
      const services = (e.advertising?.serviceUUIDs ?? []).map((u) => u.toLowerCase());
      const pairing = services.includes(PAIRING_SERVICE);
      const t = tgt;
      if (t && platform === 'android' && pairing && same(e.id, t.peripheralId) && conn === 'down' && !halted && downSince !== null && now() - downSince >= REFLASH_DOWN_MS) {
        needsRepair('reflashed');
      }
      scanHit?.(e);
    });
  }

  /** iOS restored these: keep the paired one (set it up), cancel the rest. */
  function settleRestored(ids: string[]): void {
    const t = tgt;
    for (const id of ids) {
      if (t && same(id, t.peripheralId)) {
        if (conn === 'down' && !halted) {
          cancelRetry();
          attempt += 1;
          void onConnected(t);
        }
      } else {
        api.disconnect(id, true).catch((e: unknown) => report(e, 'disconnect (restored)'));
      }
    }
  }

  const self: DashcamTransport = {
    start() {
      startPromise ??= (async () => {
        listen();
        await api.start({ showAlert: false, restoreIdentifierKey: RESTORE_ID });
        isStarted = true;
        // Android emits no state on start; iOS answers through onDidUpdateState (never call
        // checkState on iOS: with no manager it never answers).
        if (platform === 'android') {
          try {
            setBt(asBluetoothState(await api.checkState()));
          } catch (e) {
            report(e, 'checkState');
          }
        }
        armConnect(0);
      })().catch((e: unknown) => {
        startPromise = null;
        throw e;
      });
      return startPromise;
    },

    started: () => isStarted,
    bluetoothState: () => bt,

    settledBluetoothState(timeoutMs = 10_000) {
      if (bt !== 'unknown' && bt !== 'resetting') return Promise.resolve(bt);
      return new Promise<BluetoothState>((resolve) => {
        let timer: unknown = null;
        const off = self.onBluetoothState((s) => {
          if (s === 'unknown' || s === 'resetting') return;
          off();
          clearTimer(timer);
          resolve(s);
        });
        timer = setTimer(() => {
          off();
          resolve(bt);
        }, timeoutMs);
      });
    },

    onBluetoothState(fn) {
      btListeners.add(fn);
      return () => {
        btListeners.delete(fn);
      };
    },

    attach(next) {
      sink = next;
      next.setBluetooth(bt);
      if (halted && repairCause) {
        next.needsRepair(repairCause);
      } else if (conn === 'up' && linkInfo) {
        next.linkUp(linkInfo);
        flush();
      } else if (conn === 'connecting' || conn === 'setting_up') {
        next.connecting();
      }
      return () => {
        if (sink === next) sink = null;
      };
    },

    setTarget(next) {
      const before = tgt;
      const changed = !before || !next || !same(before.peripheralId, next.peripheralId) || before.dashcamId !== next.dashcamId;
      if (!changed && !halted) return;
      tgt = next;
      halted = false;
      repairCause = null;
      backoffMs = BACKOFF_MIN_MS;
      attempt += 1;
      cancelRetry();
      if (before && (!next || !same(before.peripheralId, next.peripheralId))) {
        const wasActive = conn !== 'down';
        conn = 'down';
        linkInfo = null;
        buffer.length = 0;
        failQueued('the target changed');
        // Cancels a pending connect too (iOS cancelPeripheralConnection; Android disconnect+close).
        api.disconnect(before.peripheralId, true).catch((e: unknown) => report(e, 'disconnect (target)'));
        if (wasActive) sink?.linkDown();
      }
      if (next && restored.length > 0) {
        const ids = restored;
        restored = [];
        settleRestored(ids);
      }
      if (next && conn === 'down') armConnect(0);
    },

    target: () => tgt,

    write(bytes, o) {
      const t = tgt;
      if (!t || conn !== 'up') return Promise.reject(new Error('the dashcam is not connected'));
      const id = t.peripheralId;
      return gatt(
        o.withResponse ? 'write' : 'writeWithoutResponse',
        () => (o.withResponse ? api.write(id, DASHPAL_SERVICE, RX_CHAR, bytes, 20) : api.writeWithoutResponse(id, DASHPAL_SERVICE, RX_CHAR, bytes, 20)),
        o.urgent === true
      ).then(
        () => undefined,
        (e: unknown) => {
          if (isBondLoss(e, platform) && tgt === t) needsRepair('bond_lost');
          throw e;
        }
      );
    },

    linked: () => conn === 'up',

    async scan({ service, seconds, onHit }) {
      await self.start();
      scanHit = (e) => {
        const services = (e.advertising?.serviceUUIDs ?? []).map((u) => u.toLowerCase());
        if (!services.includes(service.toLowerCase())) return;
        onHit({ id: e.id, name: e.advertising?.localName ?? e.name ?? null, rssi: e.rssi, pairing: services.includes(PAIRING_SERVICE) });
      };
      await api.scan({ serviceUUIDs: [service], seconds, allowDuplicates: false });
      return {
        stop: async () => {
          scanHit = null;
          await api.stopScan().catch((e: unknown) => report(e, 'stopScan'));
        },
      };
    },

    async setupConnect(peripheralId, timeoutMs = SETUP_CONNECT_TIMEOUT_MS) {
      await self.start();
      try {
        await bounded(api.connect(peripheralId), timeoutMs, 'connect');
      } catch (e) {
        await api.disconnect(peripheralId, true).catch(() => {});
        throw e;
      }
      if (platform === 'android') await gatt('requestMTU', () => api.requestMTU(peripheralId, MTU)).catch((e: unknown) => report(e, 'requestMTU'));
      await gatt('retrieveServices', () => api.retrieveServices(peripheralId));
    },

    async readInfo(peripheralId) {
      return decodeInfo(await gatt('read INFO', () => api.read(peripheralId, DASHPAL_SERVICE, INFO_CHAR)));
    },

    async identify(peripheralId) {
      await gatt('identify', () => api.write(peripheralId, DASHPAL_SERVICE, IDENTIFY_CHAR, [IDENTIFY_BYTE], 20));
    },

    async bond(peripheralId) {
      if (platform === 'android') {
        const bonded = await gatt('getBondedPeripherals', () => api.getBondedPeripherals());
        if (bonded.some((p) => same(p.id, peripheralId))) {
          // A stale bond (the dashcam was reflashed or forgot this phone): drop it first, or
          // createBond would report success on the old keys.
          await gatt('removeBond', () => api.removeBond(peripheralId));
        }
        await gatt('createBond', () => api.createBond(peripheralId), false, BOND_TIMEOUT_MS);
        return;
      }
      // iOS: the first encrypted access makes the system pairing dialog appear; the read resolves
      // once the link is encrypted (and bonded).
      await gatt('read TX (pairing)', () => api.read(peripheralId, DASHPAL_SERVICE, TX_CHAR), false, BOND_TIMEOUT_MS);
    },

    async subscribe(peripheralId, onFrame) {
      setupFrames.set(peripheralId, onFrame);
      await gatt('startNotification', () => api.startNotification(peripheralId, DASHPAL_SERVICE, TX_CHAR));
      return () => {
        setupFrames.delete(peripheralId);
      };
    },

    async writeTo(peripheralId, bytes) {
      await gatt('write', () => api.write(peripheralId, DASHPAL_SERVICE, RX_CHAR, bytes, 20));
    },

    async disconnect(peripheralId) {
      setupFrames.delete(peripheralId);
      await api.disconnect(peripheralId, true);
    },

    async removeBond(peripheralId) {
      if (platform !== 'android') return;
      await gatt('removeBond', () => api.removeBond(peripheralId));
    },
  };
  return self;
}

// ——— the process singleton ———

let singleton: DashcamTransport | null = null;

/** The app's one transport over the real ble-manager, created on first use. */
export function getDashcamTransport(): DashcamTransport {
  if (singleton) return singleton;
  /* eslint-disable @typescript-eslint/no-require-imports -- deferred: the native module (absent in Jest) */
  const { Platform } = require('react-native') as typeof import('react-native');
  const BleManager = (require('react-native-ble-manager') as { default: unknown }).default as BleApi;
  /* eslint-enable @typescript-eslint/no-require-imports */
  singleton = createBleTransport(BleManager, {
    platform: Platform.OS === 'ios' ? 'ios' : 'android',
    onError: (e, ctx) => {
      if (__DEV__) console.warn(`[dashpal] ${ctx}:`, e);
    },
  });
  return singleton;
}

/** Tests only: install a transport (or null) as the singleton. */
export function setDashcamTransportForTests(t: DashcamTransport | null): void {
  singleton = t;
}

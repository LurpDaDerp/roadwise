// The DashPal byte pipe over react-native-ble-manager 12.5.3 (plan §3.3, §7.4; link v2: pairing v2
// §8). The only module that imports ble-manager, and only lazily (`getDashcamTransport`): its module
// constructor throws where the native module is missing (Jest, Expo Go). Everything else here runs
// on an injected `BleApi`, so the reconnect, restore, session and write-queue rules are tested
// against a fake.
//
// A process singleton, started from `index.ts` at module load when the SecureStore flag
// `dashpal.enabled` is set: it registers its listeners BEFORE `start()` (iOS state restoration emits
// once, during start), buffers frames until bootstrap attaches the link, and survives runtime stop and
// handover rebuilds (the link attaches and detaches; the listeners stay registered once).
//
// There is no Bluetooth bonding: every connection proves the pairing key on both sides
// (docs/BLE_PROTOCOL.md §2.2) and every frame travels sealed (§3.3). After a connect: Android
// `requestMTU(247)`, `retrieveServices` (no AUTH characteristic: Android refreshes its cache once),
// read INFO (`mac`, link v2, this connection's `Nc`), then SESSION_REQ / SESSION_RESP (the dashcam's
// proof checked) / SESSION_FIN / RESULT, all within 5 s; then subscribe to TX and the link asks for
// HELLO. Nothing sealed is ever sent before the dashcam proved itself. Each handshake step waits on a
// native callback only, so it completes with JS timers paused (Android in the background).
//
// Results (§8.2): R_UNKNOWN_PHONE or INFO below link v2 is a soft repair (`needs_repair`): never a
// halt, retried in 30 s and then every 60 s, or at once when RoadWise comes to the front or a drive
// starts (`retryNow`), until a verified session clears it. A wrong dashcam proof, another `mac`, or
// (iOS) no AUTH characteristic is a failed verification: disconnect, the usual backoff (1 -> 30 s), and
// after 3 in a row `unverified`, still retrying. A non-zero ATT status on an AUTH write, a GATT error,
// a timeout or a disconnect before a verdict is read is a transport fault: disconnect and back off;
// never a verdict. The backoff resets only when a session is up.
//
// Connecting: iOS keeps a pending connect by peripheral id (it never times out); Android re-issues
// `connect(id, { autoconnect: true })` after every disconnect (ble-manager closes the GATT on
// disconnect). One GATT operation is in flight at a time; ALERT_ACK jumps the queue, and every frame
// is sealed as its operation runs, so counters rise in the order frames go out.
import { processTimers } from '@/lib/timers';

import { createSealer, parseAuthRecord, proofOk, R, sessionFin, sessionKeys, sessionRequest, type AuthRecord, type Sealer } from './auth';
import { randomBytes, wipe } from './crypto';
import { AUTH_CHAR, DASHPAL_SERVICE, INFO_CHAR, PAIRING_SERVICE, RX_CHAR, TX_CHAR, decodeInfo, fromHex, speaksLink, type DashcamInfo } from './protocol';
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

/** `retrieveServices`'s answer, as far as the transport reads it. */
export interface BleServicesInfo {
  characteristics?: { service: string; characteristic: string }[];
}

/** The slice of react-native-ble-manager the transport uses (the real module satisfies it). */
export interface BleApi {
  start(opts: { showAlert?: boolean; restoreIdentifierKey?: string }): Promise<void>;
  checkState(): Promise<string>;
  /** `scanMode` 2 LowLatency, `matchMode` 1 Aggressive (Android only; ble-manager defaults to LowPower). */
  scan(opts: { serviceUUIDs: string[]; seconds: number; allowDuplicates: boolean; scanMode?: number; matchMode?: number }): Promise<void>;
  stopScan(): Promise<void>;
  connect(id: string, opts?: { autoconnect?: boolean }): Promise<void>;
  disconnect(id: string, force?: boolean): Promise<void>;
  retrieveServices(id: string, serviceUUIDs?: string[]): Promise<BleServicesInfo | unknown>;
  /** Android: drop the GATT cache (a table that changed shape without a Service Changed indication). */
  refreshCache?(id: string): Promise<boolean>;
  requestMTU(id: string, mtu: number): Promise<number>;
  read(id: string, service: string, characteristic: string): Promise<number[]>;
  write(id: string, service: string, characteristic: string, data: number[], maxByteSize?: number): Promise<void>;
  writeWithoutResponse(id: string, service: string, characteristic: string, data: number[], maxByteSize?: number): Promise<void>;
  startNotification(id: string, service: string, characteristic: string): Promise<void>;
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
  /** INFO was read (the firmware version). False: drop this connection (and try again later). */
  infoRead(info: DashcamInfo): boolean;
  linkUp(info: DashcamInfo): void;
  linkDown(): void;
  /** A soft repair: the dashcam says it does not know this phone, or answers below link v2. Retried. */
  needsRepair(cause: RepairCause): void;
  /** Three verifications in a row failed (a device at the paired address that cannot prove it is the DashPal). Retried. */
  unverified(): void;
  frame(bytes: number[]): void;
}

export interface ScanHit {
  id: string;
  name: string | null;
  rssi: number;
  pairing: boolean;
}

/** This phone's key with the paired DashPal (`dashpal.auth`): its id there and the pairing key, hex. */
export interface SessionAuth {
  phoneId: string;
  kPair: string;
}

export interface TransportTarget {
  peripheralId: string;
  dashcamId: string;
  auth: SessionAuth;
}

/** How a session handshake ended (`up` carries the sealer of the new session). */
export type SessionOutcome =
  | { kind: 'up'; sealer: Sealer }
  | { kind: 'unknown_phone' }
  | { kind: 'unverified' }
  | { kind: 'wrong_proof' }
  | { kind: 'not_now' }
  | { kind: 'mtu' }
  | { kind: 'fault'; why: string };

export interface DashcamTransport {
  /** Create the central (iOS: the first time may show the Bluetooth permission prompt). Idempotent. */
  start(): Promise<void>;
  started(): boolean;
  bluetoothState(): BluetoothState;
  /** The first state that is not unknown/resetting (iOS answers the permission through it). */
  settledBluetoothState(timeoutMs?: number): Promise<BluetoothState>;
  onBluetoothState(fn: (s: BluetoothState) => void): () => void;
  attach(sink: TransportSink): () => void;
  /** The paired dashcam to keep connected (with this phone's key); null cancels any connect. */
  setTarget(target: TransportTarget | null): void;
  target(): TransportTarget | null;
  /** A soft repair or a backoff is waiting: try now (RoadWise came to the front, a drive started). */
  retryNow(): void;
  /** Write one frame (sealed) to the paired dashcam's RX. Rejects when not linked or on failure. */
  write(bytes: number[], opts: { withResponse: boolean; urgent?: boolean }): Promise<void>;
  linked(): boolean;
  // ——— setup (foreground, the driver's explicit action) ———
  /** `fast`: Android scans in low-latency mode (setup); otherwise the platform default (the nearby prompt). */
  scan(opts: { services: string[]; seconds: number; onHit(hit: ScanHit): void; fast?: boolean }): Promise<{ stop(): Promise<void> }>;
  /**
   * Connect for setup. Android: an OS bond with this peripheral (left from link v1) is removed first,
   * only when the phone lists one (ble-manager's removeBond never settles without a bond). Resolves
   * with whether the AUTH characteristic was found (Android refreshes its cache once first).
   */
  setupConnect(peripheralId: string, opts?: { timeoutMs?: number }): Promise<{ auth: boolean }>;
  /** The setup connection to this peripheral is still up (no disconnect since `setupConnect`). */
  setupLinkUp(peripheralId: string): boolean;
  readInfo(peripheralId: string): Promise<DashcamInfo | null>;
  /** One AUTH write: `ok` (ATT 0) or `fault` (any other status, a GATT error, a timeout): never a verdict. */
  authWrite(peripheralId: string, bytes: Uint8Array): Promise<'ok' | 'fault'>;
  /** The AUTH read value, or `fault`. */
  authRead(peripheralId: string): Promise<AuthRecord | 'fault'>;
  /** Android: ask for MTU 247 again (an R_MTU answer). iOS: nothing to ask. */
  requestMtu(peripheralId: string): Promise<void>;
  /** The session handshake on a setup connection (after a stored pairing): its sealer is kept for it. */
  startSession(peripheralId: string, info: DashcamInfo, auth: SessionAuth): Promise<SessionOutcome>;
  subscribeSealed(peripheralId: string, onFrame: (bytes: number[]) => void): Promise<() => void>;
  writeSealed(peripheralId: string, bytes: number[]): Promise<void>;
  disconnect(peripheralId: string): Promise<void>;
}

export interface TransportOptions {
  platform: 'ios' | 'android';
  now?: () => number;
  setTimer?: (fn: () => void, ms: number) => unknown;
  clearTimer?: (h: unknown) => void;
  /**
   * Called as each native BLE event arrives (a frame, a disconnect): fires the pumped timers that
   * are due, which Android leaves unfired while the app is in the background.
   */
  pump?: () => void;
  onError?: (e: unknown, ctx: string) => void;
  /** Random bytes (tests); default the platform's secure source. */
  random?: (n: number) => Uint8Array;
}

export const RESTORE_ID = 'roadwise.dashpal.central';
export const MTU = 247;
export const BACKOFF_MIN_MS = 1000;
export const BACKOFF_MAX_MS = 30_000;
/** A soft repair's first retry, then every `SOFT_REPAIR_EVERY_MS`. */
export const SOFT_REPAIR_FIRST_MS = 30_000;
export const SOFT_REPAIR_EVERY_MS = 60_000;
/** Failed verifications in a row before the link reads `unverified`. */
export const UNVERIFIED_AFTER = 3;
/** Frames that fail to open in one session before the phone drops the connection. */
export const SEAL_FAIL_MAX = 32;
export const OP_TIMEOUT_MS = 10_000;
/** The whole session handshake, from the SESSION_REQ to the RESULT read. */
export const SESSION_MS = 5000;
/** AUTH reads in a row while the answer is pending (no timer between them). */
export const PENDING_READS = 10;
/** iOS: an R_MTU waits this long (the MTU exchange may still be running) before asking again. */
export const IOS_MTU_WAIT_MS = 300;
export const SETUP_CONNECT_TIMEOUT_MS = 15_000;
export const FRAME_BUFFER_MAX = 256;
/** RX writes and AUTH writes are never split by ble-manager: one sealed frame (≤ 40) or AUTH message (≤ 98) per write. */
export const RX_MAX_BYTES = 64;
export const AUTH_MAX_BYTES = 128;

const IOS_BOND_LOST_CODE = 14; // CBError.peerRemovedPairingInformation
const ATT_AUTH_CODES = new Set([5, 15]); // insufficient authentication / encryption

const same = (a: string, b: string): boolean => a.toLowerCase() === b.toLowerCase();

const STATES: readonly BluetoothState[] = ['unknown', 'resetting', 'unsupported', 'unauthorized', 'off', 'on', 'turning_on', 'turning_off'];
export const asBluetoothState = (s: unknown): BluetoothState => (STATES.includes(s as BluetoothState) ? (s as BluetoothState) : 'unknown');

/**
 * iOS: the phone still holds a link v1 Bluetooth bond with the DashPal (CBError 14, or ATT 5/15 on
 * an access): the driver must forget it in Settings › Bluetooth before the setup can connect.
 */
export function isIosBondLoss(err: unknown): boolean {
  if (err && typeof err === 'object') {
    const e = err as { code?: unknown; domain?: unknown };
    if (typeof e.code === 'number') {
      const domain = typeof e.domain === 'string' ? e.domain : '';
      if (domain === 'CBErrorDomain' && e.code === IOS_BOND_LOST_CODE) return true;
      if (domain === 'CBATTErrorDomain' && ATT_AUTH_CODES.has(e.code)) return true;
    }
  }
  return false;
}

/** The services answer lists the AUTH characteristic. */
function hasAuthChar(services: unknown): boolean {
  const list = (services as BleServicesInfo | null)?.characteristics;
  return Array.isArray(list) && list.some((c) => typeof c?.characteristic === 'string' && same(c.characteristic, AUTH_CHAR));
}

class TimeoutError extends Error {
  constructor(what: string) {
    super(`${what} timed out`);
    this.name = 'TimeoutError';
  }
}

export function createBleTransport(api: BleApi, opts: TransportOptions): DashcamTransport {
  const platform = opts.platform;
  const setTimer = opts.setTimer ?? ((fn, ms) => setTimeout(fn, ms));
  const clearTimer = opts.clearTimer ?? ((h) => clearTimeout(h as ReturnType<typeof setTimeout>));
  const random = opts.random ?? randomBytes;

  let startPromise: Promise<void> | null = null;
  let isStarted = false;
  let bt: BluetoothState = 'unknown';
  const btListeners = new Set<(s: BluetoothState) => void>();
  let sink: TransportSink | null = null;
  /** opened frames that arrived before a sink was attached */
  const buffer: number[][] = [];
  let tgt: TransportTarget | null = null;
  /** connection state of the target */
  let conn: 'down' | 'connecting' | 'setting_up' | 'up' = 'down';
  let linkInfo: DashcamInfo | null = null;
  /** the current session's sealer (only while `up`) */
  let sealer: Sealer | null = null;
  let sealFails = 0;
  let attempt = 0;
  let backoffMs = BACKOFF_MIN_MS;
  let retryTimer: unknown = null;
  /** a soft repair under way, and how many of its retries have been armed */
  let soft: RepairCause | null = null;
  let softRetries = 0;
  let verifyFailures = 0;
  /** peripherals restored by iOS before the target was known */
  let restored: string[] = [];
  /** setup connections that are up (lowercase peripheral ids), their sealers and frame handlers */
  const setupLinks = new Set<string>();
  const setupSealers = new Map<string, Sealer>();
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

  const sleep = (ms: number): Promise<void> => new Promise<void>((resolve) => setTimer(resolve, ms));

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

  // ——— AUTH, shared by the auto-connect and setup ———

  async function authWriteOp(id: string, bytes: Uint8Array): Promise<'ok' | 'fault'> {
    try {
      await gatt('write AUTH', () => api.write(id, DASHPAL_SERVICE, AUTH_CHAR, Array.from(bytes), AUTH_MAX_BYTES));
      return 'ok';
    } catch (e) {
      report(e, 'write AUTH');
      return 'fault';
    }
  }

  async function authReadOp(id: string): Promise<AuthRecord | 'fault'> {
    try {
      const rec = parseAuthRecord(await gatt('read AUTH', () => api.read(id, DASHPAL_SERVICE, AUTH_CHAR)));
      return rec.kind === 'bad' ? 'fault' : rec;
    } catch (e) {
      report(e, 'read AUTH');
      return 'fault';
    }
  }

  /** The answer to the last AUTH write: a few reads in a row while it is pending, no timer between. */
  async function answer(id: string): Promise<AuthRecord | 'fault'> {
    for (let i = 0; i < PENDING_READS; i++) {
      const rec = await authReadOp(id);
      if (rec === 'fault' || rec.kind !== 'pending') return rec;
    }
    return 'fault';
  }

  /**
   * The session handshake (§2.2) over INFO's `Nc`. `maybeUp`: the dashcam may already hold a session
   * on this connection (an iOS restore), so a wrong proof is answered once more on the same link.
   */
  async function runSession(id: string, first: DashcamInfo, auth: SessionAuth, o: { maybeUp: boolean; alive: () => boolean }): Promise<SessionOutcome> {
    const kPair = Uint8Array.from(fromHex(auth.kPair));
    const phoneId = Uint8Array.from(fromHex(auth.phoneId));
    if (kPair.length !== 32 || phoneId.length !== 8) return { kind: 'fault', why: 'no key' };
    let info = first;
    let mtuRetried = false;
    let proofRetried = false;
    try {
      for (;;) {
        if (!o.alive()) return { kind: 'fault', why: 'gone' };
        const nc = info.nonce;
        if (!nc) return { kind: 'fault', why: 'no Nc' };
        const np = random(16);
        if ((await authWriteOp(id, sessionRequest(kPair, info.mac, nc, np))) === 'fault') return { kind: 'fault', why: 'SESSION_REQ write' };
        const resp = await answer(id);
        if (resp === 'fault') return { kind: 'fault', why: 'SESSION_RESP read' };
        if (resp.kind === 'result') {
          if (resp.code === R.MTU && !mtuRetried) {
            mtuRetried = true;
            if (platform === 'android') await gatt('requestMTU', () => api.requestMTU(id, MTU)).catch((e: unknown) => report(e, 'requestMTU'));
            else await sleep(IOS_MTU_WAIT_MS);
            const again = decodeInfo(await gatt('read INFO', () => api.read(id, DASHPAL_SERVICE, INFO_CHAR)));
            if (!again || again.dashcamId !== first.dashcamId) return { kind: 'fault', why: 'INFO after R_MTU' };
            info = again;
            continue;
          }
          if (resp.code === R.MTU) return { kind: 'mtu' };
          if (resp.code === R.UNKNOWN_PHONE) return { kind: 'unknown_phone' };
          if (resp.code === R.NOT_NOW) return { kind: 'not_now' };
          return { kind: 'fault', why: `SESSION_REQ result ${resp.code}` };
        }
        if (resp.kind !== 'session_resp') return { kind: 'fault', why: 'SESSION_REQ answer' };
        const keys = sessionKeys(kPair, info.mac, phoneId, np, resp.Nd);
        if (!proofOk(keys.proofD, resp.proofD)) {
          wipe(keys.k_dp);
          wipe(keys.k_pd);
          return { kind: 'unverified' };
        }
        if ((await authWriteOp(id, sessionFin(keys.proofP))) === 'fault') return { kind: 'fault', why: 'SESSION_FIN write' };
        const res = await answer(id);
        if (res === 'fault' || res.kind !== 'result') return { kind: 'fault', why: 'SESSION_FIN read' };
        if (res.code === R.OK) {
          const s = createSealer({ send: keys.k_pd, recv: keys.k_dp });
          wipe(keys.k_dp);
          wipe(keys.k_pd);
          wipe(keys.k_conf);
          return { kind: 'up', sealer: s };
        }
        wipe(keys.k_dp);
        wipe(keys.k_pd);
        if (res.code === R.WRONG_PROOF && o.maybeUp && !proofRetried) {
          // The dashcam proved itself; only an injected request or a corrupted write explains this.
          proofRetried = true;
          const again = decodeInfo(await gatt('read INFO', () => api.read(id, DASHPAL_SERVICE, INFO_CHAR)));
          if (!again || again.dashcamId !== first.dashcamId) return { kind: 'fault', why: 'INFO after R_WRONG_PROOF' };
          info = again;
          continue;
        }
        if (res.code === R.WRONG_PROOF) return { kind: 'wrong_proof' };
        if (res.code === R.NOT_NOW) return { kind: 'not_now' };
        if (res.code === R.UNKNOWN_PHONE) return { kind: 'unknown_phone' };
        return { kind: 'fault', why: `SESSION_FIN result ${res.code}` };
      }
    } finally {
      wipe(kPair);
    }
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

  function endSession(): void {
    sealer?.dispose();
    sealer = null;
    sealFails = 0;
  }

  function markDown(): void {
    const was = conn;
    conn = 'down';
    linkInfo = null;
    endSession();
    buffer.length = 0;
    failQueued('the dashcam disconnected');
    if (was !== 'down') sink?.linkDown();
  }

  function cancelRetry(): void {
    if (retryTimer !== null) clearTimer(retryTimer);
    retryTimer = null;
  }

  /** Drop this connection and try again after `delayMs` (the disconnect event then changes nothing). */
  function dropAndRetry(t: TransportTarget, delayMs: number, ctx: string): void {
    if (tgt !== t) return;
    markDown();
    api.disconnect(t.peripheralId, true).catch((e: unknown) => report(e, `disconnect (${ctx})`));
    armConnect(Math.max(1, delayMs));
  }

  /** A transport fault: disconnect, back off (1 -> 30 s). Never a verdict. */
  function fault(t: TransportTarget, ctx: string, e?: unknown): void {
    report(e ?? new Error(ctx), ctx);
    const wait = backoffMs;
    backoffMs = Math.min(BACKOFF_MAX_MS, backoffMs * 2);
    dropAndRetry(t, wait, ctx);
  }

  /** The dashcam does not know this phone, or speaks an older link: retried slowly, never halted. */
  function softRepair(t: TransportTarget, cause: RepairCause): void {
    if (tgt !== t) return;
    soft = cause;
    const wait = softRetries === 0 ? SOFT_REPAIR_FIRST_MS : SOFT_REPAIR_EVERY_MS;
    softRetries += 1;
    sink?.needsRepair(cause);
    dropAndRetry(t, wait, `soft repair ${cause}`);
  }

  /** The device at the paired address could not prove it is the DashPal. */
  function verifyFailed(t: TransportTarget, ctx: string): void {
    if (tgt !== t) return;
    verifyFailures += 1;
    report(new Error(ctx), 'verification failed');
    if (verifyFailures >= UNVERIFIED_AFTER) sink?.unverified();
    const wait = backoffMs;
    backoffMs = Math.min(BACKOFF_MAX_MS, backoffMs * 2);
    dropAndRetry(t, wait, ctx);
  }

  // ——— connecting ———

  function armConnect(delayMs: number): void {
    cancelRetry();
    if (!tgt || !isStarted || conn !== 'down') return;
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
    if (!t || conn !== 'down') return;
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
        void onConnected(t, { maybeUp: false });
      },
      (e: unknown) => {
        if (mine !== attempt || tgt !== t) return;
        report(e, 'connect');
        conn = 'down';
        // Close a half-open GATT before the next try (Android 133 practice).
        api.disconnect(t.peripheralId, true).catch(() => {});
        const wait = backoffMs;
        backoffMs = Math.min(BACKOFF_MAX_MS, backoffMs * 2);
        armConnect(wait);
      }
    );
  }

  async function onConnected(t: TransportTarget, o: { maybeUp: boolean }): Promise<void> {
    const id = t.peripheralId;
    conn = 'setting_up';
    endSession();
    try {
      if (platform === 'android') {
        await gatt('requestMTU', () => api.requestMTU(id, MTU)).catch((e: unknown) => report(e, 'requestMTU'));
      }
      let services = await gatt('retrieveServices', () => api.retrieveServices(id));
      if (!hasAuthChar(services) && platform === 'android' && api.refreshCache) {
        await gatt('refreshCache', () => api.refreshCache!(id)).catch((e: unknown) => report(e, 'refreshCache'));
        services = await gatt('retrieveServices', () => api.retrieveServices(id));
      }
      if (tgt !== t) return;
      if (!hasAuthChar(services)) {
        // iOS has no cache refresh and, with no bonding, no Service Changed: it may never find AUTH.
        if (platform === 'ios') verifyFailed(t, 'auth_char_missing');
        else fault(t, 'auth_char_missing');
        return;
      }
      const info = decodeInfo(await gatt('read INFO', () => api.read(id, DASHPAL_SERVICE, INFO_CHAR)));
      if (tgt !== t) return;
      if (!info) throw new Error('INFO unreadable');
      if (info.dashcamId !== t.dashcamId) {
        verifyFailed(t, 'INFO mac mismatch');
        return;
      }
      if (!speaksLink(info)) {
        softRepair(t, 'downgrade');
        return;
      }
      if (sink && !sink.infoRead(info)) {
        fault(t, 'the link refused this DashPal');
        return;
      }
      const outcome = await bounded(runSession(id, info, t.auth, { maybeUp: o.maybeUp, alive: () => tgt === t && conn === 'setting_up' }), SESSION_MS, 'session');
      if (tgt !== t || conn !== 'setting_up') {
        if (outcome.kind === 'up') outcome.sealer.dispose();
        return;
      }
      switch (outcome.kind) {
        case 'up':
          break;
        case 'unknown_phone':
          softRepair(t, 'unknown_phone');
          return;
        case 'unverified':
          verifyFailed(t, 'wrong dashcam proof');
          return;
        default:
          fault(t, `session ${outcome.kind}${outcome.kind === 'fault' ? ` (${outcome.why})` : ''}`);
          return;
      }
      sealer = outcome.sealer;
      sealFails = 0;
      await gatt('startNotification', () => api.startNotification(id, DASHPAL_SERVICE, TX_CHAR));
      if (tgt !== t || conn !== 'setting_up') return;
      conn = 'up';
      linkInfo = info;
      backoffMs = BACKOFF_MIN_MS;
      soft = null;
      softRetries = 0;
      verifyFailures = 0;
      sink?.linkUp(info);
      flush();
    } catch (e) {
      if (tgt !== t) return;
      fault(t, 'link setup', e);
    }
  }

  function flush(): void {
    if (!sink || conn !== 'up') return;
    for (const bytes of buffer.splice(0)) sink.frame(bytes);
  }

  /** A TX notification of the paired dashcam: opened under the session, else dropped. */
  function onTargetFrame(t: TransportTarget, value: number[]): void {
    const s = sealer;
    // Before a session (an iOS restore with the subscription kept): dropped, not counted.
    if (!s || (conn !== 'up' && conn !== 'setting_up')) return;
    const r = s.open(value);
    if (!r.ok) {
      if (r.why === 'replay') return;
      sealFails += 1;
      if (sealFails >= SEAL_FAIL_MAX) fault(t, 'too many frames that did not open');
      return;
    }
    if (sink && conn === 'up') sink.frame(r.frame);
    else if (buffer.length < FRAME_BUFFER_MAX) buffer.push(r.frame);
  }

  // ——— native events (registered once, before start) ———

  /** A native event reached JS: timers JS left unfired (Android, background) fire now if due. */
  function pump(): void {
    try {
      opts.pump?.();
    } catch (e) {
      report(e, 'timers');
    }
  }

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
      pump();
      const lower = e.peripheral.toLowerCase();
      setupLinks.delete(lower);
      const ss = [...setupSealers.entries()].find(([id]) => same(id, e.peripheral));
      if (ss) {
        ss[1].dispose();
        setupSealers.delete(ss[0]);
      }
      const t = tgt;
      if (!t || !same(e.peripheral, t.peripheralId)) return;
      const prev = conn;
      if (prev === 'up') {
        markDown();
        // A link that was up: iOS a pending connect again at once; Android autoConnect again (the
        // GATT was closed).
        armConnect(0);
      } else if (prev === 'setting_up') {
        // Before a verdict was read: a plain link failure, with the backoff.
        markDown();
        const wait = backoffMs;
        backoffMs = Math.min(BACKOFF_MAX_MS, backoffMs * 2);
        armConnect(wait);
      } else if (prev === 'down' && retryTimer === null) {
        armConnect(backoffMs);
      }
      // 'connecting': the connect call's own rejection re-arms it, with the backoff.
    });
    api.onDidUpdateValueForCharacteristic((e) => {
      pump();
      if (!same(e.characteristic, TX_CHAR)) return;
      const setup = [...setupFrames.entries()].find(([id]) => same(id, e.peripheral));
      if (setup) {
        const s = [...setupSealers.entries()].find(([id]) => same(id, e.peripheral))?.[1];
        const r = s?.open(e.value);
        if (r?.ok) setup[1](r.frame);
        return;
      }
      const t = tgt;
      if (!t || !same(e.peripheral, t.peripheralId)) return;
      onTargetFrame(t, e.value);
    });
    api.onDiscoverPeripheral((e) => {
      scanHit?.(e);
    });
  }

  /** iOS restored these: keep the paired one (a session again on the kept connection), cancel the rest. */
  function settleRestored(ids: string[]): void {
    const t = tgt;
    for (const id of ids) {
      if (t && same(id, t.peripheralId)) {
        if (conn === 'down') {
          cancelRetry();
          attempt += 1;
          // The dashcam may still hold a session on this connection (the app relaunched with the
          // connection kept): the SESSION_REQ re-keys it there.
          void onConnected(t, { maybeUp: true });
        }
      } else {
        api.disconnect(id, true).catch((e: unknown) => report(e, 'disconnect (restored)'));
      }
    }
  }

  const sameTarget = (a: TransportTarget | null, b: TransportTarget | null): boolean =>
    a !== null && b !== null && same(a.peripheralId, b.peripheralId) && a.dashcamId === b.dashcamId && a.auth.phoneId === b.auth.phoneId && a.auth.kPair === b.auth.kPair;

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
      if (soft) next.needsRepair(soft);
      if (verifyFailures >= UNVERIFIED_AFTER) next.unverified();
      if (conn === 'up' && linkInfo) {
        // The link decides on the INFO it never saw (its pairing may differ), then takes the link.
        if (next.infoRead(linkInfo)) {
          next.linkUp(linkInfo);
          flush();
        } else if (tgt) {
          fault(tgt, 'the link refused this DashPal (attach)');
        }
      } else if (conn === 'connecting' || conn === 'setting_up') {
        next.connecting();
      }
      return () => {
        if (sink === next) sink = null;
      };
    },

    setTarget(next) {
      const before = tgt;
      if (sameTarget(before, next) || (before === null && next === null)) return;
      tgt = next;
      backoffMs = BACKOFF_MIN_MS;
      soft = null;
      softRetries = 0;
      verifyFailures = 0;
      attempt += 1;
      cancelRetry();
      if (before) {
        const wasActive = conn !== 'down';
        conn = 'down';
        linkInfo = null;
        endSession();
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

    retryNow() {
      if (!tgt || conn !== 'down' || retryTimer === null) return;
      cancelRetry();
      connect();
    },

    write(bytes, o) {
      const t = tgt;
      const s = sealer;
      if (!t || conn !== 'up' || !s) return Promise.reject(new Error('the dashcam is not connected'));
      const id = t.peripheralId;
      return gatt(
        o.withResponse ? 'write' : 'writeWithoutResponse',
        () => {
          // Sealed now, as the operation runs: counters rise in the order frames go out.
          if (tgt !== t || sealer !== s || conn !== 'up') return Promise.reject(new Error('the session ended'));
          const wire = s.seal(bytes);
          if (wire === 'spent') {
            fault(t, 'every counter used');
            return Promise.reject(new Error('the session ran out of counters'));
          }
          const data = Array.from(wire);
          return o.withResponse ? api.write(id, DASHPAL_SERVICE, RX_CHAR, data, RX_MAX_BYTES) : api.writeWithoutResponse(id, DASHPAL_SERVICE, RX_CHAR, data, RX_MAX_BYTES);
        },
        o.urgent === true
      ).then(() => undefined);
    },

    linked: () => conn === 'up',

    async scan({ services, seconds, onHit, fast = false }) {
      await self.start();
      const wanted = services.map((u) => u.toLowerCase());
      scanHit = (e) => {
        const advertised = (e.advertising?.serviceUUIDs ?? []).map((u) => u.toLowerCase());
        if (!advertised.some((u) => wanted.includes(u))) return;
        onHit({ id: e.id, name: e.advertising?.localName ?? e.name ?? null, rssi: e.rssi, pairing: advertised.includes(PAIRING_SERVICE) });
      };
      await api.scan({ serviceUUIDs: services, seconds, allowDuplicates: false, ...(fast ? { scanMode: 2, matchMode: 1 } : {}) });
      return {
        stop: async () => {
          scanHit = null;
          await api.stopScan().catch((e: unknown) => report(e, 'stopScan'));
        },
      };
    },

    async setupConnect(peripheralId, { timeoutMs = SETUP_CONNECT_TIMEOUT_MS } = {}) {
      await self.start();
      if (platform === 'android') {
        // A link v1 OS bond would make Android try to encrypt; removeBond only for a listed bond
        // (with none, ble-manager's removeBond never settles).
        const bonded = await gatt('getBondedPeripherals', () => api.getBondedPeripherals()).catch((e: unknown) => {
          report(e, 'getBondedPeripherals');
          return [] as { id: string }[];
        });
        if (bonded.some((p) => same(p.id, peripheralId))) await gatt('removeBond', () => api.removeBond(peripheralId)).catch((e: unknown) => report(e, 'removeBond'));
      }
      try {
        await bounded(api.connect(peripheralId), timeoutMs, 'connect');
      } catch (e) {
        await api.disconnect(peripheralId, true).catch(() => {});
        throw e;
      }
      setupLinks.add(peripheralId.toLowerCase());
      if (platform === 'android') await gatt('requestMTU', () => api.requestMTU(peripheralId, MTU)).catch((e: unknown) => report(e, 'requestMTU'));
      let services = await gatt('retrieveServices', () => api.retrieveServices(peripheralId));
      if (!hasAuthChar(services) && platform === 'android' && api.refreshCache) {
        await gatt('refreshCache', () => api.refreshCache!(peripheralId)).catch((e: unknown) => report(e, 'refreshCache'));
        services = await gatt('retrieveServices', () => api.retrieveServices(peripheralId));
      }
      return { auth: hasAuthChar(services) };
    },

    setupLinkUp: (peripheralId) => setupLinks.has(peripheralId.toLowerCase()),

    async readInfo(peripheralId) {
      return decodeInfo(await gatt('read INFO', () => api.read(peripheralId, DASHPAL_SERVICE, INFO_CHAR)));
    },

    authWrite: (peripheralId, bytes) => authWriteOp(peripheralId, bytes),
    authRead: (peripheralId) => authReadOp(peripheralId),

    async requestMtu(peripheralId) {
      if (platform !== 'android') return;
      await gatt('requestMTU', () => api.requestMTU(peripheralId, MTU)).catch((e: unknown) => report(e, 'requestMTU'));
    },

    async startSession(peripheralId, info, auth) {
      const lower = peripheralId.toLowerCase();
      const outcome = await bounded(runSession(peripheralId, info, auth, { maybeUp: false, alive: () => setupLinks.has(lower) }), SESSION_MS, 'session').catch(
        (e: unknown): SessionOutcome => {
          report(e, 'setup session');
          return { kind: 'fault', why: 'timeout' };
        }
      );
      if (outcome.kind === 'up') {
        setupSealers.get(peripheralId)?.dispose();
        setupSealers.set(peripheralId, outcome.sealer);
      }
      return outcome;
    },

    async subscribeSealed(peripheralId, onFrame) {
      setupFrames.set(peripheralId, onFrame);
      await gatt('startNotification', () => api.startNotification(peripheralId, DASHPAL_SERVICE, TX_CHAR));
      return () => {
        setupFrames.delete(peripheralId);
      };
    },

    async writeSealed(peripheralId, bytes) {
      await gatt('write', () => {
        const s = setupSealers.get(peripheralId);
        if (!s) return Promise.reject(new Error('no session on this setup connection'));
        const wire = s.seal(bytes);
        if (wire === 'spent') return Promise.reject(new Error('the session ran out of counters'));
        return api.write(peripheralId, DASHPAL_SERVICE, RX_CHAR, Array.from(wire), RX_MAX_BYTES);
      });
    },

    async disconnect(peripheralId) {
      setupFrames.delete(peripheralId);
      setupLinks.delete(peripheralId.toLowerCase());
      setupSealers.get(peripheralId)?.dispose();
      setupSealers.delete(peripheralId);
      await api.disconnect(peripheralId, true);
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
    // The reconnect backoff and the GATT op bounds also fire from rows and frames when Android has
    // paused JS timers (app in the background).
    setTimer: (fn, ms) => processTimers.setTimeout(fn, ms),
    clearTimer: (h) => processTimers.clearTimeout(h),
    pump: () => processTimers.pump(),
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

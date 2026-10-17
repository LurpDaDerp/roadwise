// A scriptable stand-in for react-native-ble-manager (the `BleApi` slice the transport uses), for
// tests and the cross-repo link test (plan §9): the real transport and link run on it, a test plays
// the dashcam (INFO, AUTH, notifications, disconnects, restoration, advertising) and sees every write.
// `__fixtures__/fakeDashcam.ts` plays a whole link v2 dashcam on top of it.
//
// As ble-manager 12.5.3 does: `removeBond` never settles unless the phone holds a bond with that
// peripheral (its promise waits for a BONDED -> NONE broadcast), and a write that fails rejects with
// a `status=N` text.
import type { BleApi, BlePeripheralEvent, BleServicesInfo, BleSub } from './transport';
import { AUTH_CHAR, DASHPAL_SERVICE, IDENTIFY_CHAR, INFO_CHAR, PAIRING_NEW, PAIRING_OPEN, PAIRING_SETUP, RX_CHAR, TX_CHAR, VIEW_CHAR } from './protocol';

type Handler<T> = (e: T) => void;

export interface FakePeripheral {
  id: string;
  name?: string;
  rssi?: number;
  /** what an INFO read returns (unless `onRead` answers it) */
  info?: number[];
  /** the OS holds a bond with it (Android `getBondedPeripherals`) */
  osBonded?: boolean;
  /** its table has no AUTH characteristic (a link v1 board, or a stale cache when `staleCache`) */
  noAuthChar?: boolean;
  /** Android's GATT cache is stale: AUTH appears only after `refreshCache` */
  staleCache?: boolean;
  /** its table has no VIEW characteristic (a stale cache from before link v3 when `staleCache`) */
  noViewChar?: boolean;
}

export interface FakeWrite {
  id: string;
  characteristic: string;
  bytes: number[];
  withResponse: boolean;
  maxByteSize: number | undefined;
}

export type ConnectMode = 'resolve' | 'reject' | 'hang';

export interface FakeBle extends BleApi {
  readonly calls: string[];
  readonly writes: FakeWrite[];
  /** every scan's options */
  readonly scans: { serviceUUIDs: string[]; seconds: number; scanMode?: number; matchMode?: number }[];
  readonly connected: Set<string>;
  /** How the next `connect` calls behave, per peripheral (default resolve). */
  connectMode: Map<string, ConnectMode>;
  /** An error the next call of this method (and characteristic, for read) rejects with. */
  failNext(method: string, error: unknown): void;
  /** The next call of this method never settles. */
  hangNext(method: string): void;
  setState(state: string): void;
  addPeripheral(p: FakePeripheral): void;
  peripheral(id: string): FakePeripheral | undefined;
  /** The dashcam sends a TX notification. */
  notify(id: string, bytes: number[]): void;
  /** The dashcam sends a VIEW notification. */
  notifyView(id: string, bytes: number[]): void;
  /** The link drops (a disconnect event with these fields). */
  drop(id: string, e?: { status?: number; domain?: string; code?: number }): void;
  /** iOS state restoration hands these back. */
  restore(ids: string[]): void;
  /** A scan result. */
  advertise(e: BlePeripheralEvent): void;
  /** Resolve every connect left hanging for `id`. */
  completeConnect(id: string): void;
  /** Sees every write; a promise it returns is awaited (a rejection fails the write, as an ATT error). */
  onWrite: ((w: FakeWrite) => void | Promise<void>) | null;
  /** Answers a read (INFO, AUTH); `undefined` falls back to the peripheral's INFO or an empty value. */
  onRead: ((id: string, characteristic: string) => number[] | undefined | Promise<number[] | undefined>) | null;
  /** A connect resolved (the dashcam sees the link up). */
  onConnect: ((id: string) => void) | null;
  /** The phone disconnected (the dashcam sees the link down); not called for `drop`. */
  onDisconnect: ((id: string) => void) | null;
  listenerCount(): number;
}

const TABLE = (auth: boolean, view: boolean): BleServicesInfo => ({
  characteristics: [
    { service: DASHPAL_SERVICE, characteristic: INFO_CHAR },
    { service: DASHPAL_SERVICE, characteristic: IDENTIFY_CHAR },
    { service: DASHPAL_SERVICE, characteristic: TX_CHAR },
    { service: DASHPAL_SERVICE, characteristic: RX_CHAR },
    ...(auth ? [{ service: DASHPAL_SERVICE, characteristic: AUTH_CHAR }] : []),
    ...(view ? [{ service: DASHPAL_SERVICE, characteristic: VIEW_CHAR }] : []),
    { service: PAIRING_NEW, characteristic: '' },
    { service: PAIRING_SETUP, characteristic: '' },
    { service: PAIRING_OPEN, characteristic: '' },
  ].filter((c) => c.characteristic !== ''),
});

export function createFakeBle(): FakeBle {
  const calls: string[] = [];
  const writes: FakeWrite[] = [];
  const scans: FakeBle['scans'] = [];
  const connected = new Set<string>();
  const peripherals = new Map<string, FakePeripheral>();
  const failures = new Map<string, unknown>();
  const hangs = new Set<string>();
  const handlers = {
    state: new Set<Handler<{ state: string }>>(),
    disconnect: new Set<Handler<{ peripheral: string; status?: number; domain?: string; code?: number }>>(),
    value: new Set<Handler<{ peripheral: string; characteristic: string; service: string; value: number[] }>>(),
    discover: new Set<Handler<BlePeripheralEvent>>(),
    restore: new Set<Handler<{ peripherals: { id: string }[] }>>(),
  };
  const hanging = new Map<string, { resolve: () => void; reject: (e: unknown) => void }[]>();
  const bondedAndroid = new Set<string>();

  function sub<T>(set: Set<Handler<T>>, fn: Handler<T>): BleSub {
    set.add(fn);
    return { remove: () => void set.delete(fn) };
  }

  function fail(key: string): void {
    if (failures.has(key)) {
      const e = failures.get(key);
      failures.delete(key);
      throw e;
    }
  }

  /** A call that was told to hang: a promise that never settles. */
  function hang(key: string): boolean {
    if (!hangs.has(key)) return false;
    hangs.delete(key);
    return true;
  }
  const never = <T>(): Promise<T> => new Promise<T>(() => {});

  const fake: FakeBle = {
    calls,
    writes,
    scans,
    connected,
    connectMode: new Map(),
    onWrite: null,
    onRead: null,
    onConnect: null,
    onDisconnect: null,

    failNext(method, error) {
      failures.set(method, error);
    },
    hangNext(method) {
      hangs.add(method);
    },

    async start(opts) {
      calls.push(`start:${opts.restoreIdentifierKey ?? ''}:${String(opts.showAlert)}`);
      fail('start');
    },
    async checkState() {
      calls.push('checkState');
      return currentState;
    },
    async scan(o) {
      calls.push(`scan:${o.serviceUUIDs.join(',')}:${o.seconds}`);
      scans.push({ serviceUUIDs: [...o.serviceUUIDs], seconds: o.seconds, ...(o.scanMode !== undefined ? { scanMode: o.scanMode } : {}), ...(o.matchMode !== undefined ? { matchMode: o.matchMode } : {}) });
      fail('scan');
    },
    async stopScan() {
      calls.push('stopScan');
    },
    connect(id, o) {
      calls.push(`connect:${id}${o?.autoconnect ? ':auto' : ''}`);
      const mode = fake.connectMode.get(id) ?? 'resolve';
      if (failures.has('connect')) {
        const e = failures.get('connect');
        failures.delete('connect');
        return Promise.reject(e);
      }
      if (mode === 'reject') return Promise.reject(new Error('Connection failed to start'));
      if (mode === 'hang') {
        return new Promise<void>((resolve, reject) => {
          const list = hanging.get(id) ?? [];
          list.push({
            resolve: () => {
              connected.add(id);
              fake.onConnect?.(id);
              resolve();
            },
            reject,
          });
          hanging.set(id, list);
        });
      }
      connected.add(id);
      fake.onConnect?.(id);
      return Promise.resolve();
    },
    async disconnect(id) {
      calls.push(`disconnect:${id}`);
      const pending = hanging.get(id);
      if (pending) {
        hanging.delete(id);
        for (const p of pending) p.reject(new Error(`Peripheral did disconnect: ${id}`));
      }
      const was = connected.delete(id);
      if (was) fake.onDisconnect?.(id);
    },
    async retrieveServices(id) {
      calls.push(`retrieveServices:${id}`);
      fail('retrieveServices');
      const p = peripherals.get(id);
      return TABLE(!(p?.noAuthChar || p?.staleCache), !(p?.noViewChar || p?.staleCache || p?.noAuthChar));
    },
    async refreshCache(id) {
      calls.push(`refreshCache:${id}`);
      fail('refreshCache');
      const p = peripherals.get(id);
      if (p?.staleCache) p.staleCache = false;
      return true;
    },
    async requestMTU(id, mtu) {
      calls.push(`requestMTU:${id}:${mtu}`);
      return mtu;
    },
    async read(id, _service, characteristic) {
      calls.push(`read:${id}:${characteristic.slice(4, 8)}`);
      if (hang(`read:${characteristic}`) || hang('read')) return never();
      fail(`read:${characteristic}`);
      fail('read');
      const answered = await fake.onRead?.(id, characteristic);
      if (answered !== undefined) return [...answered];
      const p = peripherals.get(id);
      if (characteristic === INFO_CHAR) return [...(p?.info ?? [])];
      return [];
    },
    async write(id, _service, characteristic, data, maxByteSize) {
      calls.push(`write:${id}:${characteristic.slice(4, 8)}`);
      if (hang(`write:${characteristic}`) || hang('write')) return never();
      fail(`write:${characteristic}`);
      fail('write');
      const w = { id, characteristic, bytes: [...data], withResponse: true, maxByteSize };
      writes.push(w);
      await fake.onWrite?.(w);
    },
    async writeWithoutResponse(id, _service, characteristic, data, maxByteSize) {
      calls.push(`writeWithoutResponse:${id}:${characteristic.slice(4, 8)}`);
      fail('writeWithoutResponse');
      const w = { id, characteristic, bytes: [...data], withResponse: false, maxByteSize };
      writes.push(w);
      await fake.onWrite?.(w);
    },
    async startNotification(id, _service, characteristic) {
      calls.push(`startNotification:${id}:${characteristic.slice(4, 8)}`);
      fail('startNotification');
    },
    async stopNotification(id, _service, characteristic) {
      calls.push(`stopNotification:${id}:${characteristic.slice(4, 8)}`);
      fail('stopNotification');
    },
    removeBond(id) {
      calls.push(`removeBond:${id}`);
      // ble-manager resolves only on the BONDED -> NONE broadcast: with no bond it never settles.
      if (!bondedAndroid.has(id)) return never();
      try {
        fail('removeBond');
      } catch (e) {
        return Promise.reject(e);
      }
      bondedAndroid.delete(id);
      return Promise.resolve();
    },
    async getBondedPeripherals() {
      calls.push('getBondedPeripherals');
      return [...bondedAndroid].map((id) => ({ id }));
    },
    onDidUpdateState: (cb) => sub(handlers.state, cb),
    onDisconnectPeripheral: (cb) => sub(handlers.disconnect, cb),
    onDidUpdateValueForCharacteristic: (cb) => sub(handlers.value, cb),
    onDiscoverPeripheral: (cb) => sub(handlers.discover, cb),
    onCentralManagerWillRestoreState: (cb) => sub(handlers.restore, cb),

    setState(state) {
      currentState = state;
      for (const fn of [...handlers.state]) fn({ state });
    },
    addPeripheral(p) {
      peripherals.set(p.id, p);
      if (p.osBonded) bondedAndroid.add(p.id);
    },
    peripheral: (id) => peripherals.get(id),
    notify(id, bytes) {
      for (const fn of [...handlers.value]) fn({ peripheral: id, characteristic: TX_CHAR, service: DASHPAL_SERVICE, value: [...bytes] });
    },
    notifyView(id, bytes) {
      for (const fn of [...handlers.value]) fn({ peripheral: id, characteristic: VIEW_CHAR, service: DASHPAL_SERVICE, value: [...bytes] });
    },
    drop(id, e = {}) {
      connected.delete(id);
      for (const fn of [...handlers.disconnect]) fn({ peripheral: id, ...e });
    },
    restore(ids) {
      for (const id of ids) connected.add(id);
      for (const fn of [...handlers.restore]) fn({ peripherals: ids.map((id) => ({ id })) });
    },
    advertise(e) {
      for (const fn of [...handlers.discover]) fn(e);
    },
    completeConnect(id) {
      const pending = hanging.get(id) ?? [];
      hanging.delete(id);
      for (const p of pending) p.resolve();
    },
    listenerCount: () => Object.values(handlers).reduce((n, set) => n + set.size, 0),
  };
  let currentState = 'on';
  return fake;
}

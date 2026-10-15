// A scriptable stand-in for react-native-ble-manager (the `BleApi` slice the transport uses), for
// tests and the cross-repo link test (plan §9): the real transport and link run on it, a test plays
// the dashcam (INFO, notifications, disconnects, restoration, advertising) and sees every write.
import type { BleApi, BlePeripheralEvent, BleSub } from './transport';
import { DASHPAL_SERVICE, INFO_CHAR, TX_CHAR } from './protocol';

type Handler<T> = (e: T) => void;

export interface FakePeripheral {
  id: string;
  name?: string;
  rssi?: number;
  /** what an INFO read returns */
  info?: number[];
  /** the OS holds a bond with it (Android `getBondedPeripherals`) */
  osBonded?: boolean;
  /** iOS: an encrypted read succeeds (the pairing dialog was accepted) */
  pairable?: boolean;
}

export interface FakeWrite {
  id: string;
  characteristic: string;
  bytes: number[];
  withResponse: boolean;
}

export type ConnectMode = 'resolve' | 'reject' | 'hang';

export interface FakeBle extends BleApi {
  readonly calls: string[];
  readonly writes: FakeWrite[];
  readonly connected: Set<string>;
  /** How the next `connect` calls behave, per peripheral (default resolve). */
  connectMode: Map<string, ConnectMode>;
  /** An error the next call of this method (and characteristic, for read) rejects with. */
  failNext(method: string, error: unknown): void;
  setState(state: string): void;
  addPeripheral(p: FakePeripheral): void;
  peripheral(id: string): FakePeripheral | undefined;
  /** The dashcam sends a TX notification. */
  notify(id: string, bytes: number[]): void;
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
  listenerCount(): number;
}

export function createFakeBle(): FakeBle {
  const calls: string[] = [];
  const writes: FakeWrite[] = [];
  const connected = new Set<string>();
  const peripherals = new Map<string, FakePeripheral>();
  const failures = new Map<string, unknown>();
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

  const fake: FakeBle = {
    calls,
    writes,
    connected,
    connectMode: new Map(),
    onWrite: null,

    failNext(method, error) {
      failures.set(method, error);
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
              resolve();
            },
            reject,
          });
          hanging.set(id, list);
        });
      }
      connected.add(id);
      return Promise.resolve();
    },
    async disconnect(id) {
      calls.push(`disconnect:${id}`);
      const pending = hanging.get(id);
      if (pending) {
        hanging.delete(id);
        for (const p of pending) p.reject(new Error(`Peripheral did disconnect: ${id}`));
      }
      connected.delete(id);
    },
    async retrieveServices(id) {
      calls.push(`retrieveServices:${id}`);
      fail('retrieveServices');
      return {};
    },
    async requestMTU(id, mtu) {
      calls.push(`requestMTU:${id}:${mtu}`);
      return mtu;
    },
    async read(id, _service, characteristic) {
      calls.push(`read:${id}:${characteristic.slice(4, 8)}`);
      fail(`read:${characteristic}`);
      fail('read');
      const p = peripherals.get(id);
      if (characteristic === INFO_CHAR) return [...(p?.info ?? [])];
      if (characteristic === TX_CHAR) {
        if (p?.pairable === false) throw { code: 15, domain: 'CBATTErrorDomain', message: 'Encryption is insufficient.' };
        return [];
      }
      return [];
    },
    async write(id, _service, characteristic, data) {
      calls.push(`write:${id}:${characteristic.slice(4, 8)}`);
      fail('write');
      const w = { id, characteristic, bytes: [...data], withResponse: true };
      writes.push(w);
      await fake.onWrite?.(w);
    },
    async writeWithoutResponse(id, _service, characteristic, data) {
      calls.push(`writeWithoutResponse:${id}:${characteristic.slice(4, 8)}`);
      fail('writeWithoutResponse');
      const w = { id, characteristic, bytes: [...data], withResponse: false };
      writes.push(w);
      await fake.onWrite?.(w);
    },
    async startNotification(id, _service, characteristic) {
      calls.push(`startNotification:${id}:${characteristic.slice(4, 8)}`);
      fail('startNotification');
    },
    async createBond(id) {
      calls.push(`createBond:${id}`);
      fail('createBond');
      bondedAndroid.add(id);
    },
    async removeBond(id) {
      calls.push(`removeBond:${id}`);
      fail('removeBond');
      bondedAndroid.delete(id);
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

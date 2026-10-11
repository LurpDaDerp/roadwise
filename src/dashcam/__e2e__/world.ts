// The cross-repo DashPal link test bench (plan §9): the firmware's real link logic (`ble_sim`, in WSL)
// on one side, the app's real DashPal code on the other, joined by the fake BLE stack.
//
// Phone side, per phone: `createFakeBle()` → `createBleTransport` → `createDashcamRuntime` (which
// builds the real `createDashcamLink` with its alert controller) over a migrated sql.js database
// (the real SQLite engine) and a recording alert player; `createSetupFlow` for pairing.
// Wiring: every RX write goes to the simulator as `RX <conn> <hex>`; every `TX <conn> <hex>` the
// simulator prints is handed to that phone through `ble.notify`. Connects and disconnects become
// `C` / `D` lines; the simulator's `TERM` (the dashcam ends a link) becomes `D` + a dropped link.
//
// One clock: world time `W` (ms). The phones read epoch `EPOCH0 + W` (link, transport, setup and
// player all take it injected; nothing runs on real timers), and the simulator's uptime is
// `W − (when it booted)`, sent with `T`. Time moves in steps of at most `STEP_MS`, stopping exactly
// at every phone timer; each step sends `T`, delivers what came out, runs the due timers and lets
// the promise chains (sql.js included) drain.
//
// What the simulator does not contain is modelled here, and only here, from the firmware's
// `ble_gatt.c` (NimBLE glue): the INFO read (`peer_bonded`, `bond_count`, the window flag), the
// IDENTIFY write (accepted only inside the window or on an authorized link; recorded in `gatt`),
// the bond store (which phones are bonded), the TX read that makes iOS pair (it becomes `BOND`),
// and advertising (the pairing service while the window is open).
import type { AlertPlayer } from '@/core/alerts/player';
import type { AlertDecision } from '@/core/alerts/types';
import type { FeatureRow } from '@/core/engine/types';
import { createSqlJsDb } from '@/data/db/__fixtures__/sqljsDriver';
import { createSettingsRepo, createTripsRepo, migrate, type Db } from '@/data/db';

import { createFakeBle, type FakeBle } from '../fakeTransport';
import { PAIRED_KEY, type PairedDashcam } from '../keys';
import {
  DASHPAL_SERVICE,
  decodeRx,
  decodeTx,
  encodeInfo,
  fromHex,
  IDENTIFY_CHAR,
  PAIRING_SERVICE,
  RX_CHAR,
  toHex,
  TX_CHAR,
  type RxFrame,
  type TxFrame,
} from '../protocol';
import { createDashcamRuntime, type DashcamRuntime } from '../runtime';
import { createSetupFlow, type SetupFlow } from '../setup';
import { createBleTransport, type DashcamTransport } from '../transport';
import { SimProcess } from './sim';

export const STEP_MS = 10;
/** The phones' epoch at world time 0. */
export const EPOCH0 = 1_791_600_000_000;
export const MAC = [0xa4, 0xcf, 0x12, 0xb3, 0xc4, 0xd5];
export const CAM = 'a4cf12b3c4d5';
export const NAME = 'DashPal-C4D5';
export const TRIP_PREFIX = '11111111-1111-4111-8111-';

/** Tone lengths the fake player takes (ms), as `scripts/make-tones.js` renders them. */
const TONE_MS: Record<string, number> = { dp_glance: 440, dp_drowsy: 940, dp_wake: 760, dp_phone: 360 };
const LEVEL_MS: Record<number, number> = { 1: 180, 2: 300, 3: 880 };

export interface Played {
  at: number;
  decision: AlertDecision;
  /** `stillWanted()` said no as the item started */
  dropped: boolean;
}

export interface FakePlayer extends AlertPlayer {
  played: Played[];
  stops: number[];
  /** items that made a sound (not dropped, not silent) */
  sounded(since?: number): Played[];
  /** haptic + visual only items */
  silent(since?: number): Played[];
}

interface Timer {
  id: number;
  at: number;
  seq: number;
  fn: () => void;
  owner: Phone | null;
}

export interface DbGate {
  re: RegExp | null;
  queue: (() => void)[];
}

interface Pending {
  line: string;
  after?: (out: string[]) => void;
}

export interface LogLine {
  /** world time */
  at: number;
  /** the simulator's uptime then */
  uptime: number;
  dir: 'in' | 'out';
  line: string;
}

export interface Phone {
  name: string;
  conn: number;
  platform: 'ios' | 'android';
  peripheralId: string;
  ble: FakeBle;
  /** the database the app uses (through the gate) */
  db: Db;
  rawDb: Db;
  gate: DbGate;
  rt: DashcamRuntime;
  player: FakePlayer;
  host: { recording: boolean; playerAvailable: boolean; callActive: boolean };
  style: { sound: boolean };
  appState: { currentState: string; emit(s: string): void; addEventListener(t: 'change', fn: (s: string) => void): { remove(): void } };
  tripId: string;
  errors: string[];
  /** the dashcam sees this phone connected */
  simConnected: boolean;
  /** the dashcam treats this phone's link as authorized (encrypted, bonded) */
  authorized: boolean;
  /** iOS suspended the app: its timers stop and notifications wait */
  suspended: boolean;
  /** frames held while suspended */
  held: number[][];
  /** a silent link loss: nothing passes either way, no disconnect yet */
  blackholed: boolean;
  latency: { up: number; down: number };
  transport(): DashcamTransport;
  setup(): SetupFlow;
}

export interface WorldOptions {
  /** hex, like the device's; random when omitted */
  bootId?: string;
  /** phones (by name) whose bonds the dashcam holds at boot; none opens the pairing window */
  bonded?: string[];
  ackMs?: number;
}

const bootArgs = (o: { bootId?: string; bonds: number; ackMs?: number }): string[] => [
  ...(o.bootId ? ['--boot-id', o.bootId] : []),
  '--bonds',
  String(o.bonds),
  ...(o.ackMs !== undefined ? ['--ack-ms', String(o.ackMs)] : []),
];

let uuidN = 0;
const newUuid = (): string => {
  uuidN += 1;
  const r = (uuidN * 2654435761) % 0x1000000;
  return `${r.toString(16).padStart(8, '0')}-0000-4000-8000-${uuidN.toString(16).padStart(12, '0')}`;
};

export class World {
  /** world time, ms */
  W = 0;
  /** world time the current simulator booted */
  bootAt = 0;
  sim: SimProcess;
  bootId = '';
  readonly log: LogLine[] = [];
  /** what the GATT model did (INFO reads, IDENTIFY writes), from ble_gatt.c's rules */
  readonly gatt: { at: number; phone: string; what: string }[] = [];
  readonly phones: Phone[] = [];
  /** phones (by name) in the dashcam's bond store */
  readonly bonds = new Set<string>();
  windowOpen = false;
  private timers: Timer[] = [];
  private timerSeq = 0;
  private pending: Pending[] = [];
  private closed = false;

  private constructor(sim: SimProcess) {
    this.sim = sim;
  }

  static async create(o: WorldOptions = {}): Promise<World> {
    const bonded = o.bonded ?? [];
    const w = new World(new SimProcess(bootArgs({ bootId: o.bootId, bonds: bonded.length, ackMs: o.ackMs })));
    for (const b of bonded) w.bonds.add(b);
    await w.simLine('T 0');
    return w;
  }

  // ——— time ———

  /** The phones' epoch now. */
  now(): number {
    return EPOCH0 + this.W;
  }

  uptime(): number {
    return this.W - this.bootAt;
  }

  /** World time of a dashcam uptime in the current boot. */
  atUptime(up: number): number {
    return this.bootAt + up;
  }

  timer(ms: number, fn: () => void, owner: Phone | null): number {
    this.timerSeq += 1;
    const t: Timer = { id: this.timerSeq, at: this.W + Math.max(0, ms), seq: this.timerSeq, fn, owner };
    this.timers.push(t);
    return t.id;
  }

  clearTimer(id: unknown): void {
    this.timers = this.timers.filter((t) => t.id !== id);
  }

  private nextTimer(): Timer | null {
    let best: Timer | null = null;
    for (const t of this.timers) {
      if (t.owner?.suspended) continue;
      if (!best || t.at < best.at || (t.at === best.at && t.seq < best.seq)) best = t;
    }
    return best;
  }

  private async runDue(): Promise<void> {
    for (;;) {
      const t = this.nextTimer();
      if (!t || t.at > this.W) return;
      this.timers = this.timers.filter((x) => x !== t);
      t.fn();
      await this.settle();
    }
  }

  /** Let every promise chain drain and every queued line reach the simulator. */
  async settle(): Promise<void> {
    for (let idle = 0; idle < 4; ) {
      await new Promise<void>((resolve) => setImmediate(resolve));
      const item = this.pending.shift();
      if (item) {
        const out = await this.simLine(item.line);
        item.after?.(out);
        idle = 0;
      } else {
        idle += 1;
      }
    }
  }

  /** Move world time to `end`, step by step. */
  async runTo(end: number): Promise<void> {
    await this.settle();
    await this.runDue();
    while (this.W < end) {
      const t = this.nextTimer();
      const next = Math.min(end, this.W + STEP_MS, t ? Math.max(t.at, this.W + 1) : Infinity);
      this.W = next;
      await this.simLine(`T ${this.uptime()}`);
      await this.settle();
      await this.runDue();
    }
  }

  advance(ms: number): Promise<void> {
    return this.runTo(this.W + ms);
  }

  /** Advance until `pred` holds (checked every step); throws after `maxMs`. */
  async until(pred: () => boolean, maxMs: number, what = 'condition'): Promise<number> {
    const end = this.W + maxMs;
    await this.settle();
    while (!pred()) {
      if (this.W >= end) throw new Error(`world: ${what} not reached within ${maxMs} ms (W=${this.W})`);
      await this.runTo(Math.min(end, this.W + STEP_MS));
    }
    return this.W;
  }

  // ——— the simulator ———

  /** Send one line now and handle what it printed. */
  async simLine(line: string): Promise<string[]> {
    this.log.push({ at: this.W, uptime: this.uptime(), dir: 'in', line });
    const out = await this.sim.send([line]);
    this.handleOut(out);
    return out;
  }

  /** Several lines, one after the other (rogue phones, the engine's sound and events). */
  async dashcam(...lines: string[]): Promise<string[]> {
    await this.settle();
    const all: string[] = [];
    for (const l of lines) {
      all.push(...(await this.simLine(l)));
      await this.settle();
    }
    return all;
  }

  private enqueue(line: string, after?: (out: string[]) => void): void {
    this.pending.push({ line, after });
  }

  private handleOut(out: string[]): void {
    for (const line of out) {
      this.log.push({ at: this.W, uptime: this.uptime(), dir: 'out', line });
      const p = line.split(' ');
      if (p[0] === 'TX') {
        const phone = this.phones.find((x) => x.conn === Number(p[1]));
        if (phone) this.toPhone(phone, fromHex(p[2] ?? ''));
      } else if (p[0] === 'TERM') {
        const phone = this.phones.find((x) => x.conn === Number(p[1]));
        if (p[2] === 'unpair' || p[2] === 'forget') {
          if (phone) this.bonds.delete(phone.name);
        }
        // NimBLE terminates the link; its disconnect event reaches ble_link (and the phone).
        if (!phone || phone.simConnected) this.enqueue(`D ${p[1]}`);
        if (phone) this.endLink(phone, false);
      } else if (p[0] === 'WINDOW') {
        this.windowOpen = p[1] === '1';
      }
    }
  }

  private toPhone(phone: Phone, bytes: number[]): void {
    if (phone.blackholed) return;
    const deliver = () => {
      if (phone.blackholed || !phone.ble.connected.has(phone.peripheralId)) return;
      if (phone.suspended) phone.held.push(bytes);
      else phone.ble.notify(phone.peripheralId, bytes);
    };
    if (phone.latency.down > 0) this.timer(phone.latency.down, deliver, null);
    else deliver();
  }

  /** The link ends on the phone's side (a disconnect event). `toDashcam`: also tell the dashcam. */
  private endLink(phone: Phone, toDashcam: boolean): void {
    if (toDashcam && phone.simConnected) this.enqueue(`D ${phone.conn}`);
    phone.simConnected = false;
    phone.authorized = false;
    if (phone.ble.connected.has(phone.peripheralId)) phone.ble.drop(phone.peripheralId);
  }

  /** The dashcam reboots: a new simulator (new random boot id unless given), bonds kept (NVS). */
  async reboot(o: { bootId?: string; gapMs?: number } = {}): Promise<void> {
    await this.settle();
    for (const phone of this.phones) {
      phone.simConnected = false;
      phone.authorized = false;
      if (phone.ble.connected.has(phone.peripheralId)) phone.ble.drop(phone.peripheralId);
    }
    this.sim.close();
    this.W += o.gapMs ?? 0;
    this.bootAt = this.W;
    this.sim = new SimProcess(bootArgs({ bootId: o.bootId, bonds: this.bonds.size }));
    this.windowOpen = false;
    await this.simLine('T 0');
    await this.settle();
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    for (const p of this.phones) p.rt.dispose();
    this.sim.close();
  }

  // ——— what happened ———

  bootIdOf(): number {
    const boot = [...this.log].reverse().find((l) => l.dir === 'out' && l.line.startsWith('BOOT '));
    return parseInt(boot?.line.split(' ')[1] ?? '0', 16);
  }

  out(since = 0): LogLine[] {
    return this.log.filter((l) => l.dir === 'out' && l.at >= since);
  }

  /** Frames the dashcam notified (to `conn`, or all). */
  tx(conn?: number, since = 0): { at: number; conn: number; f: TxFrame }[] {
    const got: { at: number; conn: number; f: TxFrame }[] = [];
    for (const l of this.out(since)) {
      const p = l.line.split(' ');
      if (p[0] !== 'TX' || (conn !== undefined && Number(p[1]) !== conn)) continue;
      const d = decodeTx(fromHex(p[2] ?? ''));
      if (!d.ok) throw new Error(`the simulator sent an undecodable frame: ${l.line} (${d.reason})`);
      got.push({ at: l.at, conn: Number(p[1]), f: d.frame });
    }
    return got;
  }

  txOf<T extends TxFrame['type']>(type: T, conn?: number, since = 0): { at: number; conn: number; f: Extract<TxFrame, { type: T }> }[] {
    return this.tx(conn, since).filter((x) => x.f.type === type) as never;
  }

  /** Frames the phones wrote that reached the dashcam. */
  rx(conn?: number, since = 0): { at: number; conn: number; f: RxFrame }[] {
    const got: { at: number; conn: number; f: RxFrame }[] = [];
    for (const l of this.log) {
      if (l.dir !== 'in' || l.at < since) continue;
      const p = l.line.split(' ');
      if (p[0] !== 'RX' || (conn !== undefined && Number(p[1]) !== conn)) continue;
      const d = decodeRx(fromHex(p[2] ?? ''));
      if (d.ok) got.push({ at: l.at, conn: Number(p[1]), f: d.frame });
    }
    return got;
  }

  rxOf<T extends RxFrame['type']>(type: T, conn?: number, since = 0): { at: number; conn: number; f: Extract<RxFrame, { type: T }> }[] {
    return this.rx(conn, since).filter((x) => x.f.type === type) as never;
  }

  /** What the buzzer audibly did: `PLAY cont c l`, `PLAY once c`, `STOP`. */
  buzzer(since = 0): { at: number; line: string }[] {
    return this.out(since)
      .filter((l) => l.line.startsWith('PLAY') || l.line === 'STOP')
      .map((l) => ({ at: l.at, line: l.line }));
  }

  lines(prefix: string, since = 0): { at: number; line: string }[] {
    return this.out(since)
      .filter((l) => l.line.startsWith(prefix))
      .map((l) => ({ at: l.at, line: l.line }));
  }

  /** Every simulator line (for a failing test's message). */
  transcript(since = 0): string {
    return this.log
      .filter((l) => l.at >= since && !(l.dir === 'in' && (l.line.startsWith('T ') || l.line === 'CTXQ')))
      .map((l) => `${String(l.at).padStart(7)} ${l.dir === 'in' ? '>' : '<'} ${l.line}`)
      .join('\n');
  }

  // ——— phones ———

  async addPhone(o: {
    name: string;
    conn: number;
    platform?: 'ios' | 'android';
    /** the app holds the pairing (and the dashcam the bond when the phone is in `bonded`) */
    paired?: boolean;
    recording?: boolean;
    buzzerToo?: boolean;
    db?: Db;
  }): Promise<Phone> {
    const platform = o.platform ?? 'ios';
    const raw = o.db ?? (await createSqlJsDb());
    if (!o.db) {
      await migrate(raw);
    }
    // The phone's database, with a gate a test can close on matching statements (a slow or stuck
    // write); a crash drops what the gate still holds.
    const gate: DbGate = { re: null, queue: [] };
    const db: Db = {
      execute: (sql, params) =>
        gate.re && gate.re.test(sql)
          ? new Promise((resolve, reject) => gate.queue.push(() => void raw.execute(sql, params).then(resolve, reject)))
          : raw.execute(sql, params),
      transaction: (fn) => raw.transaction(fn),
    };
    const tripId = `${TRIP_PREFIX}${String(o.conn).padStart(12, '0')}`;
    if (!o.db) await createTripsRepo(raw).insert({ client_trip_id: tripId, started_at: this.now(), tz: 'UTC', status: 'recording' }, this.now());
    const settings = createSettingsRepo(raw);
    const peripheralId = platform === 'ios' ? '7D3E1C20-4B6A-4E8F-9A21-0C6E5A7D2B10' : 'A4:CF:12:B3:C4:D5';
    if (o.paired) {
      const rec: PairedDashcam = { dashcamId: CAM, peripheralId, name: NAME, pairedAt: this.now() };
      await settings.set(PAIRED_KEY, rec);
    }
    if (o.buzzerToo !== undefined) await settings.set('dashcam.buzzerToo', o.buzzerToo);
    const ble = createFakeBle();
    const listeners = new Set<(s: string) => void>();
    const appState = {
      currentState: 'active',
      emit(s: string) {
        appState.currentState = s;
        for (const fn of [...listeners]) fn(s);
      },
      addEventListener: (_t: 'change', fn: (s: string) => void) => {
        listeners.add(fn);
        return { remove: () => void listeners.delete(fn) };
      },
    };
    const phone = {
      name: o.name,
      conn: o.conn,
      platform,
      peripheralId,
      ble,
      db,
      rawDb: raw,
      gate,
      host: { recording: o.recording ?? false, playerAvailable: true, callActive: false },
      style: { sound: true },
      appState,
      tripId,
      errors: [] as string[],
      simConnected: false,
      authorized: false,
      suspended: false,
      held: [] as number[][],
      blackholed: false,
      latency: { up: 0, down: 0 },
    } as unknown as Phone;
    phone.player = this.makePlayer(phone);
    this.wireBle(phone);
    let transport: DashcamTransport | null = null;
    const getTransport = (): DashcamTransport => {
      transport ??= createBleTransport(ble, {
        platform,
        now: () => this.now(),
        setTimer: (fn, ms) => this.timer(ms, fn, phone),
        clearTimer: (h) => this.clearTimer(h),
        onError: (e, ctx) => phone.errors.push(`transport ${ctx}: ${describe(e)}`),
      });
      return transport;
    };
    phone.transport = getTransport;
    phone.rt = createDashcamRuntime({
      db,
      player: phone.player,
      transport: getTransport,
      host: () => phone.host,
      styleAllowsSound: () => phone.style.sound,
      platform,
      appState,
      now: () => this.now(),
      newId: newUuid,
      setTimer: (fn, ms) => this.timer(ms, fn, phone),
      clearTimer: (h) => this.clearTimer(h),
      setRepeat: (fn, ms) => {
        const handle = { id: 0 };
        const arm = () => {
          handle.id = this.timer(ms, () => {
            arm();
            fn();
          }, phone);
        };
        arm();
        return handle;
      },
      clearRepeat: (h) => this.clearTimer((h as { id: number }).id),
      onError: (e, ctx) => phone.errors.push(`${ctx}: ${describe(e)}`),
    });
    phone.setup = () =>
      createSetupFlow({
        platform,
        transport: getTransport,
        requestBluetooth: async () => 'granted',
        isBusy: () => false,
        optIn: () => phone.rt.optIn(),
        pair: (rec) => phone.rt.pair(rec),
        paired: () => phone.rt.state().link.paired,
        now: () => this.now(),
        sleep: (ms) => new Promise<void>((resolve) => this.timer(ms, resolve, phone)),
        onError: (e, ctx) => phone.errors.push(`setup ${ctx}: ${describe(e)}`),
      });
    this.phones.push(phone);
    await phone.rt.ready;
    await this.settle();
    return phone;
  }

  private makePlayer(phone: Phone): FakePlayer {
    const played: Played[] = [];
    const stops: number[] = [];
    let current: (() => void) | null = null;
    const p: FakePlayer = {
      played,
      stops,
      sounded: (since = 0) => played.filter((x) => x.at >= since && !x.dropped && !x.decision.silent),
      silent: (since = 0) => played.filter((x) => x.at >= since && !x.dropped && x.decision.silent === true),
      deliver: (d) => {
        const wanted = d.stillWanted ? d.stillWanted() : true;
        played.push({ at: this.W, decision: d, dropped: !wanted });
        if (!wanted) return Promise.resolve();
        const ms = d.silent ? 50 : d.tone ? (TONE_MS[d.tone] ?? 500) : (LEVEL_MS[d.level] ?? 300);
        return new Promise<void>((resolve) => {
          const done = () => {
            if (current === done) current = null;
            resolve();
          };
          current = done;
          this.timer(ms, done, phone);
        });
      },
      stopCurrent: () => {
        stops.push(this.W);
        const c = current;
        current = null;
        c?.();
        return Promise.resolve();
      },
      announce: async () => {},
    };
    return p;
  }

  /** The fake BLE stack's edges, joined to the simulator and the GATT model. */
  private wireBle(phone: Phone): void {
    const ble = phone.ble;
    const conn = phone.conn;
    const infoBytes = () =>
      encodeInfo({
        ver: 1,
        protoMin: 1,
        protoMax: 1,
        fwMajor: 3,
        fwMinor: 3,
        mac: MAC,
        peerBonded: this.bonds.has(phone.name),
        bondCount: this.bonds.size,
        pairingOpen: this.windowOpen,
      });
    ble.addPeripheral({
      id: phone.peripheralId,
      name: NAME,
      rssi: -55,
      get info() {
        return infoBytes();
      },
    } as never);

    const origStart = ble.start.bind(ble);
    ble.start = async (opts) => {
      await origStart(opts);
      // iOS reports the powered-on state through the state event once the manager exists.
      if (phone.platform === 'ios') queueMicrotask(() => ble.setState('on'));
    };

    const origConnect = ble.connect.bind(ble);
    ble.connect = (id, opts) =>
      origConnect(id, opts).then(() => {
        // The link is up at the dashcam: a bonded phone encrypts at once (authorized).
        const bonded = this.bonds.has(phone.name);
        phone.simConnected = true;
        phone.authorized = bonded;
        this.enqueue(`C ${conn} ${bonded ? 1 : 0} ${bonded ? 1 : 0}`);
      });

    const origDisconnect = ble.disconnect.bind(ble);
    ble.disconnect = (id, force) => {
      if (phone.simConnected) {
        phone.simConnected = false;
        phone.authorized = false;
        this.enqueue(`D ${conn}`);
      }
      return origDisconnect(id, force);
    };

    const origScan = ble.scan.bind(ble);
    ble.scan = async (o) => {
      await origScan(o);
      this.timer(
        200,
        () =>
          ble.advertise({
            id: phone.peripheralId,
            name: NAME,
            rssi: -55,
            advertising: { serviceUUIDs: [this.windowOpen ? PAIRING_SERVICE : DASHPAL_SERVICE], localName: NAME, isConnectable: true },
          }),
        phone
      );
    };

    const origRead = ble.read.bind(ble);
    ble.read = async (id, service, characteristic) => {
      if (characteristic === TX_CHAR && phone.simConnected && !phone.authorized) {
        // iOS: Insufficient Encryption makes the OS pair; the new bond then reaches the firmware.
        if (!(await this.bond(phone))) throw { domain: 'CBATTErrorDomain', code: 15, message: 'Encryption is insufficient.' };
      }
      return origRead(id, service, characteristic);
    };

    const origCreateBond = ble.createBond.bind(ble);
    ble.createBond = async (id) => {
      if (!phone.simConnected || !(await this.bond(phone))) throw new Error('Bond failed (the dashcam removed it)');
      return origCreateBond(id);
    };

    ble.onWrite = (w) => {
      if (!phone.simConnected || phone.blackholed) return;
      if (w.characteristic === RX_CHAR) {
        const line = `RX ${conn} ${toHex(w.bytes)}`;
        if (phone.latency.up > 0) this.timer(phone.latency.up, () => phone.simConnected && this.enqueue(line), null);
        else this.enqueue(line);
      } else if (w.characteristic === IDENTIFY_CHAR) {
        // ble_gatt.c CHR_IDENTIFY: only inside the window or on an authorized link, else ATT 0x80.
        if (!(phone.authorized || this.windowOpen)) {
          this.gatt.push({ at: this.W, phone: phone.name, what: 'identify refused (0x80)' });
          throw { domain: 'CBATTErrorDomain', code: 0x80, message: 'refused' };
        }
        if (w.bytes[0] === 1) this.gatt.push({ at: this.W, phone: phone.name, what: 'identify' });
      }
    };
  }

  /** A pairing completed on the phone's link: the firmware accepts it (window open) or not. */
  private bond(phone: Phone): Promise<boolean> {
    return new Promise<boolean>((resolve) => {
      this.enqueue(`BOND ${phone.conn}`, (out) => {
        const ok = out.includes('PLAY once 6') && !out.includes(`TERM ${phone.conn} unpair`);
        if (ok) {
          this.bonds.add(phone.name);
          phone.authorized = true;
        }
        resolve(ok);
      });
    });
  }

  // ——— phone conditions ———

  /** iOS suspends the app: no timers, no JS; the link stays up and notifications wait. */
  suspend(phone: Phone): void {
    phone.suspended = true;
  }

  async resume(phone: Phone): Promise<void> {
    phone.suspended = false;
    for (const bytes of phone.held.splice(0)) phone.ble.notify(phone.peripheralId, bytes);
    await this.settle();
  }

  /** A silent link loss: nothing passes; neither side has noticed yet. */
  blackhole(phone: Phone): void {
    phone.blackholed = true;
  }

  /** The supervision timeout finally fires on both sides. */
  async linkLost(phone: Phone): Promise<void> {
    phone.blackholed = false;
    this.endLink(phone, true);
    await this.settle();
  }

  /** Out of range: the link drops on both sides and reconnects hang until back in range. */
  async outOfRange(phone: Phone): Promise<void> {
    phone.ble.connectMode.set(phone.peripheralId, 'hang');
    this.endLink(phone, true);
    await this.settle();
  }

  async backInRange(phone: Phone): Promise<void> {
    phone.ble.connectMode.delete(phone.peripheralId);
    phone.ble.completeConnect(phone.peripheralId);
    await this.settle();
  }

  /** Hold the phone's statements matching `re` until the returned release runs. */
  holdDb(phone: Phone, re: RegExp): () => Promise<void> {
    phone.gate.re = re;
    return async () => {
      phone.gate.re = null;
      for (const run of phone.gate.queue.splice(0)) run();
      await this.settle();
    };
  }

  /** The app process dies: its runtime, timers and held writes are gone; the link drops. */
  async crash(phone: Phone): Promise<void> {
    phone.gate.queue.length = 0;
    phone.gate.re = null;
    phone.rt.dispose();
    this.timers = this.timers.filter((t) => t.owner !== phone);
    phone.ble.connectMode.set(phone.peripheralId, 'hang'); // the dead process never reconnects
    this.endLink(phone, true);
    phone.suspended = true; // nothing of the dead process runs again
    this.phones.splice(this.phones.indexOf(phone), 1);
    await this.settle();
  }

  /** A drive row from the phone's recorder (speed m/s; GNSS valid unless said). */
  row(phone: Phone, o: { speed: number; speedAcc?: number; gnssValid?: boolean }): void {
    const r: FeatureRow = {
      ts: this.now(),
      lat: 40,
      lng: -75,
      hAcc: 5,
      speed: o.speed,
      speedAcc: o.speedAcc ?? 0.5,
      course: 0,
      alt: 0,
      gnssValid: o.gnssValid ?? true,
      aLonMax: 0,
      aLonMin: 0,
      aLatMax: 0,
      aLatMin: 0,
      yawRateMax: 0,
      jerkMax: 0,
      gravityStability: 1,
      orientationDelta: 0,
      handlingScore: 0,
      locked: false,
      screenOn: true,
      appForeground: true,
    };
    phone.rt.row(r, { clientTripId: phone.host.recording ? phone.tripId : null, recording: phone.host.recording, dryRun: false });
  }

  /** Rows once a second for `ms`, while the phone is not suspended. */
  async drive(phone: Phone, ms: number, speed: number): Promise<void> {
    const end = this.W + ms;
    while (this.W < end) {
      if (!phone.suspended) this.row(phone, { speed });
      await this.runTo(Math.min(end, this.W + 1000));
    }
  }

  /** Bring a pre-paired phone's link up and through the handshake (HELLO, pings, RESUME, STATE). */
  async connected(phone: Phone, maxMs = 3000): Promise<void> {
    await this.until(() => phone.rt.state().link.lifecycle === 'connected' && phone.rt.state().link.synced, maxMs, `${phone.name} synced`);
    // The first STATE (the lease) follows the RESUME.
    await this.until(() => this.rxOf('STATE', phone.conn).length > 0, 2000, `${phone.name} STATE`);
  }
}

function describe(e: unknown): string {
  if (e instanceof Error) return e.message;
  if (e && typeof e === 'object') return JSON.stringify(e);
  return String(e);
}

/**
 * One scenario on a fresh dashcam: `fn` gets the world; the world is closed afterwards, and a
 * failure carries the simulator transcript (inputs without the clock lines, and every output).
 */
export async function scenario(o: WorldOptions, fn: (w: World) => Promise<void>): Promise<void> {
  const w = await World.create(o);
  try {
    await fn(w);
  } catch (e) {
    const tail = w.transcript().split('\n').slice(-150).join('\n');
    const errors = w.phones.map((p) => `${p.name}: ${p.errors.join(' | ') || 'no errors'}`).join('\n');
    if (e instanceof Error) e.message += `\n\n— simulator transcript (world ms, > in, < out) —\n${tail}\n— phone errors —\n${errors}`;
    throw e;
  } finally {
    w.close();
  }
}

/** A dashcam with phone A bonded and paired, linked and synced (lease held from the first STATE). */
export async function linkedA(w: World, o: { platform?: 'ios' | 'android'; recording?: boolean; buzzerToo?: boolean } = {}): Promise<Phone> {
  const a = await w.addPhone({ name: 'A', conn: 1, paired: true, ...o });
  await w.connected(a);
  return a;
}

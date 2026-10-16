// The cross-repo DashPal link test bench (plan §9): the firmware's real link logic (`ble_sim`, in WSL)
// on one side, the app's real DashPal code on the other, joined by the fake BLE stack.
//
// Phone side, per phone: `createFakeBle()` → `createBleTransport` → `createDashcamRuntime` (which
// builds the real `createDashcamLink` with its alert controller) over a migrated sql.js database
// (the real SQLite engine), a recording alert player and the phone's own SecureStore (an in-memory
// one per phone: its pairing key lives there); `createSetupFlow` for pairing.
// Wiring (link v2, docs/BLE_PROTOCOL.md §2.2, §3.3, §9): the INFO read is `INFO <conn>`, an AUTH write
// `AW <conn> <hex>` (ATT 00, or 80 for a malformed one: the write fails), an AUTH read `AR <conn>`;
// every RX write goes to the simulator sealed as `RX <conn> <wire>`; every `TX <conn> <wire> <plain>`
// the simulator prints is handed to that phone sealed (the wire), and the assertions read the plain
// frame. Connects and disconnects become `C` / `D` lines; the simulator's `TERM` (the dashcam ends a
// link) becomes `D` + a dropped link.
//
// A wiretap (the bench only, from the handshake it carries and the phone's own key) derives each
// session's phone → dashcam key, so `rx()` can still read the frames a phone wrote (`RXP` log lines;
// the simulator never sees them).
//
// One clock: world time `W` (ms). The phones read epoch `EPOCH0 + W` (link, transport, setup and
// player all take it injected; nothing runs on real timers), and the simulator's uptime is
// `W − (when it booted)`, sent with `T`. Time moves in steps of at most `STEP_MS`, stopping exactly
// at every phone timer; each step sends `T`, delivers what came out, runs the due timers and lets
// the promise chains (sql.js included) drain.
//
// The dashcam has a pairing code (`S`, `--label`) and the identity address `MAC`. A phone in
// `bonded` has its pairing stored on the dashcam at boot (`--phone <id>:<key>`, the key derived from
// its name); `addPhone({ paired: true })` gives the app that same pairing (SQLite record + its key in
// the phone's SecureStore). A reboot keeps every stored pairing whose key a phone of the bench holds
// (NVS survives a reboot).
//
// Phone conditions for the phone-first sound routing (BLE_PROTOCOL §1, §5): `suspend` freezes a
// phone outright (nothing runs, frames held: an Android app with no foreground service, a hung JS
// thread); `sleep` is an iOS app suspended in the background (its timers stop; a frame wakes it
// `wakeMs` later, and it runs while it handles frames and while a sound it started plays, then is
// frozen again; timers due meanwhile fire at the next wake); `background` on Android pauses its JS
// timers (only a frame or a row reaching it fires the due ones, as `processTimers.pump`); a sound in
// the fake player is native (it ends on time while JS timers are paused). `dropStatus` discards the
// dashcam's STATUS frames to a phone (negative tests), and each phone has an audio-output probe stub.
// What the simulator does not contain is modelled here: advertising (the pairing service while the
// window is open).
import type { AlertPlayer } from '@/core/alerts/player';
import type { AlertDecision } from '@/core/alerts/types';
import type { FeatureRow } from '@/core/engine/types';
import { createSqlJsDb } from '@/data/db/__fixtures__/sqljsDriver';
import { createSettingsRepo, createTripsRepo, migrate, type Db } from '@/data/db';

import { DIR_DP, DIR_PD, openRaw, proofOk, sealRaw, sessionKeys } from '../auth';
import { sha256, utf8 } from '../crypto';
import { createFakeBle, type FakeBle } from '../fakeTransport';
import { formatCode } from '../label';
import { PAIRED_KEY, type PairedDashcam } from '../keys';
import { AUTH_CHAR, DASHPAL_SERVICE, decodeRx, decodeTx, fromHex, INFO_CHAR, PAIRING_SERVICE, RX_CHAR, toHex, type RxFrame, type TxFrame } from '../protocol';
import { createDashcamRuntime, type DashcamRuntime } from '../runtime';
import { AUTH_PENDING_SECURE_KEY, AUTH_SECURE_KEY, createDashpalSecrets, type DashpalSecrets } from '../secure';
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
/** The dashcam's pairing code (its label). */
export const LABEL_S = Uint8Array.from({ length: 16 }, (_, i) => 0x30 + i);

/** Tone lengths the fake player takes (ms), as `scripts/make-tones.js` renders them. */
const TONE_MS: Record<string, number> = { dp_glance: 440, dp_drowsy: 940, dp_wake: 760, dp_phone: 360 };
const LEVEL_MS: Record<number, number> = { 1: 180, 2: 300, 3: 880 };

/** A phone's pairing with the bench's dashcam, derived from its name: its id there and its key. */
export function phoneKey(name: string): { id: string; kPair: string } {
  return { id: toHex(sha256(utf8(`phone id ${name}`)).slice(0, 8)), kPair: toHex(sha256(utf8(`phone key ${name}`))) };
}

export interface Played {
  at: number;
  decision: AlertDecision;
  /** `stillWanted()` said no as the item started */
  dropped: boolean;
}

export interface FakePlayer extends AlertPlayer {
  played: Played[];
  stops: number[];
  /** a sound is playing now (it keeps an iOS app awake) */
  busy(): boolean;
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
  /** a native timer of the phone's (a sound playing): it runs while JS timers are paused or asleep */
  native: boolean;
}

/** How long a sleeping iOS app runs after it handled a frame (its JS settles within it). */
export const HANDLE_MS = 50;

export interface DbGate {
  re: RegExp | null;
  queue: (() => void)[];
}

interface Pending {
  line: string;
  after?: (out: string[]) => void;
}

export interface Mark {
  mark: number;
}
export type Since = number | Mark;

export interface LogLine {
  /** world time */
  at: number;
  /** the simulator's uptime then */
  uptime: number;
  dir: 'in' | 'out';
  line: string;
}

/** The wiretap's view of one connection's handshake. */
interface Tap {
  np: number[] | null;
  resp: { nd: number[]; proofD: number[] } | null;
  /** the session's phone → dashcam key, once a session is up */
  kpd: Uint8Array | null;
  /** the session's dashcam → phone key, and the highest TX counter seen (for `injectTx`) */
  kdp: Uint8Array | null;
  txCtr: number;
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
  /** the phone's SecureStore (its pairing key), and its raw entries */
  secrets: DashpalSecrets;
  secureStore: Map<string, string>;
  player: FakePlayer;
  /** the drive host; `driveOpen` (the drive is open, finalize included) follows `recording` when unset */
  host: { recording: boolean; driveOpen?: boolean; playerAvailable: boolean; callActive: boolean };
  style: { sound: boolean };
  appState: { currentState: string; emit(s: string): void; addEventListener(t: 'change', fn: (s: string) => void): { remove(): void } };
  tripId: string;
  errors: string[];
  /** the dashcam sees this phone connected */
  simConnected: boolean;
  /** the wiretap of the current connection */
  tap: Tap;
  /** iOS suspended the app: its timers stop and notifications wait */
  suspended: boolean;
  /** frames held while suspended */
  held: number[][];
  /** a silent link loss: nothing passes either way, no disconnect yet */
  blackholed: boolean;
  /** what drive-sense `audioOutputState` answers */
  audio: { callActive: boolean; volume: number | null; headphones: boolean | null };
  /** Android: when the link held the alert wake lock */
  holds: number[];
  /** iOS asleep in the background: frames wake it after `wakeMs` */
  asleep: { wakeMs: number } | null;
  /** asleep: it runs until then (handling a frame) */
  awakeUntil: number;
  /** asleep: frames waiting for the wake under way */
  waking: number[][] | null;
  /** Android in the background: JS timers fire only from a frame or a row */
  paused: boolean;
  /** the world discards STATUS frames to this phone */
  statusDropped: boolean;
  /** every RX frame this phone wrote, in clear (the wiretap; also those a dead link swallowed) */
  sent: { at: number; bytes: number[] }[];
  /** iOS state restoration pending: the next start hands the kept connection back */
  restoring: boolean;
  latency: { up: number; down: number };
  transport(): DashcamTransport;
  setup(): SetupFlow;
}

export interface WorldOptions {
  /** hex, like the device's; random when omitted */
  bootId?: string;
  /** phones (by name) whose pairings the dashcam holds at boot; none opens the pairing window */
  bonded?: string[];
  ackMs?: number;
  /** the dashcam has no pairing code (an unkeyed board) */
  unkeyed?: boolean;
  /** another identity address than `MAC` (a device answering at the paired address that is not the DashPal) */
  mac?: string;
}

const fresh = (): Tap => ({ np: null, resp: null, kpd: null, kdp: null, txCtr: -1 });

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
  readonly log: LogLine[] = [];
  readonly phones: Phone[] = [];
  windowOpen = false;
  /** the link holding the setup claim (the simulator's `CLAIM` lines) */
  claimConn: number | null = null;
  private readonly opts: WorldOptions;
  private timers: Timer[] = [];
  private timerSeq = 0;
  private pending: Pending[] = [];
  private closed = false;

  private constructor(sim: SimProcess, opts: WorldOptions) {
    this.sim = sim;
    this.opts = opts;
  }

  private static args(o: WorldOptions, phones: { id: string; kPair: string }[]): string[] {
    return [
      ...(o.bootId ? ['--boot-id', o.bootId] : []),
      ...(o.ackMs !== undefined ? ['--ack-ms', String(o.ackMs)] : []),
      ...(o.unkeyed ? [] : ['--label', toHex(LABEL_S)]),
      '--mac',
      o.mac ?? CAM,
      ...phones.flatMap((p) => ['--phone', `${p.id}:${p.kPair}`]),
    ];
  }

  static async create(o: WorldOptions = {}): Promise<World> {
    const bonded = (o.bonded ?? []).map(phoneKey);
    const w = new World(new SimProcess(World.args(o, bonded)), o);
    w.windowOpen = bonded.length === 0;
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

  timer(ms: number, fn: () => void, owner: Phone | null, native = false): number {
    this.timerSeq += 1;
    const t: Timer = { id: this.timerSeq, at: this.W + Math.max(0, ms), seq: this.timerSeq, fn, owner, native };
    this.timers.push(t);
    return t.id;
  }

  /** A sleeping iOS app with nothing to do now: no frame being handled, no sound playing. */
  private frozen(phone: Phone): boolean {
    return phone.asleep !== null && this.W >= phone.awakeUntil && !phone.player.busy();
  }

  /** Whether `t` may fire now. */
  private runnable(t: Timer): boolean {
    const o = t.owner;
    if (!o) return true;
    if (o.suspended) return false;
    if (t.native) return true;
    return !o.paused && !this.frozen(o);
  }

  clearTimer(id: unknown): void {
    this.timers = this.timers.filter((t) => t.id !== id);
  }

  private nextTimer(): Timer | null {
    let best: Timer | null = null;
    for (const t of this.timers) {
      if (!this.runnable(t)) continue;
      if (!best || t.at < best.at || (t.at === best.at && t.seq < best.seq)) best = t;
    }
    return best;
  }

  /** Timers fired at the current instant (a zero-delay re-arm loop never lets time move). */
  private firedAt = { w: -1, n: 0 };

  private async runDue(): Promise<void> {
    for (;;) {
      const t = this.nextTimer();
      if (!t || t.at > this.W) return;
      if (this.firedAt.w !== this.W) this.firedAt = { w: this.W, n: 0 };
      this.firedAt.n += 1;
      if (this.firedAt.n > 2000) {
        throw new Error(`world: more than 2000 timers fired at W=${this.W} without time moving (a zero-delay re-arm loop; owner ${t.owner?.name ?? 'bench'})`);
      }
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

  /** A request line answered by the simulator (INFO, AW, AR): resolves with its answer line. */
  private ask(line: string, answer: string): Promise<string> {
    return new Promise<string>((resolve) => {
      this.enqueue(line, (out) => resolve(out.find((l) => l.startsWith(answer)) ?? ''));
    });
  }

  private handleOut(out: string[]): void {
    for (const line of out) {
      this.log.push({ at: this.W, uptime: this.uptime(), dir: 'out', line });
      const p = line.split(' ');
      const phone = p[1] !== undefined ? this.phones.find((x) => x.conn === Number(p[1])) : undefined;
      if (p[0] === 'TX') {
        if (phone) {
          const wire = fromHex(p[2] ?? '');
          phone.tap.txCtr = Math.max(phone.tap.txCtr, ((wire[0] ?? 0) | ((wire[1] ?? 0) << 8) | ((wire[2] ?? 0) << 16) | ((wire[3] ?? 0) << 24)) >>> 0);
          this.toPhone(phone, wire, p[3] ?? '');
        }
      } else if (p[0] === 'TERM') {
        // NimBLE terminates the link; its disconnect event reaches ble_link (and the phone).
        if (!phone || phone.simConnected) this.enqueue(`D ${p[1]}`);
        if (phone) this.endLink(phone, false);
      } else if (p[0] === 'AUTH' && phone && (p[2] === 'up' || p[2] === 'rekey')) {
        this.tapSession(phone);
      } else if (p[0] === 'WINDOW') {
        this.windowOpen = p[1] === '1';
      } else if (p[0] === 'CLAIM') {
        this.claimConn = p[1] === '-' ? null : Number(p[1]);
      }
    }
  }

  /** The wiretap: the session's phone → dashcam key, from the handshake and the phone's own key. */
  private tapSession(phone: Phone): void {
    const t = phone.tap;
    t.kpd = null;
    t.kdp = null;
    t.txCtr = -1;
    if (!t.np || !t.resp) return;
    for (const key of [AUTH_SECURE_KEY, AUTH_PENDING_SECURE_KEY]) {
      const raw = phone.secureStore.get(key);
      if (!raw) continue;
      try {
        const a = JSON.parse(raw) as { phoneId: string; kPair: string };
        const k = sessionKeys(fromHex(a.kPair), MAC, fromHex(a.phoneId), t.np, t.resp.nd);
        if (proofOk(k.proofD, Uint8Array.from(t.resp.proofD))) {
          t.kpd = k.k_pd;
          t.kdp = k.k_dp;
          return;
        }
      } catch {
        // not a key
      }
    }
  }

  /** A sealed TX frame to the phone; `plain` is its frame in clear (the simulator prints both). */
  private toPhone(phone: Phone, bytes: number[], plain: string): void {
    if (phone.blackholed) return;
    // STATUS is type 0x02.
    if (phone.statusDropped && plain.startsWith('02')) return;
    const deliver = () => {
      if (phone.blackholed || !phone.ble.connected.has(phone.peripheralId)) return;
      if (phone.suspended) {
        phone.held.push(bytes);
        return;
      }
      if (phone.asleep && (phone.waking !== null || this.frozen(phone))) {
        // iOS wakes the app for a notification of a subscribed characteristic, `wakeMs` later.
        if (phone.waking === null) {
          phone.waking = [];
          this.timer(phone.asleep.wakeMs, () => this.wake(phone), null);
        }
        phone.waking.push(bytes);
        return;
      }
      this.notify(phone, bytes);
    };
    if (phone.latency.down > 0) this.timer(phone.latency.down, deliver, null);
    else deliver();
  }

  /** Hand a frame to the phone's BLE stack (an Android phone in the background pumps its timers first). */
  private notify(phone: Phone, bytes: number[]): void {
    if (!phone.ble.connected.has(phone.peripheralId)) return;
    if (phone.paused) this.pumpPhone(phone);
    phone.ble.notify(phone.peripheralId, bytes);
    if (phone.asleep) phone.awakeUntil = Math.max(phone.awakeUntil, this.W + HANDLE_MS);
  }

  private wake(phone: Phone): void {
    const frames = phone.waking ?? [];
    phone.waking = null;
    if (!phone.asleep) return;
    phone.awakeUntil = Math.max(phone.awakeUntil, this.W + HANDLE_MS);
    for (const b of frames) this.notify(phone, b);
  }

  /** `processTimers.pump()`: fire the phone's JS timers already due, in due order. */
  private pumpPhone(phone: Phone): void {
    const due = this.timers.filter((t) => t.owner === phone && !t.native && t.at <= this.W).sort((a, b) => a.at - b.at || a.seq - b.seq);
    for (const t of due) {
      if (!this.timers.includes(t)) continue;
      this.timers = this.timers.filter((x) => x !== t);
      t.fn();
    }
  }

  /** The link ends on the phone's side (a disconnect event). `toDashcam`: also tell the dashcam. */
  private endLink(phone: Phone, toDashcam: boolean): void {
    if (toDashcam && phone.simConnected) this.enqueue(`D ${phone.conn}`);
    phone.simConnected = false;
    phone.tap = fresh();
    if (phone.ble.connected.has(phone.peripheralId)) phone.ble.drop(phone.peripheralId);
  }

  /** The dashcam's stored pairings whose keys a phone of the bench holds (to carry over a reboot). */
  private async storedPairings(): Promise<{ id: string; kPair: string }[]> {
    const out = await this.simLine('PHONES');
    const ids = (out.find((l) => l.startsWith('PHONES '))?.split(' ').slice(2) ?? []).filter((s) => s.length === 16);
    const known = new Map<string, string>();
    for (const name of this.opts.bonded ?? []) known.set(phoneKey(name).id, phoneKey(name).kPair);
    for (const ph of this.phones) {
      for (const key of [AUTH_SECURE_KEY, AUTH_PENDING_SECURE_KEY]) {
        const raw = ph.secureStore.get(key);
        if (!raw) continue;
        try {
          const a = JSON.parse(raw) as { phoneId: string; kPair: string };
          known.set(a.phoneId, a.kPair);
        } catch {
          // not a key
        }
      }
    }
    return ids.filter((id) => known.has(id)).map((id) => ({ id, kPair: known.get(id)! }));
  }

  /** The dashcam reboots: a new simulator (new random boot id unless given), its pairings kept (NVS). */
  async reboot(o: { bootId?: string; gapMs?: number } = {}): Promise<void> {
    await this.settle();
    const keep = await this.storedPairings();
    for (const phone of this.phones) {
      phone.simConnected = false;
      phone.tap = fresh();
      if (phone.ble.connected.has(phone.peripheralId)) phone.ble.drop(phone.peripheralId);
    }
    this.sim.close();
    this.W += o.gapMs ?? 0;
    this.bootAt = this.W;
    this.sim = new SimProcess(World.args({ ...this.opts, bootId: o.bootId }, keep));
    this.windowOpen = keep.length === 0;
    this.claimConn = null;
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

  /** A point in the log: `since` arguments take a world time or a mark (lines after it). */
  mark(): Mark {
    return { mark: this.log.length };
  }

  private after(since: Since): LogLine[] {
    return typeof since === 'number' ? this.log.filter((l) => l.at >= since) : this.log.slice(since.mark);
  }

  out(since: Since = 0): LogLine[] {
    return this.after(since).filter((l) => l.dir === 'out');
  }

  /** Frames the dashcam notified (to `conn`, or all), read in clear. */
  tx(conn?: number, since: Since = 0): { at: number; conn: number; f: TxFrame }[] {
    const got: { at: number; conn: number; f: TxFrame }[] = [];
    for (const l of this.out(since)) {
      const p = l.line.split(' ');
      if (p[0] !== 'TX' || (conn !== undefined && Number(p[1]) !== conn)) continue;
      const d = decodeTx(fromHex(p[3] ?? ''));
      if (!d.ok) throw new Error(`the simulator sent an undecodable frame: ${l.line} (${d.reason})`);
      got.push({ at: l.at, conn: Number(p[1]), f: d.frame });
    }
    return got;
  }

  txOf<T extends TxFrame['type']>(type: T, conn?: number, since: Since = 0): { at: number; conn: number; f: Extract<TxFrame, { type: T }> }[] {
    return this.tx(conn, since).filter((x) => x.f.type === type) as never;
  }

  /** Frames the phones wrote that reached the dashcam, read in clear through the wiretap. */
  rx(conn?: number, since: Since = 0): { at: number; conn: number; f: RxFrame }[] {
    const got: { at: number; conn: number; f: RxFrame }[] = [];
    for (const l of this.after(since)) {
      if (l.dir !== 'in') continue;
      const p = l.line.split(' ');
      if (p[0] !== 'RXP' || (conn !== undefined && Number(p[1]) !== conn)) continue;
      const d = decodeRx(fromHex(p[2] ?? ''));
      if (d.ok) got.push({ at: l.at, conn: Number(p[1]), f: d.frame });
    }
    return got;
  }

  rxOf<T extends RxFrame['type']>(type: T, conn?: number, since: Since = 0): { at: number; conn: number; f: Extract<RxFrame, { type: T }> }[] {
    return this.rx(conn, since).filter((x) => x.f.type === type) as never;
  }

  /** What the buzzer audibly did: `PLAY cont c l`, `PLAY once c`, `STOP`. */
  buzzer(since: Since = 0): { at: number; line: string }[] {
    return this.out(since)
      .filter((l) => l.line.startsWith('PLAY') || l.line === 'STOP')
      .map((l) => ({ at: l.at, line: l.line }));
  }

  lines(prefix: string, since: Since = 0): { at: number; line: string }[] {
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
    /** the app holds the pairing (its record and its key; the dashcam holds it when the phone is in `bonded`) */
    paired?: boolean;
    recording?: boolean;
    buzzerToo?: boolean;
    db?: Db;
    /** one-way delays (ms), from the first connect */
    latency?: { up: number; down: number };
    /** the phone's SecureStore entries (a relaunch keeps them) */
    secureStore?: Map<string, string>;
    /** iOS state restoration: the OS kept this connection up and hands it back at start (no new connect) */
    restoredLink?: boolean;
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
    const secureStore = o.secureStore ?? new Map<string, string>();
    const secrets = createDashpalSecrets(() => ({
      getItemAsync: async (k) => secureStore.get(k) ?? null,
      setItemAsync: async (k, v) => void secureStore.set(k, v),
      deleteItemAsync: async (k) => void secureStore.delete(k),
    }));
    if (o.paired && !o.secureStore) {
      const rec: PairedDashcam = { dashcamId: CAM, peripheralId, name: NAME, pairedAt: this.now(), secure: true };
      await settings.set(PAIRED_KEY, rec);
      const k = phoneKey(o.name);
      // paired from the label: the phone keeps its code for Set up again
      await secrets.writePendingAuth({ dashcamId: CAM, phoneId: k.id, kPair: k.kPair, code: formatCode(LABEL_S, 'label', { dashes: false }) });
      await secrets.finalizeAuth();
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
      secrets,
      secureStore,
      host: { recording: o.recording ?? false, playerAvailable: true, callActive: false },
      style: { sound: true },
      appState,
      tripId,
      errors: [] as string[],
      simConnected: false,
      tap: fresh(),
      suspended: false,
      held: [] as number[][],
      blackholed: false,
      latency: { up: o.latency?.up ?? 0, down: o.latency?.down ?? 0 },
      audio: { callActive: false, volume: null, headphones: null },
      holds: [] as number[],
      asleep: null,
      awakeUntil: 0,
      waking: null,
      paused: false,
      statusDropped: false,
      restoring: o.restoredLink === true,
      sent: [] as { at: number; bytes: number[] }[],
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
      host: () => ({ ...phone.host, driveOpen: phone.host.driveOpen ?? phone.host.recording }),
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
      audioOutput: () => ({ ...phone.audio }),
      secrets,
      ensureInstallMarker: async () => {},
      ...(platform === 'android'
        ? {
            holdAwake: () => {
              phone.holds.push(this.W);
            },
          }
        : {}),
    });
    phone.setup = () =>
      createSetupFlow({
        platform,
        transport: getTransport,
        requestBluetooth: async () => 'granted',
        isBusy: () => false,
        onDriveChange: () => () => {},
        optIn: () => phone.rt.optIn(),
        pair: (rec) => phone.rt.pair(rec),
        paired: () => phone.rt.state().link.paired,
        keyRefused: (d) => {
          const l = phone.rt.state().link;
          return l.repairCause === 'unknown_phone' && l.paired?.dashcamId === d;
        },
        stepAside: () => phone.rt.stepAside(),
        resumePaired: () => phone.rt.resumePaired(),
        secrets,
        notePhones: (d, n) => phone.rt.notePhones(d, n),
        now: () => this.now(),
        sleep: (ms) => new Promise<void>((resolve) => this.timer(ms, resolve, phone)),
        onError: (e, ctx) => {
          phone.errors.push(`setup ${ctx}: ${describe(e)}`);
        },
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
      busy: () => current !== null,
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
          this.timer(ms, done, phone, true);
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

  /** The fake BLE stack's edges, joined to the simulator (INFO, AUTH, RX, connects) and advertising. */
  private wireBle(phone: Phone): void {
    const ble = phone.ble;
    const conn = phone.conn;
    ble.addPeripheral({ id: phone.peripheralId, name: NAME, rssi: -55 });

    const origStart = ble.start.bind(ble);
    ble.start = async (opts) => {
      await origStart(opts);
      // iOS reports the powered-on state through the state event once the manager exists.
      if (phone.platform === 'ios') queueMicrotask(() => ble.setState('on'));
      // iOS state restoration: the kept connection comes back during start (the dashcam still has it).
      if (phone.restoring) {
        phone.restoring = false;
        phone.simConnected = true;
        ble.restore([phone.peripheralId]);
      }
    };

    // The link is up at the dashcam: a new connection (its own Nc).
    ble.onConnect = (id) => {
      if (id !== phone.peripheralId) return;
      phone.simConnected = true;
      phone.tap = fresh();
      this.enqueue(`C ${conn}`);
    };
    // The phone ends the connection.
    ble.onDisconnect = (id) => {
      if (id !== phone.peripheralId || !phone.simConnected) return;
      phone.simConnected = false;
      phone.tap = fresh();
      this.enqueue(`D ${conn}`);
    };

    ble.onRead = async (id, characteristic) => {
      if (id !== phone.peripheralId) return undefined;
      if (!phone.simConnected || phone.blackholed) throw { message: 'Device is not connected' };
      if (characteristic === INFO_CHAR) return fromHex((await this.ask(`INFO ${conn}`, `INFO ${conn} `)).split(' ')[2] ?? '');
      if (characteristic === AUTH_CHAR) {
        const hex = (await this.ask(`AR ${conn}`, `AR ${conn} `)).split(' ')[2] ?? '';
        const b = fromHex(hex);
        if (b[0] === 0xa0 && b.length === 34) phone.tap.resp = { nd: b.slice(2, 18), proofD: b.slice(18, 34) };
        return b;
      }
      return undefined;
    };

    // The DashPal advertises all the time (the pairing service while its window is open): while a
    // scan runs, the phone hears it every 100 ms, from 200 ms after the scan starts.
    let scanGen = 0;
    const origScan = ble.scan.bind(ble);
    ble.scan = async (o) => {
      await origScan(o);
      scanGen += 1;
      const gen = scanGen;
      const end = this.W + o.seconds * 1000;
      const advert = () => {
        if (gen !== scanGen || this.W > end) return;
        ble.advertise({
          id: phone.peripheralId,
          name: NAME,
          rssi: -55,
          advertising: { serviceUUIDs: [this.windowOpen ? PAIRING_SERVICE : DASHPAL_SERVICE], localName: NAME, isConnectable: true },
        });
        this.timer(100, advert, phone, true);
      };
      this.timer(200, advert, phone, true);
    };
    const origStop = ble.stopScan.bind(ble);
    ble.stopScan = async () => {
      scanGen += 1;
      await origStop();
    };

    ble.onWrite = async (w) => {
      if (w.characteristic === RX_CHAR && phone.tap.kpd) {
        const o = openRaw(phone.tap.kpd, DIR_PD, w.bytes);
        if (o) phone.sent.push({ at: this.W, bytes: Array.from(o.frame) });
      }
      if (!phone.simConnected || phone.blackholed) {
        if (w.characteristic === AUTH_CHAR) throw { message: 'Device is not connected' };
        return;
      }
      if (w.characteristic === RX_CHAR) {
        const line = `RX ${conn} ${toHex(w.bytes)}`;
        const after = () => {
          const k = phone.tap.kpd;
          const o = k ? openRaw(k, DIR_PD, w.bytes) : null;
          if (o) this.log.push({ at: this.W, uptime: this.uptime(), dir: 'in', line: `RXP ${conn} ${toHex(o.frame)}` });
        };
        if (phone.latency.up > 0) this.timer(phone.latency.up, () => phone.simConnected && this.enqueue(line, after), null);
        else this.enqueue(line, after);
      } else if (w.characteristic === AUTH_CHAR) {
        if (w.bytes[0] === 0x20 && w.bytes.length === 26) phone.tap.np = w.bytes.slice(10, 26);
        const st = (await this.ask(`AW ${conn} ${toHex(w.bytes)}`, `AW ${conn} `)).split(' ')[2];
        // ble-manager reports a failed write as a `status=N` text.
        if (st !== '00') throw { message: `Error writing characteristic status=${st === '80' ? 128 : st}` };
      }
    };
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

  /** iOS puts the app in the background and suspends it: frames wake it `wakeMs` later. */
  async sleep(phone: Phone, o: { wakeMs?: number } = {}): Promise<void> {
    phone.appState.emit('background');
    phone.asleep = { wakeMs: o.wakeMs ?? 150 };
    phone.awakeUntil = this.W;
    await this.settle();
  }

  /** Android: RoadWise goes to the background (the link service keeps it alive; JS timers pause). */
  async background(phone: Phone): Promise<void> {
    phone.appState.emit('background');
    if (phone.platform === 'android') phone.paused = true;
    await this.settle();
  }

  /** RoadWise back in front (awake, timers running). */
  async foreground(phone: Phone): Promise<void> {
    phone.asleep = null;
    const frames = phone.waking ?? [];
    phone.waking = null;
    phone.paused = false;
    for (const b of frames) this.notify(phone, b);
    phone.appState.emit('active');
    await this.settle();
  }

  /** The world discards the dashcam's STATUS frames to this phone (on) or stops doing so. */
  dropStatus(phone: Phone, on: boolean): void {
    phone.statusDropped = on;
  }

  /**
   * A frame the firmware never sends (a malformed one), sealed as the dashcam seals on this phone's
   * session and handed to the phone. It takes the counters after the dashcam's last one, which the
   * dashcam reuses next (the phone drops those as replays): use it at the end of a test.
   */
  injectTx(phone: Phone, frame: number[]): void {
    const k = phone.tap.kdp;
    if (!k) throw new Error(`${phone.name} has no session to seal for`);
    phone.tap.txCtr += 1;
    phone.ble.notify(phone.peripheralId, Array.from(sealRaw(k, DIR_DP, phone.tap.txCtr, frame)));
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

  /**
   * iOS relaunches RoadWise with the connection kept (state restoration): the old process is gone
   * (its runtime, keys in memory and timers), the dashcam still holds the link and its session; the
   * new process gets the connection back at start and proves its key again on it.
   */
  async relaunch(phone: Phone): Promise<Phone> {
    phone.gate.queue.length = 0;
    phone.gate.re = null;
    phone.rt.dispose();
    this.timers = this.timers.filter((t) => t.owner !== phone);
    phone.suspended = true; // the old process runs nothing more; its frames go nowhere
    this.phones.splice(this.phones.indexOf(phone), 1);
    const next = await this.addPhone({ name: phone.name, conn: phone.conn, platform: phone.platform, db: phone.rawDb, secureStore: phone.secureStore, restoredLink: true });
    await this.settle();
    return next;
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
    // The host pumps the process timers on every row (Android in the background).
    if (phone.paused) this.pumpPhone(phone);
    phone.rt.row(r, { clientTripId: phone.host.recording ? phone.tripId : null, recording: phone.host.recording, dryRun: false });
  }

  /** Rows once a second for `ms`, while the phone is not suspended. */
  async drive(phone: Phone, ms: number, speed: number): Promise<void> {
    const end = this.W + ms;
    while (this.W < end) {
      if (!phone.suspended && !phone.asleep) this.row(phone, { speed });
      await this.runTo(Math.min(end, this.W + 1000));
    }
  }

  /** Bring a pre-paired phone's link up and through the handshake (HELLO, pings, RESUME, STATE). */
  async connected(phone: Phone, maxMs = 3000): Promise<void> {
    await this.until(() => phone.rt.state().link.lifecycle === 'connected' && phone.rt.state().link.synced, maxMs, `${phone.name} synced`);
    // The first STATE follows the RESUME (whatever the cadence).
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

/** A dashcam with phone A paired (on both sides), linked and synced (its first STATE sent). */
export async function linkedA(w: World, o: { platform?: 'ios' | 'android'; recording?: boolean; buzzerToo?: boolean } = {}): Promise<Phone> {
  const a = await w.addPhone({ name: 'A', conn: 1, paired: true, ...o });
  await w.connected(a);
  return a;
}

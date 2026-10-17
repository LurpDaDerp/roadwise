// Setting up a DashPal (link v3, docs/BLE_PROTOCOL.md §2-§4): only on the driver's explicit action,
// never while a drive is open. There is no code: the driver picks the DashPal (the Home card, Set up
// again, or a search for one in pairing mode), sees it with Pair, and taps Pair once. Only then the
// phone connects and pairs: PAIR_OPEN with a fresh X25519 key, the dashcam's key confirmation
// checked, PAIR_FIN; the DashPal holds the new phone provisionally under a setup hold (no other
// phone can pair meanwhile) and plays its chime; a first session proves the key on the same
// connection, and the phone sends its state (no "can play", a speed only from a fresh location
// sample). After the aiming steps, Next commits the hold (COMMAND 8): only then does the DashPal
// store the phone, and only then does this phone keep the key. Cancel undoes a hold on both sides
// (COMMAND 9: the DashPal forgets the provisional phone and is ready to pair again).
//
// Every result of the dashcam travels in the AUTH read value or a sealed SETUP_RESULT; a non-zero
// write status, a GATT error or a disconnect before a verdict is read is a link failure (one
// reconnect before PAIR_FIN; during the hold, reconnecting under the new key for up to 45 s), never a
// verdict. A failed or cancelled setup leaves the previous pairing in place. UI-free: the screen
// renders `phase` and calls the actions.
import type { BluetoothAccess } from '@/core/permissions/adapters';

import { pairFin, pairKeysV3, pairOpen, proofOk, R, type AuthRecord } from './auth';
import { randomBytes, wipe, x25519Public } from './crypto';
import type { PairedDashcam } from './keys';
import {
  AIM_ARG,
  COMMAND,
  decodeTx,
  encodeRx,
  linkMismatch,
  LOCAL_MIN_UNKNOWN,
  nameOf,
  PAIRING_NEW,
  PAIRING_OPEN,
  STATE_FLAG,
  STATE_TTL_DS,
  toHex,
  type AdvState,
  type DashcamInfo,
  type SetupResultFrame,
} from './protocol';
import type { DashpalSecrets, StoredAuth } from './secure';
import { createSetupSpeed, type SetupSpeed } from './setupSpeed';
import { isIosBondLoss, type DashcamTransport, type ScanHit } from './transport';

/** Search mode: the scan for DashPals in pairing mode, and its stop after the first one heard. */
export const SEARCH_MS = 15_000;
export const SCAN_SETTLE_MS = 3000;
export const MIN_RSSI = -80;
/** Watching for pairing mode to open after "Press the DashPal's button 5 times" (Set up again). */
export const PRESS_WAIT_MS = 60_000;
/** Another phone setting the DashPal up: INFO again every second, for this long. */
export const BUSY_POLL_MS = 1000;
export const BUSY_WAIT_MS = 16_000;
export const SETUP_CONNECT_TIMEOUT_MS = 10_000;
/** AUTH read polls while a pairing answer is computed. */
export const PAIR_POLL_MS = 100;
export const PAIR_RESP_MS = 3000;
/** A RESULT after a FIN. */
export const RESULT_MS = 1000;
/** The phone's own wait before a new PAIR_OPEN after R_NOT_NOW, and the most of them per connection. */
export const NOT_NOW_RETRY_MS = 300;
export const NOT_NOW_RETRIES = 2;
/** A claim lasts 15 s from its first request at the dashcam. */
export const CLAIM_MS = 15_000;
/** Waiting for PAIRED after COMMAND 5. */
export const PAIRED_WAIT_MS = 3000;
/** The spinner shows at least this long, then the check mark this long. */
export const MIN_SPINNER_MS = 600;
export const CHECK_HOLD_MS = 900;
/** The setup's STATE cadence. */
export const SETUP_STATE_MS = 900;
/** Waiting for SETUP_RESULT after COMMAND 8, and after COMMAND 9. */
export const SETUP_RESULT_MS = 2000;
export const CANCEL_WAIT_MS = 1500;
/** The hold's phone away: the phone reconnects for this long (inside the DashPal's 60 s). */
export const HOLD_RECONNECT_MS = 45_000;
/** The setup hold's 10 minutes (the DashPal's `BLE_HOLD_MAX_MS`), and the countdown's last minute. */
export const HOLD_MAX_MS = 600_000;
export const HOLD_WARN_MS = 60_000;
/** iOS: an R_MTU waits this long before the request is sent again. */
export const IOS_MTU_WAIT_MS = 300;
/** How often the loops look at what they heard. */
export const POLL_MS = 50;

export interface Candidate {
  id: string;
  name: string | null;
  rssi: number;
  adv: AdvState | null;
}

export type SetupFailure =
  | 'not_found'
  | 'window_closed'
  | 'setup_busy'
  | 'unverified'
  | 'update_firmware'
  | 'update_app'
  | 'mtu'
  | 'ios_forget_first'
  | 'lost'
  | 'expired'
  | 'save_failed'
  | 'none_nearby'
  | 'error';

/** What Try again does: start over, finish a setup whose commit went unanswered, send the commit again, or nothing. */
export type SetupRetry = 'restart' | 'resume' | 'commit' | 'none';

export type SetupPhase =
  | { kind: 'idle' }
  | { kind: 'busy' }
  | { kind: 'permission' }
  | { kind: 'denied' }
  | { kind: 'off' }
  | { kind: 'unavailable' }
  | { kind: 'search'; until: number }
  | { kind: 'choose'; candidates: Candidate[] }
  | { kind: 'press_button'; name: string; until: number }
  /** Screen 1: the DashPal with Pair. `replaces`: the paired DashPal this one replaces on this phone. */
  | { kind: 'confirm'; name: string; mode: 'new' | 'open' | 'again'; replaces: string | null }
  | { kind: 'waiting_busy'; name: string; until: number }
  | { kind: 'connecting'; name: string; reconnecting: boolean }
  | { kind: 'connected'; name: string }
  /** Screen 2. `aimAllowed`: false when the window came from Add another phone; `holdLeftS` in the hold's last minute. */
  | { kind: 'instructions'; aimAllowed: boolean; holdLeftS: number | null; reconnecting: boolean }
  | { kind: 'finishing' }
  /** `phones`: the count after the commit; `notAllYours`: 2 or more; `aimedElsewhere`: no aiming here (Add another phone). */
  | { kind: 'done'; paired: PairedDashcam; phones: number | null; notAllYours: boolean; aimedElsewhere: boolean }
  | { kind: 'failed'; reason: SetupFailure; name: string | null; retry: SetupRetry }
  | { kind: 'stopping' }
  | { kind: 'cancelled' };

export interface SetupDeps {
  platform: 'ios' | 'android';
  transport: () => DashcamTransport | null;
  /** The permissions adapter's DashPal request (the driver tapped). */
  requestBluetooth(): Promise<BluetoothAccess>;
  /** The drive host is busy (a drive open or closing). */
  isBusy(): boolean;
  /** The drive host's state changed (a drive may have opened). Returns the unsubscribe. */
  onDriveChange(fn: () => void): () => void;
  /** Record the opt-in (settings + the launch flag). */
  optIn(): Promise<void>;
  /** Save the pairing (its key is final in SecureStore) and hand it to the auto-connect. */
  pair(record: PairedDashcam): Promise<void>;
  /** The currently paired dashcam (a setup of another one replaces it). */
  paired(): PairedDashcam | null;
  /** The paired DashPal refused this phone's key at its auto-connect's last session (R_UNKNOWN_PHONE). */
  keyRefused(dashcamId: string): boolean;
  /** The paired dashcam's auto-connect steps aside while the setup uses the radio (from the Pair tap). */
  stepAside(): void;
  /** The paired dashcam's auto-connect again (a setup that did not pair). */
  resumePaired(): Promise<void>;
  secrets: DashpalSecrets;
  /** This phone's own setup saw this phone count (the new-phone notice does not count it). */
  notePhones?(dashcamId: string, phones: number): void;
  /** The car's speed for the setup's STATE (default: a location watch while setup runs). */
  speed?(): SetupSpeed;
  /** Local time of day in minutes (default: the phone's clock). */
  localMinute?(now: number): number;
  now(): number;
  sleep(ms: number): Promise<void>;
  random?(n: number): Uint8Array;
  onError?(e: unknown, ctx: string): void;
}

export interface SetupStart {
  /** a DashPal the Home card offered */
  target?: { peripheralId: string; name: string | null; adv: AdvState | null };
  /** Set up again: the paired DashPal */
  again?: boolean;
}

export interface SetupFlow {
  phase(): SetupPhase;
  subscribe(fn: (p: SetupPhase) => void): () => void;
  start(opts?: SetupStart): Promise<void>;
  /** "Which DashPal is yours?": this one. */
  pick(id: string): void;
  /** Screen 1's Pair. */
  pair(): void;
  /** Screen 2's Next: commit the setup. */
  next(): void;
  /** Try again on a failure (what it does: the failure's `retry`). */
  retry(): Promise<void>;
  /** Stop setup: undoes a pairing already made, on both sides. While the commit is answered it waits for the answer: done stands, anything else is undone. */
  cancel(): Promise<void>;
}

/** Where the setup stands with the DashPal (what Cancel has to undo). */
type Stage = 'pre' | 'claim' | 'fin' | 'hold' | 'commit';

class Cancelled extends Error {
  constructor() {
    super('setup cancelled');
    this.name = 'Cancelled';
  }
}

/** A drive opened while setup ran: it stops. */
class DriveOpen extends Error {
  constructor() {
    super('a drive is open');
    this.name = 'DriveOpen';
  }
}

class Failed extends Error {
  constructor(
    readonly reason: SetupFailure,
    readonly retry: SetupRetry = 'restart'
  ) {
    super(`setup failed: ${reason}`);
    this.name = 'Failed';
  }
}

const sameId = (a: string, b: string): boolean => a.toLowerCase() === b.toLowerCase();
/** An Android peripheral id is the MAC (`A4:CF:…`). */
const macOfId = (id: string): string => id.replace(/[:-]/g, '').toLowerCase();

function hexBytes(hex: string): Uint8Array {
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  return out;
}

const defaultLocalMinute = (at: number): number => {
  const d = new Date(at);
  return d.getHours() * 60 + d.getMinutes();
};

export function createSetupFlow(deps: SetupDeps): SetupFlow {
  const random = deps.random ?? randomBytes;
  let phase: SetupPhase = { kind: 'idle' };
  const listeners = new Set<(p: SetupPhase) => void>();
  let running = false;
  let cancelled = false;
  let lastOpts: SetupStart = {};
  let stopScan: (() => Promise<void>) | null = null;
  /** the driver's pending choice (Pair, a pick, Next): resolved with it, or null when the wait ends */
  let waiter: { kind: 'pair' | 'pick' | 'next'; resolve: (v: string | null) => void } | null = null;
  /** the paired DashPal's auto-connect is stepped aside (given back when setup ends without pairing) */
  let stepped = false;
  /** Cancel came while the commit was answered (the screen left): a commit that does not go through is undone */
  let cancelAfter = false;

  // ——— the setup under way ———
  let t: DashcamTransport | null = null;
  let cand: Candidate | null = null;
  let shownName = 'DashPal';
  let stage: Stage = 'pre';
  let info: DashcamInfo | null = null;
  let pending: StoredAuth | null = null;
  /** a session is up on the setup connection (sealed writes work) */
  let sessionUp = false;
  let unsubscribe: (() => void) | null = null;
  let holdAt: number | null = null;
  let lastStateAt: number | null = null;
  let phones: number | null = null;
  let aimAllowed = true;
  let expired = false;
  let results: SetupResultFrame[] = [];
  let speed: SetupSpeed | null = null;

  function report(e: unknown, ctx: string): void {
    try {
      deps.onError?.(e, ctx);
    } catch {
      // nobody left to tell
    }
  }

  function set(next: SetupPhase): void {
    phase = next;
    for (const fn of [...listeners]) {
      try {
        fn(next);
      } catch (e) {
        report(e, 'listener');
      }
    }
  }

  /** A drive opened: setup stops (until COMMAND 8 is sent; its answer ends the setup by itself). */
  const driveOpened = (): boolean => stage !== 'commit' && deps.isBusy();

  const check = (): void => {
    if (cancelled) throw new Cancelled();
    if (driveOpened()) throw new DriveOpen();
  };

  function stepAside(): void {
    if (stepped || !deps.paired()) return;
    deps.stepAside();
    stepped = true;
  }

  async function giveBack(): Promise<void> {
    if (!stepped) return;
    stepped = false;
    await deps.resumePaired().catch((e: unknown) => report(e, 'resume'));
  }

  function wake(): void {
    const w = waiter;
    waiter = null;
    w?.resolve(null);
  }

  function waitFor(kind: 'pair' | 'pick' | 'next'): Promise<string | null> {
    return new Promise<string | null>((resolve) => {
      waiter = { kind, resolve };
    });
  }

  function answer(kind: 'pair' | 'pick' | 'next', v: string): void {
    if (waiter?.kind !== kind) return;
    const w = waiter;
    waiter = null;
    w.resolve(v);
  }

  const linkUp = (): boolean => t !== null && cand !== null && sessionUp && t.setupLinkUp(cand.id);

  async function release(): Promise<void> {
    unsubscribe?.();
    unsubscribe = null;
    sessionUp = false;
    lastStateAt = null;
    if (t && cand) await t.disconnect(cand.id).catch((e: unknown) => report(e, 'disconnect'));
  }

  function stopSpeed(): void {
    speed?.stop();
    speed = null;
  }

  async function deletePending(): Promise<void> {
    pending = null;
    await deps.secrets.deletePendingAuth().catch((e: unknown) => report(e, 'delete key'));
  }

  /** A key the dashcam may hold (a commit whose answer never came), kept only to prove prev_id at the next setup. */
  async function keepOrphan(p: StoredAuth): Promise<void> {
    await deps.secrets.writeOrphan({ dashcamId: p.dashcamId, phoneId: p.phoneId, kPair: p.kPair }).catch((e: unknown) => report(e, 'orphan'));
  }

  // ——— the setup's own state, frames and STATE ———

  function onFrame(bytes: number[]): void {
    const d = decodeTx(bytes);
    if (!d.ok) return;
    const f = d.frame;
    if (f.type === 'PAIRED') phones = f.bondCount;
    else if (f.type === 'SETUP_RESULT') {
      if (f.op === 9 && f.code === R.EXPIRED) expired = true;
      else results.push(f);
    } else if (f.type === 'VIEW_STATE') {
      if (f.reason === 1) aimAllowed = false;
      else if (f.on === 1) aimAllowed = true;
      if (phase.kind === 'instructions' && phase.aimAllowed !== aimAllowed) set({ ...phase, aimAllowed });
    }
  }

  async function command(op: number, arg = 0): Promise<boolean> {
    if (!t || !cand || !sessionUp) return false;
    try {
      await t.writeSealed(cand.id, encodeRx({ type: 'COMMAND', op, arg }));
      return true;
    } catch (e) {
      report(e, `COMMAND ${op}`);
      return false;
    }
  }

  function localMinute(now: number): number {
    try {
      const m = (deps.localMinute ?? defaultLocalMinute)(now);
      return Number.isInteger(m) && m >= 0 && m <= 1439 ? m : LOCAL_MIN_UNKNOWN;
    } catch {
      return LOCAL_MIN_UNKNOWN;
    }
  }

  /** The setup's STATE: never `can_play`; `drive_active` from the drive host; a speed only from a fresh sample. */
  function sendState(): void {
    if (!t || !cand || !sessionUp) return;
    const now = deps.now();
    const cms = speed?.speedCms() ?? null;
    const flags = (deps.isBusy() ? STATE_FLAG.DRIVE_ACTIVE : 0) | (cms !== null ? STATE_FLAG.SPEED_VALID : 0);
    lastStateAt = now;
    t.writeSealed(cand.id, encodeRx({ type: 'STATE', flags, ttlDs: STATE_TTL_DS, speedCms: cms ?? 0, localMin: localMinute(now), bootId: 0, ackSeq: 0 })).catch((e: unknown) =>
      report(e, 'STATE')
    );
  }

  /** One look while the hold lasts: the STATE when due, the countdown in the hold's last minute. */
  function pump(): void {
    if (sessionUp && (lastStateAt === null || deps.now() - lastStateAt >= SETUP_STATE_MS)) sendState();
    if (holdAt !== null && phase.kind === 'instructions') {
      const left = HOLD_MAX_MS - (deps.now() - holdAt);
      const s = left < HOLD_WARN_MS ? Math.max(0, Math.ceil(left / 1000)) : null;
      if (s !== phase.holdLeftS) set({ ...phase, holdLeftS: s });
    }
  }

  /** Poll (pumping) until `done` holds or `ms` has passed; false on the timeout. */
  async function pollUntil(done: () => boolean, ms: number): Promise<boolean> {
    const until = deps.now() + ms;
    for (;;) {
      check();
      pump();
      if (done()) return true;
      if (deps.now() >= until) return false;
      await deps.sleep(POLL_MS);
    }
  }

  /** The session on the setup connection is up: frames, hello and the STATE cadence. */
  async function sessionStarted(): Promise<void> {
    sessionUp = true;
    unsubscribe?.();
    unsubscribe = await t!.subscribeSealed(cand!.id, onFrame);
    await command(COMMAND.HELLO);
    sendState();
  }

  // ——— finding the DashPal ———

  async function search(tt: DashcamTransport): Promise<Candidate[]> {
    const found = new Map<string, Candidate>();
    let firstAt: number | null = null;
    const until = deps.now() + SEARCH_MS;
    set({ kind: 'search', until });
    const session = await tt.scan({
      services: [PAIRING_NEW, PAIRING_OPEN],
      seconds: SEARCH_MS / 1000,
      fast: true,
      onHit: (hit: ScanHit) => {
        if (hit.rssi < MIN_RSSI || (hit.adv !== 'new' && hit.adv !== 'open')) return;
        const prev = found.get(hit.id);
        if (!prev || hit.rssi > prev.rssi) found.set(hit.id, { id: hit.id, name: hit.name, rssi: hit.rssi, adv: hit.adv });
        firstAt ??= deps.now();
      },
    });
    stopScan = session.stop;
    try {
      while (!cancelled && !driveOpened()) {
        const at = deps.now();
        if (at >= until) break;
        if (firstAt !== null && at - firstAt >= SCAN_SETTLE_MS) break;
        await deps.sleep(POLL_MS);
      }
    } finally {
      stopScan = null;
      await session.stop();
    }
    check();
    return [...found.values()].sort((a, b) => b.rssi - a.rssi);
  }

  /** Pairing mode not open (Set up again): watch the DashPal advertise a pairing service, up to 60 s. */
  async function watchPairing(tt: DashcamTransport, id: string, name: string): Promise<boolean> {
    const until = deps.now() + PRESS_WAIT_MS;
    set({ kind: 'press_button', name, until });
    let open = false;
    const session = await tt.scan({
      services: [PAIRING_NEW, PAIRING_OPEN],
      seconds: PRESS_WAIT_MS / 1000,
      fast: true,
      onHit: (hit) => {
        if (sameId(hit.id, id) && (hit.adv === 'new' || hit.adv === 'open')) open = true;
      },
    });
    stopScan = session.stop;
    try {
      while (!cancelled && !driveOpened() && !open && deps.now() < until) await deps.sleep(POLL_MS);
    } finally {
      stopScan = null;
      await session.stop();
    }
    check();
    return open;
  }

  // ——— the pairing ———

  async function verdict(id: string, ms: number, onPending?: () => void): Promise<AuthRecord | 'fault' | 'timeout'> {
    const until = deps.now() + ms;
    for (;;) {
      check();
      const rec = await t!.authRead(id);
      if (rec === 'fault' || rec.kind !== 'pending') return rec;
      onPending?.();
      if (deps.now() >= until) return 'timeout';
      await deps.sleep(PAIR_POLL_MS);
    }
  }

  /**
   * This phone's earlier key with this DashPal, the one the dashcam still holds: `prev_id` with its
   * proof. Its pairing's key, else the orphan; the orphan first when the dashcam refused the
   * pairing's key.
   */
  async function previousKey(d: string): Promise<{ id: Uint8Array; kPair: Uint8Array } | null> {
    const own = await deps.secrets.readAuth().catch(() => null);
    const orphan = await deps.secrets.readOrphan().catch(() => null);
    const ownHere = own?.dashcamId === d ? own : null;
    const orphanHere = orphan?.dashcamId === d ? orphan : null;
    let refused = false;
    try {
      refused = deps.keyRefused(d);
    } catch (e) {
      report(e, 'keyRefused');
    }
    const pick = orphanHere && (!ownHere || refused) ? orphanHere : ownHere;
    return pick ? { id: hexBytes(pick.phoneId), kPair: hexBytes(pick.kPair) } : null;
  }

  function freshId(): Uint8Array {
    for (;;) {
      const id = random(8);
      if (id.length === 8 && id.some((b) => b !== 0)) return id;
    }
  }

  /** The dashcam id this candidate must have, when the phone knows it before INFO. */
  function expectedId(c: Candidate, mode: 'new' | 'open' | 'again'): string | null {
    if (mode === 'again') return deps.paired()?.dashcamId ?? null;
    return deps.platform === 'android' ? macOfId(c.id) : null;
  }

  /**
   * After the Pair tap: connect, check INFO, PAIR_OPEN … PAIR_FIN, the first session, hello,
   * PAIRED and the aiming query; on return the setup hold stands and the session is up.
   */
  async function connectAndPair(mode: 'new' | 'open' | 'again'): Promise<void> {
    const tt = t!;
    const c = cand!;
    const spinnerFrom = deps.now();
    set({ kind: 'connecting', name: shownName, reconnecting: false });
    let reconnects = 0;
    let idP = freshId();
    let idRetried = false;
    let mtuRetried = false;
    let notNowRetries = 0;
    let pressAsked = false;
    /** when the request that took the claim was sent: the claim lasts 15 s from it */
    let claimedAt: number | null = null;
    const holdsClaim = (): boolean => claimedAt !== null && deps.now() - claimedAt < CLAIM_MS;
    const linkFailed = async (): Promise<void> => {
      claimedAt = null;
      stage = 'pre';
      await release();
      if (reconnects++ >= 1) throw new Failed('not_found');
    };
    const want = expectedId(c, mode);

    for (;;) {
      check();
      let hasAuth: boolean;
      let got: DashcamInfo | null;
      try {
        if (!tt.setupLinkUp(c.id)) {
          const r = await tt.setupConnect(c.id, { timeoutMs: SETUP_CONNECT_TIMEOUT_MS });
          hasAuth = r.auth;
        } else hasAuth = true;
        got = await tt.readInfo(c.id);
      } catch (e) {
        report(e, 'connect');
        check();
        if (deps.platform === 'ios' && isIosBondLoss(e)) throw new Failed('ios_forget_first', 'none');
        await linkFailed();
        continue;
      }
      check();
      if (!got) {
        await linkFailed();
        continue;
      }
      if (want !== null && got.dashcamId !== want) {
        await release();
        throw new Failed('not_found');
      }
      const mismatch = linkMismatch(got);
      if (mismatch) {
        await release();
        throw new Failed(mismatch === 'firmware' ? 'update_firmware' : 'update_app', 'none');
      }
      if (!hasAuth) {
        await release();
        throw new Failed(deps.platform === 'ios' ? 'ios_forget_first' : 'error', deps.platform === 'ios' ? 'none' : 'restart');
      }
      if (!got.nonce) throw new Failed('error');
      info = got;
      shownName = got.name;
      if (!got.pairingOpen && !holdsClaim()) {
        if (mode !== 'again' || pressAsked) {
          await release();
          throw new Failed('window_closed');
        }
        pressAsked = true;
        await release();
        if (!(await watchPairing(tt, c.id, got.name))) throw new Failed('window_closed');
        set({ kind: 'connecting', name: shownName, reconnecting: false });
        continue;
      }
      if (got.setupBusy && !holdsClaim()) {
        const until = deps.now() + BUSY_WAIT_MS;
        set({ kind: 'waiting_busy', name: got.name, until });
        let busy: DashcamInfo | null = got;
        while (busy?.setupBusy && deps.now() < until) {
          await deps.sleep(BUSY_POLL_MS);
          check();
          busy = await tt.readInfo(c.id).catch(() => null);
        }
        if (!busy) {
          await linkFailed();
          continue;
        }
        if (busy.setupBusy) {
          await release();
          throw new Failed('setup_busy');
        }
        set({ kind: 'connecting', name: shownName, reconnecting: false });
        continue; // INFO again (the window may have closed when the other phone finished)
      }

      // ——— PAIR_OPEN ———
      const prev = await previousKey(got.dashcamId);
      const a = random(32);
      const np = random(16);
      let open;
      try {
        open = pairOpen({ mac: got.mac, nc: got.nonce, idP, a, A: x25519Public(a), np, prev });
      } catch (e) {
        report(e, 'pair open');
        throw new Failed('error');
      }
      const sentAt = deps.now();
      const claimed = (): void => {
        claimedAt ??= sentAt;
      };
      stage = 'claim';
      if ((await tt.authWrite(c.id, open.bytes)) === 'fault') {
        await linkFailed();
        continue;
      }
      const resp = await verdict(c.id, PAIR_RESP_MS, claimed);
      if (resp === 'fault' || !tt.setupLinkUp(c.id)) {
        await linkFailed();
        continue;
      }
      if (resp === 'timeout') throw new Failed('error');
      if (resp.kind === 'result') {
        switch (resp.code) {
          case R.BUSY:
            continue; // INFO shows it: the busy wait
          case R.ID_IN_USE:
            if (idRetried) throw new Failed('error');
            idRetried = true;
            idP = freshId();
            continue; // the same Nc: this check does not redraw it
          case R.MTU:
            if (mtuRetried) throw new Failed('mtu');
            mtuRetried = true;
            if (deps.platform === 'android') await tt.requestMtu(c.id);
            else await deps.sleep(IOS_MTU_WAIT_MS);
            continue;
          case R.NOT_NOW: {
            // The dashcam could not compute its answer, or the window closed: INFO decides.
            const now = await tt.readInfo(c.id).catch(() => null);
            if (now && !now.setupBusy && (now.pairingOpen || holdsClaim()) && notNowRetries < NOT_NOW_RETRIES) {
              notNowRetries += 1;
              await deps.sleep(NOT_NOW_RETRY_MS);
              continue;
            }
            if (now && !now.pairingOpen && !holdsClaim()) continue; // closed: Set up again asks for the button
            throw new Failed('error');
          }
          default:
            throw new Failed('error');
        }
      }
      if (resp.kind !== 'pair_resp') throw new Failed('error');
      claimed();
      const keys = pairKeysV3({ mac: got.mac, nc: got.nonce, open: open.bytes, a, B: resp.B, Nd: resp.Nd });
      wipe(a);
      if (!keys || !proofOk(keys.proofD, resp.proofD)) {
        // Something answered that cannot confirm the key: send it nothing more.
        await release();
        throw new Failed('unverified', 'restart');
      }

      // ——— the key, then PAIR_FIN ———
      const key: StoredAuth = { dashcamId: got.dashcamId, phoneId: toHex(idP), kPair: toHex(keys.K_pair) };
      wipe(keys.K_pair);
      wipe(keys.k_conf);
      try {
        await deps.secrets.writePendingAuth(key);
      } catch (e) {
        // No key stored: PAIR_FIN is not sent (the claim ends by itself).
        report(e, 'store key');
        await release();
        throw new Failed('error');
      }
      pending = key;
      check();
      stage = 'fin';
      const finWrite = await tt.authWrite(c.id, pairFin(keys.proofP));
      const fin = finWrite === 'fault' ? 'fault' : await verdict(c.id, RESULT_MS);
      if (fin !== 'fault' && fin !== 'timeout' && fin.kind === 'result' && fin.code === R.OK) {
        stage = 'hold';
        holdAt = deps.now();
        // INFO again: the PAIR_OPEN redrew this connection's Nc.
        const again = await tt.readInfo(c.id).catch(() => null);
        const s = again?.nonce && again.dashcamId === got.dashcamId ? await tt.startSession(c.id, again, { phoneId: key.phoneId, kPair: key.kPair }) : null;
        if (s?.kind === 'up') await sessionStarted();
        else {
          report(new Error(`first session: ${s?.kind ?? 'no INFO'}`), 'session');
          await release();
          await reconnectHold();
        }
      } else if (fin !== 'fault' && fin !== 'timeout' && fin.kind === 'result' && tt.setupLinkUp(c.id)) {
        // R_WRONG_PROOF or R_NOT_NOW: nothing is held.
        stage = 'pre';
        await deletePending();
        await release();
        throw new Failed('error');
      } else {
        // The link dropped before the RESULT was read: maybe held. Reconnect under the new key.
        stage = 'hold';
        holdAt = deps.now();
        await release();
        await reconnectHold();
      }
      break;
    }

    // ——— the hold stands: PAIRED, the aiming query, the check mark ———
    if (await command(COMMAND.PAIR_CONFIRM)) await pollUntil(() => phones !== null, PAIRED_WAIT_MS);
    await command(COMMAND.AIM, AIM_ARG.QUERY);
    await pollUntil(() => deps.now() - spinnerFrom >= MIN_SPINNER_MS, MIN_SPINNER_MS);
    set({ kind: 'connected', name: shownName });
    await pollUntil(() => false, CHECK_HOLD_MS);
  }

  /**
   * The hold's connection was lost: reconnect and run a session under the new key, up to 45 s.
   * R_UNKNOWN_PHONE: the hold was undone (failed `lost`, the key deleted). No session in time:
   * failed `lost`, the key deleted, or kept (`keepKey`: a commit went unanswered) for Try again.
   */
  async function reconnectHold(o: { keepKey?: boolean } = {}): Promise<void> {
    const tt = t!;
    const c = cand!;
    const key = pending;
    if (!key) throw new Failed('lost');
    if (phase.kind === 'instructions' || phase.kind === 'connecting') set({ ...phase, reconnecting: true });
    const until = deps.now() + HOLD_RECONNECT_MS;
    while (deps.now() < until) {
      check();
      try {
        if (!tt.setupLinkUp(c.id)) await tt.setupConnect(c.id, { timeoutMs: Math.max(1000, Math.min(SETUP_CONNECT_TIMEOUT_MS, until - deps.now())) });
        const got = await tt.readInfo(c.id);
        if (got?.nonce && got.dashcamId === key.dashcamId) {
          const s = await tt.startSession(c.id, got, { phoneId: key.phoneId, kPair: key.kPair });
          if (s.kind === 'up') {
            await sessionStarted();
            if (phase.kind === 'instructions' || phase.kind === 'connecting') set({ ...phase, reconnecting: false });
            return;
          }
          if (s.kind === 'unknown_phone') {
            // The hold was undone (or never made): nothing is kept.
            stage = 'pre';
            await release();
            await deletePending();
            throw new Failed('lost');
          }
        }
      } catch (e) {
        if (e instanceof Failed || e instanceof Cancelled || e instanceof DriveOpen) throw e;
        report(e, 'reconnect');
      }
      await release();
      check();
      await deps.sleep(500);
    }
    if (o.keepKey) throw new Failed('lost', 'resume');
    stage = 'pre';
    await deletePending();
    throw new Failed('lost');
  }

  /** Screen 2 until Next: the STATE cadence, the countdown, a lost link, the hold running out. */
  async function waitNext(): Promise<void> {
    set({ kind: 'instructions', aimAllowed, holdLeftS: null, reconnecting: false });
    let tapped = false;
    void waitFor('next').then((v) => {
      if (v !== null) tapped = true;
    });
    for (;;) {
      check();
      if (expired) await expire();
      if (tapped) return;
      if (!linkUp()) {
        await release();
        await reconnectHold();
        continue;
      }
      pump();
      await deps.sleep(POLL_MS);
    }
  }

  /** The DashPal ran out the hold's 10 minutes and undid it: nothing is kept. */
  async function expire(): Promise<never> {
    stage = 'pre';
    await release();
    await deletePending();
    throw new Failed('expired');
  }

  /** Next: COMMAND 8 and its SETUP_RESULT; the pairing kept only on R_OK. */
  async function commit(): Promise<SetupPhase> {
    set({ kind: 'finishing' });
    for (let attempt = 0; ; attempt++) {
      check();
      if (expired) await expire();
      if (!linkUp()) {
        // The link is down: reconnect under the new key (after COMMAND 8 was sent, its outcome is unknown).
        set({ kind: 'connecting', name: shownName, reconnecting: true });
        await release();
        await reconnectHold({ keepKey: stage === 'commit' });
        set({ kind: 'finishing' });
      }
      results = [];
      const sent = await command(COMMAND.SETUP_DONE);
      if (sent) stage = 'commit';
      const answered = sent ? await pollUntil(() => results.some((r) => r.op === 8) || expired || !linkUp(), SETUP_RESULT_MS) : false;
      const r = results.find((x) => x.op === 8);
      if (r?.code === R.OK) return finalize(r.bondCount);
      if (r?.code === R.STORE_FAILED) {
        stage = 'hold';
        throw new Failed('save_failed', 'commit');
      }
      if (expired) await expire();
      if (!linkUp()) continue;
      if (attempt === 0 && (!answered || !r || r.code === R.NOT_NOW)) {
        await deps.sleep(500);
        continue;
      }
      // Answered R_NOT_NOW (or nothing) twice with the link up: undo it and start over.
      stage = 'hold';
      throw new Failed('error');
    }
  }

  async function finalize(count: number): Promise<SetupPhase> {
    const key = pending!;
    const d = info?.dashcamId ?? key.dashcamId;
    const record: PairedDashcam = { dashcamId: d, peripheralId: cand!.id, name: info?.name ?? nameOf(d), pairedAt: deps.now(), secure: true };
    stopSpeed();
    await release();
    let final: StoredAuth | null;
    try {
      final = await deps.secrets.finalizeAuth();
    } catch (e) {
      // The dashcam stored this pairing but the key could not be made final: kept as the orphan,
      // which proves prev_id at the next setup (that record is then replaced, not added to).
      report(e, 'finalize key');
      await keepOrphan(key);
      await deletePending();
      stage = 'pre';
      throw new Failed('error');
    }
    stage = 'pre';
    pending = null;
    if (!final) throw new Failed('error');
    await deps.pair(record);
    stepped = false;
    await deps.secrets.deleteOrphan().catch((e: unknown) => report(e, 'delete orphan'));
    try {
      deps.notePhones?.(record.dashcamId, count);
    } catch (e) {
      report(e, 'notePhones');
    }
    return { kind: 'done', paired: record, phones: count, notAllYours: count >= 2, aimedElsewhere: !aimAllowed };
  }

  /**
   * Whatever the DashPal holds for this setup is undone (COMMAND 9 on a live hold), the connection
   * released and the key gone; after a commit that went unanswered the key is kept as the orphan.
   */
  async function undo(): Promise<void> {
    stopSpeed();
    if (stage === 'hold' && linkUp()) {
      results = [];
      if (await command(COMMAND.SETUP_CANCEL)) {
        const until = deps.now() + CANCEL_WAIT_MS;
        while (!results.some((r) => r.op === 9) && deps.now() < until && linkUp()) await deps.sleep(POLL_MS);
      }
    }
    await release();
    const key = pending;
    if (stage === 'commit' && key) await keepOrphan(key);
    if (stage !== 'pre' || key) await deletePending();
    stage = 'pre';
    holdAt = null;
  }

  function resetSetup(): void {
    cand = null;
    info = null;
    pending = null;
    stage = 'pre';
    sessionUp = false;
    holdAt = null;
    lastStateAt = null;
    phones = null;
    aimAllowed = true;
    expired = false;
    results = [];
    shownName = 'DashPal';
  }

  /** Run one segment of the setup to its end (a phase that waits for nothing, or a failure). */
  async function runSegment(body: () => Promise<SetupPhase>): Promise<void> {
    if (running) return;
    running = true;
    cancelled = false;
    cancelAfter = false;
    let result: SetupPhase;
    const offDrive = deps.onDriveChange(() => {
      if (!driveOpened()) return;
      wake();
      const stop = stopScan;
      stopScan = null;
      void stop?.().catch((e: unknown) => report(e, 'stopScan'));
    });
    try {
      try {
        result = await body();
      } catch (e) {
        if (e instanceof DriveOpen) {
          await undo();
          result = { kind: 'busy' };
        } else if (e instanceof Cancelled) {
          await undo();
          result = { kind: 'cancelled' };
        } else if (e instanceof Failed) {
          // A failure that Try again resumes keeps the hold (and the key); any other undoes it.
          if (e.retry !== 'commit' && e.retry !== 'resume') await undo();
          result = { kind: 'failed', reason: e.reason, name: shownName === 'DashPal' ? null : shownName, retry: e.retry };
        } else {
          report(e, 'setup');
          await undo();
          result = { kind: 'failed', reason: 'error', name: null, retry: 'restart' };
        }
      }
      if (cancelAfter && result.kind === 'failed' && (result.retry === 'commit' || result.retry === 'resume')) {
        // Cancelled while the commit was answered (the driver left the screen): nobody is left to
        // tap Try again, so a commit that did not go through is undone like any other cancel.
        set({ kind: 'stopping' });
        await undo();
        result = { kind: 'cancelled' };
      }
    } finally {
      cancelAfter = false;
      offDrive();
      running = false;
    }
    if (result.kind !== 'done' && !(result.kind === 'failed' && (result.retry === 'commit' || result.retry === 'resume'))) {
      stopSpeed();
      await giveBack();
    }
    set(result);
  }

  async function fresh(opts: SetupStart): Promise<SetupPhase> {
    resetSetup();
    if (deps.isBusy()) throw new DriveOpen();
    set({ kind: 'permission' });
    await deps.optIn().catch((e: unknown) => report(e, 'optIn'));
    const access = await deps.requestBluetooth().catch((e: unknown) => {
      report(e, 'requestBluetooth');
      return 'undetermined' as const;
    });
    check();
    if (access === 'denied' || access === 'undetermined') return { kind: 'denied' };
    if (access === 'off') return { kind: 'off' };
    if (access === 'unavailable') return { kind: 'unavailable' };
    t = deps.transport();
    if (!t) return { kind: 'unavailable' };
    await t.start().catch((e: unknown) => report(e, 'start'));
    check();

    // ——— which DashPal ———
    const paired = deps.paired();
    let c: Candidate;
    if (opts.again) {
      if (!paired) throw new Failed('not_found');
      c = { id: paired.peripheralId, name: paired.name, rssi: 0, adv: null };
    } else if (opts.target) {
      c = { id: opts.target.peripheralId, name: opts.target.name, rssi: 0, adv: opts.target.adv };
    } else {
      const hits = await search(t);
      if (hits.length === 0) throw new Failed('none_nearby');
      if (hits.length === 1) c = hits[0]!;
      else {
        set({ kind: 'choose', candidates: hits });
        const id = await waitFor('pick');
        check();
        const chosen = id === null ? undefined : hits.find((h) => sameId(h.id, id));
        if (!chosen) throw new Cancelled();
        c = chosen;
      }
    }
    cand = c;
    const isPaired = paired !== null && (sameId(c.id, paired.peripheralId) || (deps.platform === 'android' && macOfId(c.id) === paired.dashcamId));
    const mode: 'new' | 'open' | 'again' = opts.again || isPaired ? 'again' : c.adv === 'open' ? 'open' : 'new';
    shownName = mode === 'again' && paired ? paired.name : (c.name ?? (deps.platform === 'android' ? nameOf(macOfId(c.id)) : 'DashPal'));

    // ——— screen 1: the DashPal and Pair; nothing is sent before the tap ———
    set({ kind: 'confirm', name: shownName, mode, replaces: paired && !isPaired ? paired.name : null });
    const tap = await waitFor('pair');
    check();
    if (tap === null) throw new Cancelled();
    stepAside();
    speed = (deps.speed ?? (() => createSetupSpeed()))();
    void speed.start().catch((e: unknown) => report(e, 'speed'));
    await connectAndPair(mode);
    await waitNext();
    return commit();
  }

  const flow: SetupFlow = {
    phase: () => phase,
    subscribe(fn) {
      listeners.add(fn);
      return () => {
        listeners.delete(fn);
      };
    },

    async start(opts = {}) {
      if (running) return;
      lastOpts = opts;
      stepped = false;
      await runSegment(() => fresh(opts));
    },

    pick: (id) => answer('pick', id),
    pair: () => answer('pair', 'pair'),
    next: () => answer('next', 'next'),

    async retry() {
      if (running || phase.kind !== 'failed') return;
      const kind = phase.retry;
      if (kind === 'none') return;
      if (kind === 'restart') {
        await flow.start(lastOpts);
        return;
      }
      // The hold may still stand: send the commit again (after a reconnect for an unanswered one).
      await runSegment(async () => {
        if (kind === 'resume') {
          stage = 'commit';
          set({ kind: 'connecting', name: shownName, reconnecting: true });
          await release();
          await reconnectHold({ keepKey: true });
        }
        return commit();
      });
    },

    async cancel() {
      if (running && phase.kind === 'finishing') {
        // The commit's answer decides (≤ 2 s): done stands; anything else is then undone.
        cancelAfter = true;
        return;
      }
      if (running) {
        cancelled = true;
        if (stage !== 'pre') set({ kind: 'stopping' });
        wake();
        const stop = stopScan;
        stopScan = null;
        await stop?.().catch((e: unknown) => report(e, 'stopScan'));
        if (stage === 'pre' || stage === 'claim') await release();
        return;
      }
      if (phase.kind === 'done' || phase.kind === 'cancelled') return;
      // Not running (a failure that kept the hold, or nothing under way): undo and close.
      if (stage !== 'pre' || pending) set({ kind: 'stopping' });
      await undo();
      stopSpeed();
      await giveBack();
      set({ kind: 'cancelled' });
    },
  };
  return flow;
}

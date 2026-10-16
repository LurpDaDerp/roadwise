// Setting up a DashPal (pairing v2 §9, §14.4): only on the driver's explicit action, never while a
// drive is open. The driver scans the code under the DashPal's mount (or on its box card) in
// RoadWise, opens its label link with the phone's own camera (then taps Pair), or types the code.
// The phone finds that DashPal, proves the code (a PAIR_REQ tag bound to the dashcam's fresh Nc),
// agrees a key with it by X25519, checks the dashcam's own proof, stores the key, and proves the key
// in a first session on the same connection; the DashPal plays its paired chime and reports how many
// phones it has. No system pairing dialog, no beep question, no typing on the scan path.
//
// With Bluetooth already allowed and the DashPal in pairing mode, the steps from the scan (or the
// Pair tap) to "Connected" are each bounded so the whole usually takes a few seconds and is built to
// finish within 10 s: the search stops at the first advert of the named DashPal (Android scans in
// low-latency mode), the phone's key pair is drawn while it searches, and a link opened from outside
// finds, connects and reads INFO while its Pair button shows (the tap then only sends the request).
// Typing the code, or a DashPal not yet in pairing mode, takes longer.
//
// Every result of the dashcam travels in the AUTH read value; a non-zero write status, a GATT error
// or a disconnect before a verdict is read is a link failure (one reconnect, then the next candidate
// or "That didn't work"), never "wrong code". Setting up a different DashPal than the paired one asks
// first (`confirm_replace`), and a failed or cancelled setup leaves the previous pairing in place.
// UI-free: the screen renders `phase` and calls the actions.
import type { BluetoothAccess } from '@/core/permissions/adapters';

import { pairFin, pairKeys, pairRequest, proofOk, R, type AuthRecord } from './auth';
import { randomBytes, wipe, x25519Public } from './crypto';
import type { PairedDashcam } from './keys';
import { formatCode, nameOf, parseCode, parseDashpalLink, type PairingCode } from './label';
import { COMMAND, DASHPAL_SERVICE, decodeTx, encodeRx, PAIRING_SERVICE, speaksLink, toHex, type DashcamInfo } from './protocol';
import type { DashpalSecrets, StoredAuth } from './secure';
import { isIosBondLoss, type DashcamTransport, type ScanHit } from './transport';

/** The search for the named DashPal (or, typed with no name, for any in pairing mode). */
export const SEARCH_MS = 15_000;
/** Typed with no name: stop listening this long after the first DashPal heard. */
export const SCAN_SETTLE_MS = 4000;
export const MIN_RSSI = -80;
/** Watching for pairing mode to open after "Press the DashPal's button 5 times". */
export const PRESS_WAIT_MS = 60_000;
/** Another phone setting the DashPal up: INFO again every second, for this long. */
export const BUSY_POLL_MS = 1000;
export const BUSY_WAIT_MS = 16_000;
/** AUTH read polls while a pairing answer is computed. */
export const PAIR_POLL_MS = 100;
export const PAIR_RESP_MS = 3000;
/** A RESULT after a FIN. */
export const RESULT_MS = 1000;
/** The phone's own wait before a new PAIR_REQ after R_NOT_NOW, and the most of them per connection. */
export const NOT_NOW_RETRY_MS = 300;
export const NOT_NOW_RETRIES = 2;
/** A claim lasts 15 s from its first request at the dashcam. */
export const CLAIM_MS = 15_000;
/** The link dropped after PAIR_FIN, before its RESULT: one reconnect within this long. */
export const FIN_RECONNECT_MS = 15_000;
/** Waiting for PAIRED after COMMAND 5. */
export const PAIRED_WAIT_MS = 3000;
/** iOS: an R_MTU waits this long before the request is sent again. */
export const IOS_MTU_WAIT_MS = 300;
/** How often the search loops look at what they heard (no wait on the path is longer than 100 ms). */
export const POLL_MS = 50;

export interface Candidate {
  id: string;
  name: string | null;
  rssi: number;
}

export type SetupFailure =
  | 'not_found'
  | 'window_timeout'
  | 'setup_busy'
  | 'wrong_code'
  | 'no_match'
  | 'unverified'
  | 'unverified_nearby'
  | 'no_key'
  | 'update_firmware'
  | 'mtu'
  | 'ios_forget_first'
  | 'error';

export type SetupPhase =
  | { kind: 'idle' }
  | { kind: 'busy' }
  | { kind: 'permission' }
  | { kind: 'denied' }
  | { kind: 'off' }
  | { kind: 'unavailable' }
  /**
   * The code step: the camera (or typing). `error`: the last scan or typed text was refused;
   * `noStoredCode`: Set up again on a phone that has no label code; `preferred`: the DashPal a link
   * named.
   */
  | { kind: 'code'; error: 'not_a_code' | 'bad_code' | null; noStoredCode: boolean; preferred: string | null }
  /** A link opened from outside: "Set up DashPal-XXXX" with Pair (the connection warms up meanwhile). */
  | { kind: 'confirm_link'; name: string }
  /** Setting up a different DashPal than the paired one: Replace or Cancel. */
  | { kind: 'confirm_replace'; from: string; to: string }
  | { kind: 'searching'; name: string | null; again: boolean }
  | { kind: 'press_button'; name: string; until: number }
  | { kind: 'waiting_busy'; name: string; until: number }
  | { kind: 'connecting'; name: string; again: boolean }
  | { kind: 'pairing'; name: string; again: boolean }
  | { kind: 'finishing'; name: string; again: boolean }
  /** `phones`: PAIRED's phone count (null when it did not come); `notAllYours`: 2 or more phones. */
  | { kind: 'done'; paired: PairedDashcam; phones: number | null; notAllYours: boolean }
  | { kind: 'failed'; reason: SetupFailure; name: string | null }
  | { kind: 'cancelled' };

export interface SetupDeps {
  platform: 'ios' | 'android';
  transport: () => DashcamTransport | null;
  /** The permissions adapter's DashPal request (the driver tapped). */
  requestBluetooth(): Promise<BluetoothAccess>;
  /** The drive host is busy (a drive open or closing). */
  isBusy(): boolean;
  /**
   * The drive host's state changed (a drive may have opened): a wait for the driver reads `isBusy`
   * again and the setup stops. Returns the unsubscribe.
   */
  onDriveChange(fn: () => void): () => void;
  /** Record the opt-in (settings + the launch flag). */
  optIn(): Promise<void>;
  /** Save the pairing (its key is final in SecureStore) and hand it to the auto-connect. */
  pair(record: PairedDashcam): Promise<void>;
  /** The currently paired dashcam (re-pairing replaces it). */
  paired(): PairedDashcam | null;
  /** The paired dashcam's auto-connect steps aside while the pairing step uses the radio. */
  stepAside(): void;
  /** The paired dashcam's auto-connect again (a setup that did not pair, or a wait for the driver). */
  resumePaired(): Promise<void>;
  secrets: DashpalSecrets;
  /** This phone's own setup saw this phone count (the new-phone notice does not count it). */
  notePhones?(dashcamId: string, phones: number): void;
  now(): number;
  sleep(ms: number): Promise<void>;
  random?(n: number): Uint8Array;
  onError?(e: unknown, ctx: string): void;
}

export interface SetupStart {
  /** a peripheral the nearby prompt found (tried first among the unnamed) */
  preferId?: string;
  /** a link opened from outside (named this DashPal): its code is read from `dashpal.pendingCode` */
  fromLink?: { dashcamId: string | null };
  /** Set up again: the stored label code of this phone's pairing, else the code step */
  again?: boolean;
}

export interface SetupFlow {
  phase(): SetupPhase;
  subscribe(fn: (p: SetupPhase) => void): () => void;
  start(opts?: SetupStart): Promise<void>;
  /** The in-app scanner read a QR code. */
  scanned(text: string): void;
  /** The typed code and the optional name on the label (its 4 characters after `DashPal-`). */
  submitCode(text: string, name?: string): void;
  /** Pair on "Set up DashPal-XXXX" (a link). */
  confirm(): void;
  /** Replace on "Replace DashPal-AAAA with DashPal-BBBB?". */
  confirmReplace(): void;
  cancel(): Promise<void>;
}

/** What the pairing step is aimed at. */
interface Aim {
  code: PairingCode;
  /** the dashcam id, when the code came with one (a link, a scan) */
  d: string | null;
  /** typed: the 4 characters of the name on the label */
  suffix: string | null;
  again: boolean;
}

type Attempt =
  | { kind: 'done'; paired: PairedDashcam; phones: number | null }
  | { kind: 'next'; why: 'wrong_code' | 'proof' | 'link' }
  | { kind: 'failed'; reason: SetupFailure };

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

const sameId = (a: string, b: string): boolean => a.toLowerCase() === b.toLowerCase();
/** An Android peripheral id is the MAC (`A4:CF:…`). */
const macOfId = (id: string): string => id.replace(/[:-]/g, '').toLowerCase();

function hexBytes(hex: string): Uint8Array {
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  return out;
}

export function createSetupFlow(deps: SetupDeps): SetupFlow {
  const random = deps.random ?? randomBytes;
  let phase: SetupPhase = { kind: 'idle' };
  const listeners = new Set<(p: SetupPhase) => void>();
  let cancelled = false;
  let running = false;
  /** the setup connection in use */
  let current: string | null = null;
  let stopScan: (() => Promise<void>) | null = null;
  /** a pending choice: the code (scan or typed), Pair, Replace */
  let codeWaiter: ((aim: Aim | null) => void) | null = null;
  let confirmWaiter: ((yes: boolean) => void) | null = null;
  let replaceWaiter: ((yes: boolean) => void) | null = null;
  let preferred: string | null = null;
  let noStoredCode = false;
  let preferId: string | undefined;
  /** the phone's next X25519 key pair, drawn ahead (one per request) */
  let ready: { a: Uint8Array; A: Uint8Array } | null = null;
  /** the paired DashPal's auto-connect is stepped aside (given back when setup ends without pairing) */
  let stepped = false;
  /** PAIR_FIN was sent: the dashcam may have stored the pairing, so a drive opening no longer stops it */
  let finSent = false;

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

  /** A drive opened: setup stops (until PAIR_FIN; the few seconds after it end by themselves). */
  const driveOpened = (): boolean => !finSent && deps.isBusy();
  const stopNow = (): boolean => cancelled || driveOpened();

  const check = (): void => {
    if (cancelled) throw new Cancelled();
    if (driveOpened()) throw new DriveOpen();
  };

  /** The paired DashPal's auto-connect steps aside for the radio work (none paired: nothing to do). */
  function stepAside(): void {
    if (stepped || !deps.paired()) return;
    deps.stepAside();
    stepped = true;
  }

  /** The paired DashPal's auto-connect comes back. */
  async function giveBack(): Promise<void> {
    if (!stepped) return;
    stepped = false;
    await deps.resumePaired().catch((e: unknown) => report(e, 'resume'));
  }

  /** Every wait for the driver ends (Cancel, or a drive opened): the caller's check() says which. */
  function wakeWaiters(): void {
    const cw = codeWaiter;
    codeWaiter = null;
    cw?.(null);
    const fw = confirmWaiter;
    confirmWaiter = null;
    fw?.(false);
    const rw = replaceWaiter;
    replaceWaiter = null;
    rw?.(false);
  }

  /** Per setup connection (lowercase peripheral id): it found the AUTH characteristic. */
  const authChar = new Map<string, boolean>();

  async function release(t: DashcamTransport, id: string | null): Promise<void> {
    if (id === null) return;
    await t.disconnect(id).catch((e: unknown) => report(e, 'disconnect'));
    authChar.delete(id.toLowerCase());
    if (current === id) current = null;
  }

  /** A setup connection; resolves whether it found the AUTH characteristic (kept for a warmed link). */
  async function connectSetup(t: DashcamTransport, id: string, opts?: { timeoutMs?: number }): Promise<boolean> {
    current = id;
    const { auth } = await t.setupConnect(id, opts);
    authChar.set(id.toLowerCase(), auth);
    return auth;
  }

  function drawKeys(): void {
    if (ready) return;
    try {
      const a = random(32);
      ready = { a, A: x25519Public(a) };
    } catch (e) {
      report(e, 'key pair');
    }
  }

  function takeKeys(): { a: Uint8Array; A: Uint8Array } {
    const k = ready;
    ready = null;
    if (k) return k;
    const a = random(32);
    return { a, A: x25519Public(a) };
  }

  // ——— waiting for the driver ———

  function waitCode(): Promise<Aim | null> {
    return new Promise<Aim | null>((resolve) => {
      codeWaiter = resolve;
    });
  }

  function waitYes(kind: 'confirm' | 'replace'): Promise<boolean> {
    return new Promise<boolean>((resolve) => {
      if (kind === 'confirm') confirmWaiter = resolve;
      else replaceWaiter = resolve;
    });
  }

  function codePhase(error: 'not_a_code' | 'bad_code' | null): void {
    set({ kind: 'code', error, noStoredCode, preferred });
  }

  // ——— finding the DashPal ———

  /** Does this advert name the DashPal we look for? */
  function matches(hit: ScanHit, aim: { d: string | null; suffix: string | null }): boolean {
    if (aim.d) return deps.platform === 'android' ? macOfId(hit.id) === aim.d : hit.name === nameOf(aim.d);
    if (aim.suffix) return deps.platform === 'android' ? macOfId(hit.id).endsWith(aim.suffix.toLowerCase()) : hit.name === `DashPal-${aim.suffix.toUpperCase()}`;
    return false;
  }

  /**
   * Named (a dashcam id or a label name): the first advert of it, in or out of pairing mode, within
   * `SEARCH_MS`. Unnamed (typed): DashPals in pairing mode at −80 dBm or stronger, strongest first,
   * listening until 4 s after the first one. The key pair is drawn meanwhile.
   */
  async function search(t: DashcamTransport, aim: { d: string | null; suffix: string | null }, skip: Set<string>): Promise<ScanHit[]> {
    const named = aim.d !== null || aim.suffix !== null;
    const found = new Map<string, ScanHit>();
    let first: ScanHit | null = null;
    let firstAt: number | null = null;
    const session = await t.scan({
      services: named ? [DASHPAL_SERVICE, PAIRING_SERVICE] : [PAIRING_SERVICE],
      seconds: SEARCH_MS / 1000,
      fast: true,
      onHit: (hit) => {
        if (skip.has(hit.id.toLowerCase())) return;
        if (named) {
          if (first === null && matches(hit, aim)) first = hit;
          return;
        }
        if (hit.rssi < MIN_RSSI || !hit.pairing) return;
        const prev = found.get(hit.id);
        if (!prev || hit.rssi > prev.rssi) found.set(hit.id, hit);
        firstAt ??= deps.now();
      },
    });
    stopScan = session.stop;
    drawKeys();
    const started = deps.now();
    try {
      while (!stopNow()) {
        if (named && first !== null) break;
        const at = deps.now();
        if (at - started >= SEARCH_MS) break;
        if (!named && firstAt !== null && at - firstAt >= SCAN_SETTLE_MS) break;
        await deps.sleep(POLL_MS);
      }
    } finally {
      stopScan = null;
      await session.stop();
    }
    check();
    const hit: ScanHit | null = first;
    if (named) return hit ? [hit] : [];
    const list = [...found.values()].sort((a, b) => b.rssi - a.rssi);
    const i = preferId ? list.findIndex((c) => sameId(c.id, preferId!)) : -1;
    if (i > 0) list.unshift(...list.splice(i, 1));
    return list;
  }

  /** Pairing mode not open: watch the DashPal advertise the pairing service, up to 60 s. */
  async function watchPairing(t: DashcamTransport, id: string, name: string): Promise<boolean> {
    const until = deps.now() + PRESS_WAIT_MS;
    set({ kind: 'press_button', name, until });
    let open = false;
    const session = await t.scan({
      services: [PAIRING_SERVICE],
      seconds: PRESS_WAIT_MS / 1000,
      fast: true,
      onHit: (hit) => {
        if (sameId(hit.id, id) && hit.pairing) open = true;
      },
    });
    stopScan = session.stop;
    try {
      while (!stopNow() && !open && deps.now() < until) await deps.sleep(POLL_MS);
    } finally {
      stopScan = null;
      await session.stop();
    }
    check();
    return open;
  }

  // ——— one AUTH exchange ———

  /**
   * The verdict of the last AUTH write: polled every 100 ms while pending, up to `ms`. `onPending`:
   * the dashcam answered pending (the code tag checked: the request took or holds the claim).
   */
  async function verdict(t: DashcamTransport, id: string, ms: number, onPending?: () => void): Promise<AuthRecord | 'fault' | 'timeout'> {
    const until = deps.now() + ms;
    for (;;) {
      check();
      const rec = await t.authRead(id);
      if (rec === 'fault' || rec.kind !== 'pending') return rec;
      onPending?.();
      if (deps.now() >= until) return 'timeout';
      await deps.sleep(PAIR_POLL_MS);
    }
  }

  // ——— the pairing on one candidate ———

  /** This phone's earlier key with this DashPal (its pairing, else the orphan): `prev_id` with its proof. */
  async function previousKey(d: string): Promise<{ id: Uint8Array; kPair: Uint8Array } | null> {
    const own = await deps.secrets.readAuth().catch(() => null);
    if (own?.dashcamId === d) return { id: hexBytes(own.phoneId), kPair: hexBytes(own.kPair) };
    const orphan = await deps.secrets.readOrphan().catch(() => null);
    if (orphan?.dashcamId === d) return { id: hexBytes(orphan.phoneId), kPair: hexBytes(orphan.kPair) };
    return null;
  }

  function freshId(): Uint8Array {
    for (;;) {
      const id = random(8);
      if (id.length === 8 && id.some((b) => b !== 0)) return id;
    }
  }

  /**
   * Connect to `c`, check INFO, and pair. `named`: a link, a scan or a typed name named this DashPal
   * (a wrong code or proof ends the setup); unnamed (typed, no name): the caller moves to the next
   * candidate.
   */
  async function attempt(t: DashcamTransport, c: Candidate, aim: Aim, named: boolean): Promise<Attempt> {
    const before = deps.paired();
    let reconnects = 0;
    let idP = freshId();
    let idRetried = false;
    let mtuRetried = false;
    let notNowRetries = 0;
    /**
     * When the request that took the claim on this connection was sent (its answer was pending or
     * PAIR_RESP): the claim lasts 15 s from it, later requests never extend it, and a drop ends it.
     */
    let claimedAt: number | null = null;
    let replaceAsked = false;
    let pressAsked = false;
    const holdsClaim = (): boolean => claimedAt !== null && deps.now() - claimedAt < CLAIM_MS;
    const linkFailed = async (): Promise<Attempt | null> => {
      claimedAt = null; // the claim ends with its connection
      await release(t, c.id);
      if (reconnects++ < 1) return null;
      return named ? { kind: 'failed', reason: 'error' } : { kind: 'next', why: 'link' };
    };

    for (;;) {
      check();
      // ——— connect and INFO ———
      const shown = aim.d ? nameOf(aim.d) : (c.name ?? 'DashPal');
      if (!t.setupLinkUp(c.id)) set({ kind: 'connecting', name: shown, again: aim.again });
      let info: DashcamInfo | null;
      let hasAuth: boolean;
      try {
        // A connection still up (the Pair screen warmed it) keeps what its connect found.
        if (t.setupLinkUp(c.id)) hasAuth = authChar.get(c.id.toLowerCase()) ?? true;
        else hasAuth = await connectSetup(t, c.id);
        current = c.id;
        info = await t.readInfo(c.id);
      } catch (e) {
        report(e, 'connect');
        if (deps.platform === 'ios' && isIosBondLoss(e)) return { kind: 'failed', reason: 'ios_forget_first' };
        const r = await linkFailed();
        if (r) return r;
        continue;
      }
      check();
      if (!info) {
        const r = await linkFailed();
        if (r) return r;
        continue;
      }
      if (aim.d && info.dashcamId !== aim.d) {
        // Another DashPal under the same name (iOS, 1 in 65 536): not this one.
        await release(t, c.id);
        return { kind: 'next', why: 'link' };
      }
      if (!speaksLink(info)) return { kind: 'failed', reason: 'update_firmware' };
      if (!info.keyed) return { kind: 'failed', reason: 'no_key' };
      if (!hasAuth) return { kind: 'failed', reason: deps.platform === 'ios' ? 'ios_forget_first' : 'error' };
      if (!info.nonce) return { kind: 'failed', reason: 'error' };
      if (before && before.dashcamId !== info.dashcamId && !replaceAsked) {
        replaceAsked = true;
        set({ kind: 'confirm_replace', from: before.name, to: info.name });
        // The driver's answer may take a while: the paired DashPal's link comes back meanwhile.
        await giveBack();
        const yes = await waitYes('replace');
        check();
        if (!yes) throw new Cancelled();
        stepAside();
        continue; // the link may have dropped meanwhile: INFO again
      }
      if (!info.pairingOpen && !holdsClaim()) {
        if (pressAsked) return { kind: 'failed', reason: 'window_timeout' };
        pressAsked = true;
        await release(t, c.id);
        if (!(await watchPairing(t, c.id, info.name))) return { kind: 'failed', reason: 'window_timeout' };
        continue;
      }
      if (info.setupBusy && !holdsClaim()) {
        const until = deps.now() + BUSY_WAIT_MS;
        set({ kind: 'waiting_busy', name: info.name, until });
        let busy: DashcamInfo | null = info;
        while (busy?.setupBusy && deps.now() < until) {
          await deps.sleep(BUSY_POLL_MS);
          check();
          busy = await t.readInfo(c.id).catch(() => null);
        }
        if (!busy) {
          const r = await linkFailed();
          if (r) return r;
          continue;
        }
        if (busy.setupBusy) return { kind: 'failed', reason: 'setup_busy' };
        continue; // INFO again (pairing mode may have closed when the other phone paired)
      }
      if (deps.isBusy()) throw new DriveOpen();

      // ——— PAIR_REQ ———
      set({ kind: 'pairing', name: info.name, again: aim.again });
      const prev = await previousKey(info.dashcamId);
      const keysA = takeKeys();
      const np = random(16);
      let req;
      try {
        req = pairRequest({ code: aim.code.S, mac: info.mac, nc: info.nonce, idP, a: keysA.a, A: keysA.A, np, prev });
      } catch (e) {
        report(e, 'pair request');
        return { kind: 'failed', reason: 'error' };
      }
      const sentAt = deps.now();
      const claimed = (): void => {
        claimedAt ??= sentAt;
      };
      if ((await t.authWrite(c.id, req.bytes)) === 'fault') {
        const r = await linkFailed();
        if (r) return r;
        continue;
      }
      const resp = await verdict(t, c.id, PAIR_RESP_MS, claimed);
      if (resp === 'fault' || !t.setupLinkUp(c.id)) {
        // A disconnect before the verdict was read: a link failure, never a wrong code.
        const r = await linkFailed();
        if (r) return r;
        continue;
      }
      if (resp === 'timeout') return { kind: 'failed', reason: 'error' };
      if (resp.kind === 'result') {
        switch (resp.code) {
          case R.WRONG_CODE:
            await release(t, c.id);
            return named ? { kind: 'failed', reason: 'wrong_code' } : { kind: 'next', why: 'wrong_code' };
          case R.BUSY:
            continue; // INFO shows the claim: the busy wait
          case R.UNKEYED:
            return { kind: 'failed', reason: 'no_key' };
          case R.ID_IN_USE:
            if (idRetried) return { kind: 'failed', reason: 'error' };
            idRetried = true;
            idP = freshId();
            continue; // the same Nc: this check does not redraw it
          case R.MTU:
            if (mtuRetried) return { kind: 'failed', reason: 'mtu' };
            mtuRetried = true;
            if (deps.platform === 'android') await t.requestMtu(c.id);
            else await deps.sleep(IOS_MTU_WAIT_MS);
            continue;
          case R.NOT_NOW: {
            // The dashcam could not compute its answer, or the window closed: INFO decides
            // (docs/BLE_PROTOCOL.md §4).
            const now = await t.readInfo(c.id).catch(() => null);
            if (now && now.keyed && !now.setupBusy && (now.pairingOpen || holdsClaim()) && notNowRetries < NOT_NOW_RETRIES) {
              notNowRetries += 1;
              await deps.sleep(NOT_NOW_RETRY_MS);
              continue;
            }
            if (now && !now.pairingOpen && !holdsClaim() && !pressAsked) continue; // the press-button step
            if (now && !now.pairingOpen && pressAsked) return { kind: 'failed', reason: 'window_timeout' };
            return { kind: 'failed', reason: 'error' };
          }
          default:
            return { kind: 'failed', reason: 'error' };
        }
      }
      if (resp.kind !== 'pair_resp') return { kind: 'failed', reason: 'error' };
      claimed();
      const keys = pairKeys({ code: aim.code.S, mac: info.mac, nc: info.nonce, req: req.bytes, a: keysA.a, B: resp.B, Nd: resp.Nd });
      wipe(keysA.a);
      if (!keys || !proofOk(keys.proofD, resp.proofD)) {
        // A device that answered but cannot prove the code: send it nothing more.
        await release(t, c.id);
        return named ? { kind: 'failed', reason: 'unverified' } : { kind: 'next', why: 'proof' };
      }

      // ——— the key, then PAIR_FIN ———
      const pending: StoredAuth = {
        dashcamId: info.dashcamId,
        phoneId: toHex(idP),
        kPair: toHex(keys.K_pair),
        code: aim.code.kind === 'label' ? formatCode(aim.code.S, 'label', { dashes: false }) : null,
      };
      wipe(keys.K_pair);
      wipe(keys.k_conf);
      try {
        await deps.secrets.writePendingAuth(pending);
      } catch (e) {
        // No key stored: PAIR_FIN is not sent (the claim ends by itself; nothing is stored there).
        report(e, 'store key');
        return { kind: 'failed', reason: 'error' };
      }
      check();
      set({ kind: 'finishing', name: info.name, again: aim.again });
      finSent = true;
      const finWrite = await t.authWrite(c.id, pairFin(keys.proofP));
      const fin = finWrite === 'fault' ? 'fault' : await verdict(t, c.id, RESULT_MS);
      if (fin !== 'fault' && fin !== 'timeout' && fin.kind === 'result' && fin.code === R.OK) return finish(t, c, info, pending, false);
      if (fin !== 'fault' && fin !== 'timeout' && fin.kind === 'result' && t.setupLinkUp(c.id)) {
        // R_WRONG_PROOF, R_STORE_FAILED or R_NOT_NOW: nothing was stored.
        await deps.secrets.deletePendingAuth().catch((e: unknown) => report(e, 'delete key'));
        return { kind: 'failed', reason: 'error' };
      }
      // The link dropped before the RESULT was read: the outcome is unknown.
      return finUnknown(t, c, info, pending);
    }
  }

  /** PAIR_FIN's RESULT was not read: reconnect once (≤ 15 s) and try a session with the pending key. */
  async function finUnknown(t: DashcamTransport, c: Candidate, first: DashcamInfo, pending: StoredAuth): Promise<Attempt> {
    await release(t, c.id);
    const until = deps.now() + FIN_RECONNECT_MS;
    let connected = false;
    while (!connected && deps.now() < until) {
      check();
      try {
        await connectSetup(t, c.id, { timeoutMs: Math.max(1000, until - deps.now()) });
        connected = true;
        const info = await t.readInfo(c.id);
        if (info?.nonce && info.dashcamId === first.dashcamId) {
          const s = await t.startSession(c.id, info, { phoneId: pending.phoneId, kPair: pending.kPair });
          if (s.kind === 'up') return finish(t, c, info, pending, true);
          if (s.kind === 'unknown_phone') {
            // Nothing was stored: the key goes.
            await deps.secrets.deletePendingAuth().catch((e: unknown) => report(e, 'delete key'));
            await release(t, c.id);
            return { kind: 'failed', reason: 'error' };
          }
        }
      } catch (e) {
        report(e, 'reconnect after PAIR_FIN');
      }
      await release(t, c.id);
      if (!connected) await deps.sleep(500);
    }
    // Maybe stored, maybe not: kept only as the orphan, which proves prev_id at the next setup.
    await keepOrphan(pending);
    await deps.secrets.deletePendingAuth().catch((e: unknown) => report(e, 'delete key'));
    return { kind: 'failed', reason: 'error' };
  }

  /** A key the dashcam may hold, kept only to prove prev_id at the next setup. */
  async function keepOrphan(pending: StoredAuth): Promise<void> {
    await deps.secrets.writeOrphan({ dashcamId: pending.dashcamId, phoneId: pending.phoneId, kPair: pending.kPair }).catch((e: unknown) => report(e, 'orphan'));
  }

  /** The pairing is stored at the dashcam: a first session, hello, pair confirm, PAIRED; then saved. */
  async function finish(t: DashcamTransport, c: Candidate, info0: DashcamInfo, pending: StoredAuth, sessionUp: boolean): Promise<Attempt> {
    const got: { phones: number | null } = { phones: null };
    let unsubscribe: (() => void) | null = null;
    try {
      let up = sessionUp;
      if (!up) {
        // INFO again: the PAIR_REQ redrew this connection's Nc.
        const info = await t.readInfo(c.id);
        if (info?.nonce && info.dashcamId === info0.dashcamId) {
          const s = await t.startSession(c.id, info, { phoneId: pending.phoneId, kPair: pending.kPair });
          up = s.kind === 'up';
          if (!up) report(new Error(`first session: ${s.kind}`), 'session');
        }
      }
      if (up) {
        unsubscribe = await t.subscribeSealed(c.id, (bytes) => {
          const d = decodeTx(bytes);
          if (d.ok && d.frame.type === 'PAIRED') got.phones = d.frame.bondCount;
        });
        await t.writeSealed(c.id, encodeRx({ type: 'COMMAND', op: COMMAND.HELLO, arg: 0 }));
        await t.writeSealed(c.id, encodeRx({ type: 'COMMAND', op: COMMAND.PAIR_CONFIRM, arg: 0 }));
        const until = deps.now() + PAIRED_WAIT_MS;
        while (got.phones === null && deps.now() < until) await deps.sleep(POLL_MS);
      }
    } catch (e) {
      // The pairing is stored at the dashcam: the auto-connect proves it again by itself.
      report(e, 'finish');
    } finally {
      unsubscribe?.();
    }
    const record: PairedDashcam = { dashcamId: info0.dashcamId, peripheralId: c.id, name: info0.name, pairedAt: deps.now(), secure: true };
    await release(t, c.id);
    let final: StoredAuth | null;
    try {
      final = await deps.secrets.finalizeAuth();
    } catch (e) {
      // The dashcam stored this pairing but the key could not be made final: it is kept as the
      // orphan, which proves prev_id at the next setup (that record is then replaced, not added to).
      report(e, 'finalize key');
      await keepOrphan(pending);
      return { kind: 'failed', reason: 'error' };
    }
    if (!final) return { kind: 'failed', reason: 'error' };
    await deps.pair(record);
    await deps.secrets.deleteOrphan().catch((e: unknown) => report(e, 'delete orphan'));
    if (got.phones !== null) {
      try {
        deps.notePhones?.(record.dashcamId, got.phones);
      } catch (e) {
        report(e, 'notePhones');
      }
    }
    return { kind: 'done', paired: record, phones: got.phones };
  }

  /** Try the candidates `hits` in order; null: none left. */
  async function tryHits(t: DashcamTransport, hits: ScanHit[], aim: Aim, named: boolean, skip: Set<string>, seen: { proof: boolean; code: boolean }): Promise<SetupPhase | null> {
    const name = aim.d ? nameOf(aim.d) : aim.suffix ? `DashPal-${aim.suffix.toUpperCase()}` : null;
    for (const hit of hits) {
      check();
      const c: Candidate = { id: hit.id, name: hit.name, rssi: hit.rssi };
      const r = await attempt(t, c, aim, named);
      if (r.kind === 'done') return { kind: 'done', paired: r.paired, phones: r.phones, notAllYours: r.phones !== null && r.phones >= 2 };
      if (r.kind === 'failed') return { kind: 'failed', reason: r.reason, name };
      await release(t, c.id);
      skip.add(c.id.toLowerCase());
      if (r.why === 'proof') seen.proof = true;
      if (r.why === 'wrong_code') seen.code = true;
    }
    return null;
  }

  /** The pairing step for a known code: find, connect and pair (typed with no name: each candidate). */
  async function pairWith(t: DashcamTransport, aim: Aim, warm: Promise<ScanHit | null> | null): Promise<SetupPhase> {
    const named = aim.d !== null || aim.suffix !== null;
    const name = aim.d ? nameOf(aim.d) : aim.suffix ? `DashPal-${aim.suffix.toUpperCase()}` : null;
    const skip = new Set<string>();
    const seen = { proof: false, code: false };
    const warmed = warm ? await warm : null;
    check();
    if (warmed) {
      const r = await tryHits(t, [warmed], aim, named, skip, seen);
      if (r) return r;
    }
    set({ kind: 'searching', name, again: aim.again });
    // Named: a candidate under its name that was not the DashPal (iOS) is skipped and the search goes on.
    for (let round = 0; round < (named ? 2 : 1); round++) {
      const hits = await search(t, aim, skip);
      if (hits.length === 0) break;
      const r = await tryHits(t, hits, aim, named, skip, seen);
      if (r) return r;
    }
    if (named) return { kind: 'failed', reason: 'not_found', name };
    if (seen.proof) return { kind: 'failed', reason: 'unverified_nearby', name: null };
    return { kind: 'failed', reason: seen.code ? 'no_match' : 'not_found', name: null };
  }

  /**
   * A link's Pair screen: find, connect and read INFO while the button shows (the tap then only
   * sends the request). Resolves with the DashPal's advert, or null.
   */
  async function prewarm(t: DashcamTransport, d: string): Promise<ScanHit | null> {
    try {
      const hits = await search(t, { d, suffix: null }, new Set());
      const hit = hits[0];
      if (!hit || cancelled) return null;
      await connectSetup(t, hit.id);
      const info = await t.readInfo(hit.id);
      if (!info || info.dashcamId !== d) {
        await release(t, hit.id);
        return null;
      }
      return hit;
    } catch (e) {
      report(e, 'pre-warm');
      if (current) await release(t, current);
      return null;
    }
  }

  /** The code of this phone's own pairing for Set up again, when it paired from the label. */
  async function storedCode(): Promise<Aim | null> {
    const paired = deps.paired();
    const own = await deps.secrets.readAuth().catch(() => null);
    if (!paired || !own || own.dashcamId !== paired.dashcamId || !own.code) return null;
    const code = parseCode(own.code);
    return code && code.kind === 'label' ? { code, d: paired.dashcamId, suffix: null, again: true } : null;
  }

  /** The code a link held in SecureStore, for this dashcam (≤ 12 h). */
  async function heldCode(dashcamId: string | null): Promise<Aim | null> {
    const held = await deps.secrets.readPendingCode(deps.now()).catch(() => null);
    if (!held) return null;
    if (dashcamId !== null && held.dashcamId !== null && held.dashcamId !== dashcamId) return null;
    const code = parseCode(held.code);
    return code ? { code, d: held.dashcamId ?? dashcamId, suffix: null, again: false } : null;
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
      running = true;
      cancelled = false;
      finSent = false;
      stepped = false;
      preferId = opts.preferId;
      preferred = opts.fromLink?.dashcamId ? nameOf(opts.fromLink.dashcamId) : null;
      let t: DashcamTransport | null = null;
      let result: SetupPhase | null = null;
      let warm: Promise<ScanHit | null> | null = null;
      let usedLink = false;
      // A drive opening ends every wait for the driver at once (the paired DashPal's link comes back).
      let offDrive: (() => void) | null = null;
      try {
        offDrive = deps.onDriveChange(() => {
          if (!driveOpened()) return;
          wakeWaiters();
          const stop = stopScan;
          stopScan = null;
          void stop?.().catch((e: unknown) => report(e, 'stopScan'));
        });
        if (deps.isBusy()) throw new DriveOpen();
        set({ kind: 'permission' });
        await deps.optIn().catch((e: unknown) => report(e, 'optIn'));
        const access = await deps.requestBluetooth().catch((e: unknown) => {
          report(e, 'requestBluetooth');
          return 'undetermined' as const;
        });
        check();
        if (access === 'denied' || access === 'undetermined') result = { kind: 'denied' };
        else if (access === 'off') result = { kind: 'off' };
        else if (access === 'unavailable') result = { kind: 'unavailable' };
        else t = deps.transport();
        if (!result && !t) result = { kind: 'unavailable' };
        if (!result && t) {
          await t.start().catch((e: unknown) => report(e, 'start'));
          // The paired dashcam's auto-connect stays on while setup waits for the driver (the code,
          // Pair, Replace); it steps aside only for the radio work, and comes back when setup ends
          // without pairing.
          let aim: Aim | null = null;
          if (opts.again) {
            aim = await storedCode();
            if (!aim) noStoredCode = true;
          } else {
            // A link's code held in SecureStore (≤ 12 h): its Pair screen, whichever way setup was
            // opened (the link itself, or Settings and onboarding after a sign-in held it).
            aim = await heldCode(opts.fromLink?.dashcamId ?? null);
            if (aim) {
              usedLink = true;
              const tt = t;
              // The paired DashPal itself is not warmed: its auto-connect holds that link meanwhile.
              if (aim.d && aim.d !== deps.paired()?.dashcamId) warm = prewarm(tt, aim.d);
              set({ kind: 'confirm_link', name: aim.d ? nameOf(aim.d) : 'DashPal' });
              const yes = await waitYes('confirm');
              check();
              if (!yes) throw new Cancelled();
            }
          }
          if (!aim) {
            codePhase(null);
            aim = await waitCode();
            check();
            if (!aim) throw new Cancelled();
          }
          check();
          stepAside();
          result = await pairWith(t, aim, warm);
        }
      } catch (e) {
        if (e instanceof DriveOpen) result = { kind: 'busy' };
        else if (!(e instanceof Cancelled)) {
          report(e, 'setup');
          result = { kind: 'failed', reason: 'error', name: null };
        }
      } finally {
        offDrive?.();
        if (warm) await (warm as Promise<ScanHit | null>).catch(() => null);
        if (t && current) await release(t, current);
        if (result?.kind !== 'done') {
          await deps.secrets.deletePendingAuth().catch((e: unknown) => report(e, 'delete key'));
          await giveBack();
        }
        // A held link code is used once: done, failed or cancelled.
        if (usedLink || result?.kind === 'done' || result?.kind === 'failed' || cancelled) {
          await deps.secrets.deletePendingCode().catch((e: unknown) => report(e, 'delete held code'));
        }
        running = false;
      }
      if (result?.kind === 'done') return set(result);
      if (cancelled) return set({ kind: 'cancelled' });
      if (result) set(result);
    },

    scanned(text) {
      if (phase.kind !== 'code' || !codeWaiter) return;
      const parts = parseDashpalLink(text);
      if (parts === 'not_a_code' || !parts.code) {
        codePhase('not_a_code');
        return;
      }
      const w = codeWaiter;
      codeWaiter = null;
      w({ code: parts.code, d: parts.d, suffix: null, again: false });
    },

    submitCode(text, name) {
      if (phase.kind !== 'code' || !codeWaiter) return;
      const code = parseCode(text);
      const suffix = (name ?? '').trim().replace(/^dashpal-/i, '');
      if (!code || (suffix.length > 0 && !/^[0-9a-fA-F]{4}$/.test(suffix))) {
        codePhase('bad_code');
        return;
      }
      const w = codeWaiter;
      codeWaiter = null;
      w({ code, d: null, suffix: suffix.length > 0 ? suffix.toUpperCase() : null, again: false });
    },

    confirm() {
      const w = confirmWaiter;
      confirmWaiter = null;
      w?.(true);
    },

    confirmReplace() {
      const w = replaceWaiter;
      replaceWaiter = null;
      w?.(true);
    },

    async cancel() {
      cancelled = true;
      wakeWaiters();
      const stop = stopScan;
      stopScan = null;
      await stop?.().catch((e: unknown) => report(e, 'stopScan'));
      const t = deps.transport();
      if (t && current) await release(t, current);
      if (!running) set({ kind: 'cancelled' });
    },
  };
  return flow;
}

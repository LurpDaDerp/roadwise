// The DashPal runtime of one app runtime (plan §7): the link over the process's transport, the
// dashcam tables, the settings, and the hooks the drive host calls. Built by bootstrap next to the
// drive host and torn down with it (a handover builds a new one; the transport, a process
// singleton, stays). The transport is created lazily: nothing touches Bluetooth for a driver with
// no DashPal paired and no opt-in.
//
// Phone-first sound: the link reads the audio output (call, media volume, headphones) through
// `audioOutput`, read fresh for each routed ALERT and otherwise at most every 500 ms. On Android the
// runtime drives the DashPal link service (`linkService`, drive-sense `setDashpalLink`): `off` with
// no DashPal paired or Bluetooth not allowed, `connected` while the link is up, `waiting` otherwise
// (Bluetooth off, connecting, a repair: all things that can clear with RoadWise in the background).
// A running service is updated from anywhere; a stopped one is started only with RoadWise in front
// (Android refuses a background start), retried at the next return to the front after a refusal.
// The service's tick pumps the process timers, so a reconnect back-off fires with JS timers paused.
// A runtime torn down (a handover) leaves the service as it is: the next one reads `running()`.
// In the background with no drive recording the phone answers "cannot play" (the buzzer) unless the
// service runs, since without it Android may freeze the process or refuse it audio focus.
import type { AlertPlayer } from '@/core/alerts/player';
import type { FeatureRow } from '@/core/engine/types';
import type { Db } from '@/data/db/driver';
import { createSettingsRepo } from '@/data/db/settings';
import type { AppStateLike } from '@/data/foreground';
import { processTimers } from '@/lib/timers';

import { ensureInstallMarker } from './early';
import { asPhonesRecord, nextPhones, type PhonesEvent, type PhonesRecord } from './newPhone';
import { loadDashcamTripFacts, type DashcamTripFacts } from './facts';
import { asPaired, BT_OPT_IN_KEY, BUZZER_TOO_KEY, LAST_PHONES_KEY, PAIRED_KEY, type PairedDashcam } from './keys';
import { AUDIO_UNKNOWN, createDashcamLink, type AudioOutputProbe, type DashcamLink, type LinkContext, type Lifecycle, type LinkSnapshot } from './link';
import { COMMAND } from './protocol';
import { dashpalSecrets, type DashpalSecrets, type StoredAuth } from './secure';
import { createDashcamStore, UNATTACHED_KEEP_MS } from './store';
import type { DashcamTransport, TransportTarget } from './transport';

/** The drive host as the dashcam reads it, live. */
export interface DashcamHostView {
  recording: boolean;
  /** a drive is open, from the Start Drive tap until its finalize has finished (see `LinkContext`) */
  driveOpen: boolean;
  playerAvailable: boolean;
  callActive: boolean;
}

export interface DashcamState {
  link: LinkSnapshot;
  buzzerToo: boolean;
  btOptIn: boolean;
  /** the settings were read (before that, `link.paired` is null) */
  loaded: boolean;
  /** "A new phone was paired with your DashPal" waits to be dismissed (`newPhone.ts`) */
  newPhone: boolean;
}

export interface DashcamRuntime {
  ready: Promise<void>;
  state(): DashcamState;
  subscribe(fn: (s: DashcamState) => void): () => void;
  link: DashcamLink;
  /** The process transport, created on first use; null when Bluetooth is unavailable in this build. */
  transport(): DashcamTransport | null;
  // ——— the drive host's hooks ———
  /** `replay`: a journal row taken in again (the past): it counts toward neither STATE nor the coverage. */
  row(row: FeatureRow, drive: { clientTripId: string | null; recording: boolean; dryRun: boolean; replay?: boolean }): void;
  /** A drive continued after a relaunch: reload its coverage totals. */
  adopt(clientTripId: string): Promise<void>;
  /** Would this drive be a DashPal drive so far (the stopped-points estimate)? */
  estimateOn(clientTripId: string | null): boolean;
  beforeFinalize(clientTripId: string, opts?: { dryRun?: boolean }): Promise<void>;
  facts(trip: { clientTripId: string; startedAt: number; endedAt: number }): Promise<DashcamTripFacts>;
  continuousAlertActive(): boolean;
  playerUnavailable(): void;
  // ——— settings and pairing ———
  optIn(): Promise<void>;
  setBuzzerToo(on: boolean): Promise<void>;
  /** Save a pairing whose key is final in `dashpal.auth` and hand it to the auto-connect. */
  pair(record: PairedDashcam): Promise<void>;
  /** The paired DashPal's auto-connect steps aside while a setup's pairing step uses the radio. */
  stepAside(): void;
  /** The paired DashPal's auto-connect again (a setup that stepped it aside ended without a new pairing, or waits for the driver). */
  resumePaired(): Promise<void>;
  /** COMMAND 4 if connected (the dashcam deletes this phone's record), cancel the connection, delete the key, clear the pairing. */
  forget(): Promise<void>;
  /**
   * Add another phone: COMMAND 3, which opens the dashcam's pairing window for 2 minutes, for one
   * phone (no code). `openedAt` when it was sent; null when not connected or the write failed.
   */
  addPhone(): Promise<{ openedAt: number } | null>;
  /** This phone's own setup saw this phone count (no new-phone notice for it). */
  notePhones(dashcamId: string, phones: number): void;
  /** The new-phone notice was read. */
  dismissNewPhone(): Promise<void>;
  command(op: number, arg?: number): Promise<boolean>;
  pruneUnattached(): Promise<number>;
  /** The dashcam tables were emptied (a sign-out or account wipe): a live link handshakes again. */
  restartLink(): void;
  dispose(): void;
}

/** The Android DashPal link service's state as the runtime asks for it. */
export type LinkServiceState = 'off' | 'waiting' | 'connected';
export type LinkServiceResult = 'running' | 'stopped' | 'refused' | 'unsupported';

/** drive-sense's DashPal link service (Android only; omitted elsewhere). */
export interface LinkServicePort {
  set(state: LinkServiceState): Promise<LinkServiceResult>;
  /** Sync: the service is running now. */
  running(): boolean;
  /** The service's 30-s tick while it waits. */
  onTick(fn: () => void): { remove(): void };
}

/** A probe read this recently is reused for a tick (a routed ALERT always reads it fresh). */
export const AUDIO_PROBE_MEMO_MS = 500;
/** A pairing key read that failed at load is tried again this long after (and at each later chance). */
export const KEY_RETRY_MS = 5000;

/**
 * What the DashPal link service should be for this link (integration R3): off with no DashPal
 * paired or Bluetooth not allowed (no retry can succeed), connected while the link is up, waiting
 * otherwise (Bluetooth off, connecting, a repair can all clear with RoadWise in the background, and
 * a stopped service could not be started again from there).
 */
export function linkServiceStateFor(paired: boolean, lifecycle: Lifecycle): LinkServiceState {
  if (!paired || lifecycle === 'unpaired' || lifecycle === 'unauthorized') return 'off';
  return lifecycle === 'connected' ? 'connected' : 'waiting';
}

export interface DashcamRuntimeDeps {
  db: Db;
  player: AlertPlayer;
  /** The process transport (lazy); throws or returns null where BLE is unavailable. */
  transport: () => DashcamTransport | null;
  host: () => DashcamHostView;
  /** the alert style is not vibration-only, read live */
  styleAllowsSound: () => boolean;
  platform: 'ios' | 'android';
  appState?: AppStateLike;
  now?: () => number;
  newId: () => string;
  setTimer?: (fn: () => void, ms: number) => unknown;
  clearTimer?: (h: unknown) => void;
  setRepeat?: (fn: () => void, ms: number) => unknown;
  clearRepeat?: (h: unknown) => void;
  onError?: (e: unknown, ctx: string) => void;
  /** The audio output now (drive-sense `audioOutputState`, sync). Absent: unknown. */
  audioOutput?: () => AudioOutputProbe;
  /** Android: hold the CPU awake for `ms` (drive-sense `holdAwake`, sync). */
  holdAwake?: (ms: number) => void;
  /** Android: the DashPal link service. */
  linkService?: LinkServicePort;
  /** Write the install marker if missing (`early.ts`); default AsyncStorage. */
  ensureInstallMarker?: () => Promise<void>;
  /** The DashPal SecureStore entries (one store per phone in the e2e bench). */
  secrets?: DashpalSecrets;
  /** A pairing was saved or forgotten (the new-phone notice resets). */
  onPairingChanged?: (paired: PairedDashcam | null) => void;
}

/** "DashPal drive" so far: the server's rule, without the end-of-drive sync (plan §8.3). */
export const MIN_MOVING_S = 60;
export const MIN_COVERAGE_PCT = 80;

export function createDashcamRuntime(deps: DashcamRuntimeDeps): DashcamRuntime {
  const now = deps.now ?? Date.now;
  // Pumped timers: a drive row or a frame fires them while Android pauses JS timers.
  const setTimer = deps.setTimer ?? ((fn, ms) => processTimers.setTimeout(fn, ms));
  const clearTimer = deps.clearTimer ?? ((h) => processTimers.clearTimeout(h));
  const setRepeat = deps.setRepeat ?? ((fn, ms) => setInterval(fn, ms));
  const clearRepeat = deps.clearRepeat ?? ((h) => clearInterval(h as ReturnType<typeof setInterval>));
  const settings = createSettingsRepo(deps.db);
  const store = createDashcamStore(deps.db);
  const secrets = deps.secrets ?? dashpalSecrets;
  /** a drive was recording at the last row (a drive start retries a waiting reconnect at once) */
  let lastRecording = false;
  /** the new-phone record (`dashcam.lastPhones`) and its persistence chain */
  let phones: PhonesRecord | null = null;
  let phonesChain: Promise<void> = Promise.resolve();
  /** the last STATUS phone count fed to the record (per connection) */
  let fedStatusAt: number | null = null;

  function phonesEvent(e: PhonesEvent): void {
    const next = nextPhones(phones, e);
    if (next === phones) return;
    const changedNotice = (next?.notice ?? false) !== (phones?.notice ?? false);
    phones = next;
    const value = next;
    phonesChain = phonesChain
      .then(async () => {
        if (value) await settings.set(LAST_PHONES_KEY, value);
        else await settings.remove(LAST_PHONES_KEY);
      })
      .catch((err: unknown) => report(err, 'phones'));
    if (changedNotice) notify();
  }

  /** Each sealed STATUS's phone count (the link is authenticated: these are the DashPal's own). */
  function feedStatus(snap: LinkSnapshot): void {
    const st = snap.status;
    const paired = snap.paired;
    if (!st || !paired || snap.lifecycle !== 'connected' || st.at === fedStatusAt) return;
    fedStatusAt = st.at;
    phonesEvent({ kind: 'count', dashcamId: paired.dashcamId, count: st.bondCount, now: now() });
  }
  const listeners = new Set<(s: DashcamState) => void>();
  let buzzerToo = false;
  let btOptIn = false;
  let loaded = false;
  let disposed = false;
  let transport: DashcamTransport | null = null;
  let transportFailed = false;
  let detach: (() => void) | null = null;
  let wakeTimer: unknown = null;
  let repeat: unknown = null;
  let foreground = deps.appState?.currentState === 'active';
  const totals = new Map<string, { movingS: number; coveredS: number }>();
  /** The last audio-output read, reused for `AUDIO_PROBE_MEMO_MS`. */
  let probeMemo: { at: number; value: AudioOutputProbe } | null = null;
  /** The link service: what it was last set to, a call in flight, and a refusal waiting for the front. */
  const service = { sent: null as LinkServiceState | null, busy: false, refused: false, pairedId: null as string | null, unsupported: false };
  /**
   * The pairing's key could not be read (a Keychain or Keystore error, not a missing key): the
   * pairing stays and its auto-connect waits for a read that works (RoadWise back in front, a drive
   * starting, a setup ending).
   */
  let keyUnread = false;
  let keyRetrying = false;
  /** a setup's pairing step holds the radio (`stepAside`): no key retry reconnects under it */
  let aside = false;

  function audioOutput(fresh: boolean): AudioOutputProbe {
    const read = deps.audioOutput;
    if (!read) return AUDIO_UNKNOWN;
    const t = now();
    const m = probeMemo;
    if (!fresh && m !== null && t >= m.at && t - m.at <= AUDIO_PROBE_MEMO_MS) return m.value;
    let value: AudioOutputProbe;
    try {
      value = read();
    } catch (e) {
      report(e, 'audio output');
      value = AUDIO_UNKNOWN;
    }
    probeMemo = { at: t, value };
    return value;
  }

  function report(e: unknown, ctx: string): void {
    try {
      deps.onError?.(e, ctx);
    } catch {
      // nobody left to tell
    }
  }

  /**
   * Android, RoadWise in the background with no drive recording: the phone can sound a DashPal alert
   * only while the DashPal link service runs (it keeps the process running and gives it audio focus;
   * a drive's capture service does the same while one records). Without it, "cannot": the buzzer.
   */
  function backgroundSoundHeld(h: DashcamHostView): boolean {
    const port = deps.linkService;
    if (deps.platform !== 'android' || !port || foreground || h.recording) return true;
    try {
      return port.running();
    } catch (e) {
      report(e, 'link service');
      return false;
    }
  }

  const context = (): LinkContext => {
    const h = deps.host();
    return {
      recording: h.recording,
      driveOpen: h.driveOpen,
      foreground,
      playerAvailable: h.playerAvailable && backgroundSoundHeld(h),
      styleAllowsSound: deps.styleAllowsSound(),
      // Android has no call signal the app can rely on (plan §7.3): only iOS reports one, and only
      // while a drive records (its capture watches calls). Outside a drive the host's flag is the
      // last one a capture saw and may be stale (a call that outlasted the drive); the audio probe,
      // read fresh, says whether a call is up then.
      callActive: deps.platform === 'ios' && h.recording && h.callActive,
      buzzerToo,
    };
  };

  function getTransport(): DashcamTransport | null {
    if (transport || transportFailed) return transport;
    try {
      transport = deps.transport();
    } catch (e) {
      transportFailed = true;
      report(e, 'transport');
      transport = null;
    }
    if (transport && !detach && !disposed) detach = transport.attach(link);
    return transport;
  }

  const link: DashcamLink = createDashcamLink({
    now,
    store,
    newId: deps.newId,
    write: (bytes, o) => {
      const t = getTransport();
      return t ? t.write(bytes, o) : Promise.reject(new Error('no Bluetooth transport'));
    },
    player: deps.player,
    context,
    localMinute: (at) => {
      const d = new Date(at);
      return d.getHours() * 60 + d.getMinutes();
    },
    wake: (at) => {
      if (wakeTimer !== null) clearTimer(wakeTimer);
      wakeTimer = null;
      if (at === null || disposed) return;
      wakeTimer = setTimer(() => {
        wakeTimer = null;
        link.tick();
      }, Math.max(0, at - now()));
    },
    delay: (ms) => new Promise<void>((resolve) => setTimer(resolve, ms)),
    // Android pauses JS timers while the app is in the background (unless a headless task runs).
    timersPaused: () => deps.platform === 'android' && !foreground,
    audioOutput: (fresh) => audioOutput(fresh),
    ...(deps.holdAwake ? { holdAwake: deps.holdAwake } : {}),
    onChange: () => notify(),
    onPaired: (count) => {
      const paired = link.snapshot().paired;
      if (paired) phonesEvent({ kind: 'count', dashcamId: paired.dashcamId, count, now: now() });
    },
    onError: (e, ctx) => report(e, `link ${ctx}`),
  });

  function state(): DashcamState {
    return { link: link.snapshot(), buzzerToo, btOptIn, loaded, newPhone: phones?.notice === true && phones.dashcamId === link.snapshot().paired?.dashcamId };
  }

  function notify(): void {
    const s = state();
    feedStatus(s.link);
    driveLinkService(s.link);
    syncRepeat(s.link);
    for (const fn of [...listeners]) {
      try {
        fn(s);
      } catch (e) {
        report(e, 'subscriber');
      }
    }
  }

  /**
   * The DashPal link service follows the link: one call at a time, a newer state sent when it
   * settles. A running service is updated from anywhere; a stopped one only with RoadWise in front,
   * and not again after a refusal until RoadWise is back in front (or the pairing changes).
   */
  function driveLinkService(snap: LinkSnapshot = link.snapshot()): void {
    const port = deps.linkService;
    if (!port || deps.platform !== 'android' || disposed || !loaded || service.unsupported || service.busy) return;
    const pairedId = snap.paired?.dashcamId ?? null;
    if (pairedId !== service.pairedId) {
      service.pairedId = pairedId;
      service.refused = false;
    }
    const want = linkServiceStateFor(snap.paired !== null, snap.lifecycle);
    let running = false;
    try {
      running = port.running();
    } catch (e) {
      report(e, 'link service');
    }
    if (want === 'off') {
      if (!running) {
        service.sent = 'off';
        return;
      }
    } else if (running) {
      if (want === service.sent) return;
    } else if (!foreground || service.refused) {
      // A stopped service cannot be started from the background: the next return to the front does.
      return;
    }
    service.busy = true;
    void port.set(want).then(
      (result) => settleLinkService(want, result),
      (e: unknown) => {
        report(e, 'link service');
        settleLinkService(want, 'refused');
      }
    );
  }

  function settleLinkService(want: LinkServiceState, result: LinkServiceResult): void {
    service.busy = false;
    if (result === 'unsupported') {
      service.unsupported = true;
      return;
    }
    if (result === 'refused') service.refused = true;
    else service.sent = want;
    if (result !== 'refused') driveLinkService();
  }

  /**
   * The 1 s tick while the app is in the foreground and the paired dashcam is connected (§7.3): with
   * no link it would tick an empty table (the link's own wake covers everything due once it is up).
   */
  function syncRepeat(snap: LinkSnapshot = link.snapshot()): void {
    const want = foreground && snap.paired !== null && snap.lifecycle === 'connected' && !disposed;
    if (want && repeat === null) repeat = setRepeat(() => link.tick(), 1000);
    if (!want && repeat !== null) {
      clearRepeat(repeat);
      repeat = null;
    }
  }

  const appSub = deps.appState?.addEventListener('change', (s) => {
    const wasForeground = foreground;
    foreground = s === 'active';
    // Back in front: a refused start of the link service may now succeed, and a reconnect that waits
    // (a soft repair, a backoff) tries at once (an iPhone outside a drive cannot fire its timers).
    if (foreground && !wasForeground) {
      service.refused = false;
      transport?.retryNow();
      void retryKey();
    }
    syncRepeat();
    link.tick();
    driveLinkService();
  });
  // The link service's tick: fire the timers JS cannot fire in the background (a connect back-off).
  const tickSub = (() => {
    try {
      if (deps.platform !== 'android') return undefined;
      return deps.linkService?.onTick(() => {
        if (!disposed) processTimers.pump();
      });
    } catch (e) {
      report(e, 'link service tick');
      return undefined;
    }
  })();

  /**
   * The link's pairing changed while the transport may already be linked (a screen created the
   * transport before the settings were read): attach again, so the transport replays its state
   * (link up, Bluetooth) to the link with the right pairing.
   */
  function reattach(): void {
    if (!transport || !detach || disposed) return;
    detach();
    detach = transport.attach(link);
  }

  const targetOf = (paired: PairedDashcam, auth: StoredAuth): TransportTarget => ({
    peripheralId: paired.peripheralId,
    dashcamId: paired.dashcamId,
    auth: { phoneId: auth.phoneId, kPair: auth.kPair },
  });

  async function connectPaired(paired: PairedDashcam | null, auth: StoredAuth | null): Promise<void> {
    if (!paired || !auth) {
      transport?.setTarget(null);
      return;
    }
    const t = getTransport();
    if (!t) return;
    t.setTarget(targetOf(paired, auth));
    await t.start();
  }

  /**
   * This pairing's key; null when this phone has none for it (the record cannot be used);
   * `unreadable` when the read itself failed (the key may well be there: the record stays).
   */
  async function keyFor(paired: PairedDashcam): Promise<StoredAuth | null | 'unreadable'> {
    let auth: StoredAuth | null;
    try {
      auth = await secrets.readAuth();
    } catch (e) {
      report(e, 'read key');
      return 'unreadable';
    }
    return auth && auth.dashcamId === paired.dashcamId ? auth : null;
  }

  /** A pairing found keyless after load: it goes, as at load (nothing can connect with it). */
  async function dropKeyless(): Promise<void> {
    await settings.remove(PAIRED_KEY).catch((e: unknown) => report(e, 'drop keyless pairing'));
    await secrets.writeTarget(null).catch((e: unknown) => report(e, 'secure target'));
    transport?.setTarget(null);
    phonesEvent({ kind: 'reset' });
    link.setPaired(null);
    syncRepeat();
    notify();
    deps.onPairingChanged?.(null);
  }

  /** The key read that failed, again; it connects once the key reads (or drops a pairing found keyless). */
  async function retryKey(): Promise<void> {
    const paired = link.snapshot().paired;
    if (!keyUnread || keyRetrying || aside || disposed || !paired) return;
    keyRetrying = true;
    try {
      const key = await keyFor(paired);
      if (key === 'unreadable' || !keyUnread || aside || disposed || link.snapshot().paired !== paired) return;
      keyUnread = false;
      if (key === null) await dropKeyless();
      else await connectPaired(paired, key);
    } finally {
      keyRetrying = false;
    }
  }

  const ready = (async () => {
    try {
      void (deps.ensureInstallMarker ?? ensureInstallMarker)().catch((e: unknown) => report(e, 'install marker'));
      const got = await settings.getMany([PAIRED_KEY, BUZZER_TOO_KEY, BT_OPT_IN_KEY, LAST_PHONES_KEY]);
      phones = asPhonesRecord(got[LAST_PHONES_KEY]);
      let paired = asPaired(got[PAIRED_KEY]);
      if (!paired && got[PAIRED_KEY] !== null && got[PAIRED_KEY] !== undefined) {
        // A link v1 pairing (Bluetooth bonding), or an unreadable record: no DashPal speaks it, so
        // it goes, with its SecureStore peripheral; the driver sets the DashPal up again.
        await settings.remove(PAIRED_KEY).catch((e: unknown) => report(e, 'drop v1 pairing'));
      }
      const auth = paired ? await keyFor(paired) : null;
      if (paired && auth === null) {
        // A pairing whose key is not on this phone (a backup restored to a new phone: the key is
        // "this device only"): it cannot connect, so it goes; the driver sets the DashPal up here.
        await settings.remove(PAIRED_KEY).catch((e: unknown) => report(e, 'drop keyless pairing'));
        paired = null;
      }
      buzzerToo = got[BUZZER_TOO_KEY] === true;
      btOptIn = got[BT_OPT_IN_KEY] === true;
      loaded = true;
      if (disposed) return;
      link.setPaired(paired);
      reattach();
      syncRepeat();
      if (paired && auth === 'unreadable') {
        // The record stays; the auto-connect waits for a key read that works.
        keyUnread = true;
        setTimer(() => void retryKey(), KEY_RETRY_MS);
      } else if (paired && auth !== 'unreadable') {
        await connectPaired(paired, auth);
      } else {
        // Nobody to reconnect at launch: the transport attaches only when setup or the detector
        // asks. Without an opt-in either, the next launch does not start the BLE manager.
        if (!btOptIn) await secrets.writeEnabled(false).catch((e: unknown) => report(e, 'secure flag'));
        await secrets.writeTarget(null).catch((e: unknown) => report(e, 'secure target'));
      }
    } catch (e) {
      loaded = true;
      report(e, 'load');
    }
    notify();
  })();

  const self: DashcamRuntime = {
    ready,
    state,
    subscribe(fn) {
      listeners.add(fn);
      return () => {
        listeners.delete(fn);
      };
    },
    link,
    transport: getTransport,

    row(row, drive) {
      // A drive starting: a reconnect that waits (a soft repair, a backoff) tries at once.
      if (drive.recording && !lastRecording) {
        transport?.retryNow();
        void retryKey();
      }
      lastRecording = drive.recording;
      const verdict = link.row(row, drive);
      if (!verdict || drive.clientTripId === null) return;
      const t = totals.get(drive.clientTripId) ?? { movingS: 0, coveredS: 0 };
      if (verdict.moving) t.movingS += 1;
      if (verdict.covered) t.coveredS += 1;
      totals.set(drive.clientTripId, t);
    },

    async adopt(clientTripId) {
      try {
        const c = await store.coverage(clientTripId);
        totals.set(clientTripId, { movingS: c?.movingS ?? 0, coveredS: c?.coveredS ?? 0 });
      } catch (e) {
        report(e, 'adopt');
      }
    },

    estimateOn(clientTripId) {
      if (clientTripId === null || link.snapshot().paired === null) return false;
      const t = totals.get(clientTripId);
      return !!t && t.movingS >= MIN_MOVING_S && 100 * t.coveredS >= MIN_COVERAGE_PCT * t.movingS;
    },

    async beforeFinalize(clientTripId, opts = {}) {
      try {
        await link.beforeFinalize(clientTripId, opts);
      } catch (e) {
        report(e, 'beforeFinalize');
      }
      totals.delete(clientTripId);
    },

    facts: (trip) => loadDashcamTripFacts(deps.db, trip),
    continuousAlertActive: () => link.continuousAlertActive(),
    playerUnavailable: () => link.playerUnavailable(),

    async optIn() {
      await settings.set(BT_OPT_IN_KEY, true);
      btOptIn = true;
      await secrets.writeEnabled(true).catch((e: unknown) => report(e, 'secure flag'));
      notify();
    },

    async setBuzzerToo(on) {
      await settings.set(BUZZER_TOO_KEY, on);
      buzzerToo = on;
      notify();
      link.tick();
    },

    async pair(record) {
      const auth = await keyFor(record);
      if (auth === null || auth === 'unreadable') throw new Error('no pairing key for this DashPal');
      keyUnread = false;
      aside = false;
      await settings.set(PAIRED_KEY, record);
      await settings.set(BT_OPT_IN_KEY, true);
      btOptIn = true;
      await secrets.writeEnabled(true).catch((e: unknown) => report(e, 'secure flag'));
      await secrets.writeTarget({ peripheralId: record.peripheralId, dashcamId: record.dashcamId }).catch((e: unknown) => report(e, 'secure target'));
      if (phones && phones.dashcamId !== record.dashcamId) phonesEvent({ kind: 'reset' });
      link.setPaired(record);
      syncRepeat();
      notify();
      deps.onPairingChanged?.(record);
      await connectPaired(record, auth);
    },

    stepAside() {
      aside = true;
      getTransport()?.setTarget(null);
    },

    async resumePaired() {
      aside = false;
      const paired = link.snapshot().paired;
      if (!paired) return;
      const key = await keyFor(paired);
      if (key === 'unreadable') {
        keyUnread = true;
        return;
      }
      keyUnread = false;
      await connectPaired(paired, key);
    },

    async forget() {
      if (link.snapshot().lifecycle === 'connected') {
        await link.command(COMMAND.FORGET_ME).catch((e: unknown) => report(e, 'forget me'));
      }
      keyUnread = false;
      aside = false;
      transport?.setTarget(null);
      await settings.remove(PAIRED_KEY);
      await secrets.deleteAuth().catch((e: unknown) => report(e, 'delete key'));
      await secrets.writeTarget(null).catch((e: unknown) => report(e, 'secure target'));
      phonesEvent({ kind: 'reset' });
      link.setPaired(null);
      syncRepeat();
      notify();
      deps.onPairingChanged?.(null);
    },

    async addPhone() {
      const paired = link.snapshot().paired;
      if (!paired || link.snapshot().lifecycle !== 'connected') return null;
      // A rise within 3 min is this phone's own doing: marked before the window opens.
      const openedAt = now();
      phonesEvent({ kind: 'own_add', dashcamId: paired.dashcamId, now: openedAt });
      const ok = await link.command(COMMAND.OPEN_PAIRING).catch((e: unknown) => {
        report(e, 'open pairing');
        return false;
      });
      return ok ? { openedAt } : null;
    },

    notePhones(dashcamId, count) {
      phonesEvent({ kind: 'own_setup', dashcamId, count });
    },

    async dismissNewPhone() {
      phonesEvent({ kind: 'dismiss' });
      await phonesChain;
    },

    command: (op, arg) => link.command(op, arg),

    pruneUnattached: () => store.pruneUnattached(now() - UNATTACHED_KEEP_MS),

    restartLink: () => link.restart(),

    dispose() {
      disposed = true;
      appSub?.remove();
      // The link service outlives the runtime (a handover): the next runtime reads running().
      tickSub?.remove();
      if (wakeTimer !== null) clearTimer(wakeTimer);
      wakeTimer = null;
      if (repeat !== null) clearRepeat(repeat);
      repeat = null;
      detach?.();
      detach = null;
      link.dispose();
      listeners.clear();
    },
  };
  return self;
}

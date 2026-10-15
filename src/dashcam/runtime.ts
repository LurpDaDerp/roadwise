// The DashPal runtime of one app runtime (plan §7): the link over the process's transport, the
// dashcam tables, the settings, and the hooks the drive host calls. Built by bootstrap next to the
// drive host and torn down with it (a handover builds a new one; the transport, a process
// singleton, stays). The transport is created lazily: nothing touches Bluetooth for a driver with
// no DashPal paired and no opt-in.
import type { AlertPlayer } from '@/core/alerts/player';
import type { FeatureRow } from '@/core/engine/types';
import type { Db } from '@/data/db/driver';
import { createSettingsRepo } from '@/data/db/settings';
import type { AppStateLike } from '@/data/foreground';

import { loadDashcamTripFacts, type DashcamTripFacts } from './facts';
import { asPaired, BT_OPT_IN_KEY, BUZZER_TOO_KEY, PAIRED_KEY, type PairedDashcam } from './keys';
import { createDashcamLink, type DashcamLink, type LinkContext, type LinkSnapshot } from './link';
import { COMMAND } from './protocol';
import { writeDashpalEnabled, writeSecureTarget } from './secure';
import { createDashcamStore, UNATTACHED_KEEP_MS } from './store';
import type { DashcamTransport } from './transport';

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
}

export interface DashcamRuntime {
  ready: Promise<void>;
  state(): DashcamState;
  subscribe(fn: (s: DashcamState) => void): () => void;
  link: DashcamLink;
  /** The process transport, created on first use; null when Bluetooth is unavailable in this build. */
  transport(): DashcamTransport | null;
  // ——— the drive host's hooks ———
  row(row: FeatureRow, drive: { clientTripId: string | null; recording: boolean; dryRun: boolean }): void;
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
  pair(record: PairedDashcam): Promise<void>;
  /** COMMAND 4 if connected, cancel the connection, Android removeBond, clear the pairing. */
  forget(): Promise<void>;
  command(op: number, arg?: number): Promise<boolean>;
  pruneUnattached(): Promise<number>;
  /** The dashcam tables were emptied (a sign-out or account wipe): a live link handshakes again. */
  restartLink(): void;
  dispose(): void;
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
}

/** "DashPal drive" so far: the server's rule, without the end-of-drive sync (plan §8.3). */
export const MIN_MOVING_S = 60;
export const MIN_COVERAGE_PCT = 80;

export function createDashcamRuntime(deps: DashcamRuntimeDeps): DashcamRuntime {
  const now = deps.now ?? Date.now;
  const setTimer = deps.setTimer ?? ((fn, ms) => setTimeout(fn, ms));
  const clearTimer = deps.clearTimer ?? ((h) => clearTimeout(h as ReturnType<typeof setTimeout>));
  const setRepeat = deps.setRepeat ?? ((fn, ms) => setInterval(fn, ms));
  const clearRepeat = deps.clearRepeat ?? ((h) => clearInterval(h as ReturnType<typeof setInterval>));
  const settings = createSettingsRepo(deps.db);
  const store = createDashcamStore(deps.db);
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

  function report(e: unknown, ctx: string): void {
    try {
      deps.onError?.(e, ctx);
    } catch {
      // nobody left to tell
    }
  }

  const context = (): LinkContext => {
    const h = deps.host();
    return {
      recording: h.recording,
      driveOpen: h.driveOpen,
      foreground,
      playerAvailable: h.playerAvailable,
      styleAllowsSound: deps.styleAllowsSound(),
      // Android has no call signal the app can rely on (plan §7.3): only iOS reports one.
      callActive: deps.platform === 'ios' && h.callActive,
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
    onChange: () => notify(),
    onError: (e, ctx) => report(e, `link ${ctx}`),
  });

  function state(): DashcamState {
    return { link: link.snapshot(), buzzerToo, btOptIn, loaded };
  }

  function notify(): void {
    const s = state();
    for (const fn of [...listeners]) {
      try {
        fn(s);
      } catch (e) {
        report(e, 'subscriber');
      }
    }
  }

  /** The 1 s tick while the app is in the foreground and a dashcam is paired (§7.3). */
  function syncRepeat(): void {
    const want = foreground && link.snapshot().paired !== null && !disposed;
    if (want && repeat === null) repeat = setRepeat(() => link.tick(), 1000);
    if (!want && repeat !== null) {
      clearRepeat(repeat);
      repeat = null;
    }
  }

  const appSub = deps.appState?.addEventListener('change', (s) => {
    foreground = s === 'active';
    syncRepeat();
    link.tick();
  });

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

  async function connectPaired(paired: PairedDashcam | null): Promise<void> {
    if (!paired) {
      transport?.setTarget(null);
      return;
    }
    const t = getTransport();
    if (!t) return;
    t.setTarget({ peripheralId: paired.peripheralId, dashcamId: paired.dashcamId });
    await t.start();
  }

  const ready = (async () => {
    try {
      const got = await settings.getMany([PAIRED_KEY, BUZZER_TOO_KEY, BT_OPT_IN_KEY]);
      const paired = asPaired(got[PAIRED_KEY]);
      buzzerToo = got[BUZZER_TOO_KEY] === true;
      btOptIn = got[BT_OPT_IN_KEY] === true;
      loaded = true;
      if (disposed) return;
      link.setPaired(paired);
      reattach();
      syncRepeat();
      if (paired) {
        await connectPaired(paired);
      } else {
        // Nobody to reconnect at launch: the transport attaches only when setup or the detector
        // asks. Without an opt-in either, the next launch does not start the BLE manager.
        if (!btOptIn) await writeDashpalEnabled(false).catch((e: unknown) => report(e, 'secure flag'));
        await writeSecureTarget(null).catch((e: unknown) => report(e, 'secure target'));
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
      await writeDashpalEnabled(true).catch((e: unknown) => report(e, 'secure flag'));
      notify();
    },

    async setBuzzerToo(on) {
      await settings.set(BUZZER_TOO_KEY, on);
      buzzerToo = on;
      notify();
      link.tick();
    },

    async pair(record) {
      await settings.set(PAIRED_KEY, record);
      await settings.set(BT_OPT_IN_KEY, true);
      btOptIn = true;
      await writeDashpalEnabled(true).catch((e: unknown) => report(e, 'secure flag'));
      await writeSecureTarget({ peripheralId: record.peripheralId, dashcamId: record.dashcamId }).catch((e: unknown) => report(e, 'secure target'));
      link.setPaired(record);
      syncRepeat();
      notify();
      await connectPaired(record);
    },

    async forget() {
      const paired = link.snapshot().paired;
      if (link.snapshot().lifecycle === 'connected') {
        await link.command(COMMAND.FORGET_ME).catch((e: unknown) => report(e, 'forget me'));
      }
      transport?.setTarget(null);
      if (paired && deps.platform === 'android') {
        const t = getTransport();
        await t?.removeBond(paired.peripheralId).catch((e: unknown) => report(e, 'removeBond'));
      }
      await settings.remove(PAIRED_KEY);
      await writeSecureTarget(null).catch((e: unknown) => report(e, 'secure target'));
      link.setPaired(null);
      syncRepeat();
      notify();
    },

    command: (op, arg) => link.command(op, arg),

    pruneUnattached: () => store.pruneUnattached(now() - UNATTACHED_KEEP_MS),

    restartLink: () => link.restart(),

    dispose() {
      disposed = true;
      appSub?.remove();
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

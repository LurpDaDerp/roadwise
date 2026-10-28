// The phone side of the DashPal link (plan §3.3–3.7, §7.3): pure TypeScript, time injected, driven
// by events. Nothing here touches Bluetooth: the transport hands it bytes and connection changes,
// and it hands back frames to write.
//
// `tick(now)` runs on every live drive row, every inbound frame, its own wake (`wake`, at the next
// thing due) and a 1 s timer while the app is in the foreground with the link up (Android pauses JS
// timers in the background unless a headless task runs; rows keep arriving during a drive). Each tick: STATE when due, ACKs batched ≤ 200 ms, TIME_PINGs due, RESUME
// when due, the 3 s staleness stop, alert repeats, the HELLO retry.
//
// Phone-first sound (BLE_PROTOCOL §1, §5): the dashcam routes every alert to its connected primary
// phone, which answers ALERT_ACK(1) and plays it, or ALERT_ACK(0). The phone can play when its player
// works, its alert style allows sound, no call is ringing or live (the host's signal and the audio
// probe), the media volume is at least a quarter, no headphones are the output, and no playback
// failed in the last 30 s, whether a drive is open or not and whether RoadWise is in front or not.
//
// STATE cadence. Active (RoadWise in front, a drive open or recording, or a DashPal alert sounding):
// STATE when ≥ 900 ms since the last one (≥ 450 ms while a DashPal critical sounds, inside the
// dashcam's 1.5 s quiet guard). With JS timers paused (`timersPaused`), every drive row sends STATE
// unless one went out in the last 300 ms (the row's timer pump or a dashcam frame just sent it): an
// Android row closes up to 1.5 s after its second, so rows come up to about 2.5 s apart, and the
// 900 ms gate could stretch the gap past the 3 s TTL. Quiet (otherwise): STATE only when its flags
// change, plus the first one after RESUME, so a phone in range in the background is not woken every
// 2 s by the dashcam's STATUS answering its STATE.
//
// Late ALERTs: a new routed ALERT handled more than 750 ms (tier 3: 400 ms) after its `uptime_ms`
// is answered ALERT_ACK(0) and shown only (the dashcam's buzzer has it), judged only on a clock
// offset measured on this connection in the last 10 minutes (the live offset: the best of that
// window's samples, ranked with a 100-ppm drift allowance). Without one the rule is skipped and TIME_PINGs go out at once; with no offset at
// all (no HELLO yet on this connection) the ALERT is answered ALERT_ACK(0). The boot's best offset
// (the lowest round trip ever, also from the stored row) still dates events.
//
// Android stays awake for an alert: `holdAwake(5 s)` runs first on every routed ALERT and on any
// frame (at most once a second) while a DashPal alert sounds.
//
// Connection sequence after the transport subscribed to TX (§3.3): COMMAND 7 hello → HELLO →
// TIME_PING ×3 (100 ms apart) → RESUME after the 3 echoes or 500 ms → STATE as above, TIME_PING ×3
// again every 10 min.
//
// Events (§3.6): persisted (INSERT OR IGNORE, a fresh v4 id) before they are acknowledged; the ACK
// and RESUME cursor is the lowest seq at or above the boot's floor not yet stored. An event that
// arrives while no drive is open is still stored (the cursor needs every seq) but marked ignored,
// as the frame arrives: only a drive that opens later with its start traced back before the event
// (an automatic drive at its confirmation) claims it (`facts.ts`). A HELLO whose
// boot id the phone knows but whose next_seq is below what it stored is a different boot (a new
// local generation). Inbound HELLO and EVENT frames are processed on one serial chain, so an event is
// never stored before its boot is known; alert frames are handled at once.
//
// The HUD's halo (drive-screen design §5.3-5.4): `held` is the worst continuous alert the table
// holds, null once no frame has come for 3 s (a silently dead link) and back with the next frame. A
// link that drops keeps its continuous alerts aside for `RESEND_WINDOW_MS`: the reconnect's re-send
// of the same alert (same boot, id, sound and tier) keeps its `since` and flashes as a resend.
import type { AlertPlayer } from '@/core/alerts/player';
import { knownSpeed } from '@/core/detectors/common';
import type { FeatureRow } from '@/core/engine/types';

import { createDashcamAlerts, STALE_MS, type ContinuingAlert, type DashcamVisual, type HeldAlert } from './alerts';
import { SYNCED_WITHIN_MS } from './episodes';
import type { PairedDashcam } from './keys';
import {
  COMMAND,
  DASHCAM_STATE,
  decodeTx,
  encodeRx,
  eventName,
  LOCAL_MIN_UNKNOWN,
  STATE_FLAG,
  STATE_TTL_DS,
  STATUS_FLAG,
  type AimFrame,
  type DashcamEventFrame,
  type DashcamInfo,
  type Hello,
  type RxFrame,
  type Status,
  type ViewStateFrame,
} from './protocol';
import { BOOT_GENERATION, type DashcamStore } from './store';

// ——— timing (plan §3.3, §3.5, §3.7, §7.3) ———

export const STATE_EVERY_MS = 900;
/** While a DashPal critical sounds: STATE at least this often (the dashcam's quiet guard is 1.5 s). */
export const STATE_EVERY_CRITICAL_MS = 450;
/**
 * With JS timers paused, a row sends STATE unless one went out this recently: the row's own timer
 * pump (the wake) or a dashcam frame may have sent it a moment before, and a row sends one STATE at
 * most. 0.3 s plus the longest row gap (about 2.5 s) stays inside the 3 s TTL.
 */
export const ROW_STATE_FLOOR_MS = 300;
export const ACK_BATCH_MS = 200;
export const PING_GAP_MS = 100;
export const PINGS_PER_SYNC = 3;
export const RESUME_AFTER_MS = 500;
export const RESYNC_EVERY_MS = 10 * 60_000;
/**
 * A routed ALERT the phone handles this long after the dashcam sent it (by the live clock offset)
 * is at or past the dashcam's ACK deadline (`device.ble_ack_ms`, 750 by default, counted from a
 * later moment): the buzzer has it, so the phone shows it and answers ACK(0) instead of playing it
 * a second time. Erring early only leaves the sound to the buzzer. These mirror the dashcam's
 * default deadlines (INFO carries no `ble_ack_ms`): with it set lower, a phone may start a warning
 * the buzzer took and the ALERT_FALLBACK behind it stops it within a round trip; set higher, the
 * phone gives up some alerts it could have played (the buzzer has them).
 */
export const LATE_ALERT_MS = 750;
/** The same for a critical (tier 3) alert: the dashcam waits `min(ble_ack_ms, 400)` for it. */
export const LATE_CRITICAL_ALERT_MS = 400;
/** The late rule uses an offset measured on this connection at most this long ago. */
export const LIVE_OFFSET_MAX_AGE_MS = 10 * 60_000;
/** The live offset's drift allowance (100 ppm): a newer sample may have a slightly longer round trip. */
export const OFFSET_DRIFT_MS_PER_S = 0.1;
/** After a playback failure the phone answers "cannot play" for this long (the buzzer plays). */
export const PLAYER_RETRY_MS = 30_000;
/** The media volume (0-1) below which a DashPal alert would not be heard: the buzzer plays it. */
export const AUDIBLE_VOLUME_MIN = 0.25;
/** Android: the wake lock a routed ALERT (or a frame while an alert sounds) holds, ms. */
export const HOLD_AWAKE_MS = 5000;
/** …renewed at most this often by frames while an alert sounds. */
export const HOLD_AWAKE_EVERY_MS = 1000;
/** A HELLO arriving later than this after its request gives no offset sample. */
export const HELLO_OFFSET_MAX_MS = 1000;
/** No HELLO this long after COMMAND 7: ask again. */
export const HELLO_RETRY_MS = 2000;
/** A store write failed: RESUME again after this long (the dashcam replays only on RESUME). */
export const RESYNC_AFTER_FAILURE_MS = 5000;
/** STATUS older than this does not count toward coverage. */
export const STATUS_FRESH_MS = 5000;
/** The phone sets speed_valid only from a drive row at most this old … */
export const ROW_FRESH_MS = 2000;
/** … whose speed accuracy is at most this (m/s). */
export const SPEED_ACC_MAX_MPS = 2;
/** Coverage counts a row as moving at or above this (5 mph). */
export const MOVING_MPS = 5 * 0.44704;
/** At drive end, wait this long at most for the phone to catch up to the dashcam. */
export const CATCH_UP_MS = 3000;
/** A reconnect this soon after a drop carries the dropped link's continuous alerts over (their `since`). */
export const RESEND_WINDOW_MS = 10_000;

export type BluetoothState = 'unknown' | 'resetting' | 'unsupported' | 'unauthorized' | 'off' | 'on' | 'turning_on' | 'turning_off';

/**
 * `needs_repair`: the dashcam says it does not know this phone, or does not speak link v3 (a soft
 * repair: the transport keeps retrying). `unverified`: the device at the paired address failed to
 * prove it is the DashPal three times in a row (retried too). Neither can be proven to come from
 * the real DashPal, so neither stops the phone; one verified session clears both.
 */
export type Lifecycle = 'unpaired' | 'idle' | 'unauthorized' | 'bluetooth_off' | 'connecting' | 'connected' | 'needs_repair' | 'unverified';

/**
 * `unknown_phone`: R_UNKNOWN_PHONE (forgotten, wiped, evicted, reflashed); `downgrade`: INFO below
 * link v3 (the firmware is older); `update_app`: INFO above link v3 (this app is older).
 */
export type RepairCause = 'unknown_phone' | 'downgrade' | 'update_app';

/** What the phone is doing, read live each tick. */
export interface LinkContext {
  /** a drive is recording (host status `recording`) */
  recording: boolean;
  /**
   * a drive is open: from the Start Drive tap until its finalize has finished (host status
   * `recording` or `finalizing`, not a dry run), so the drive-end catch-up still counts as in the
   * drive. An event arriving otherwise is stored as ignored.
   */
  driveOpen: boolean;
  /** the app is in the foreground (the STATE cadence) */
  foreground: boolean;
  /** the alert player can sound (the alert ports loaded; a failed sound is the link's own 30 s rule) */
  playerAvailable: boolean;
  /** the alert style is not vibration-only */
  styleAllowsSound: boolean;
  /** the drive host's call signal (iOS rows); the audio probe reads a call on both platforms */
  callActive: boolean;
  /** "Also beep on DashPal" */
  buzzerToo: boolean;
}

export interface LinkStatus {
  state: number;
  flags: number;
  fpsX10: number;
  tempC: number;
  bondCount: number;
  /** phone receipt time */
  at: number;
}

export interface LinkSnapshot {
  lifecycle: Lifecycle;
  paired: PairedDashcam | null;
  repairCause: RepairCause | null;
  /** the last STATUS of this connection; null when not connected */
  status: LinkStatus | null;
  /** the phone holds every event the dashcam announced (connected and resumed) */
  synced: boolean;
  /** the last ALERT start or level change, for the HUD and the banner */
  visual: DashcamVisual | null;
  /** the worst continuous alert held, for the HUD's halo; null with no link or 3 s after its last frame */
  held: HeldAlert | null;
  firmware: string | null;
  /** `ignored`: events stored as ignored (they arrived with no drive open); also in `stored` */
  counters: { badFrames: number; lateAlerts: number; stored: number; ignored: number; duplicates: number; orphanEvents: number; storeErrors: number };
}

/** What a DashPal alert would play into now (drive-sense `audioOutputState`). Null: unknown. */
export interface AudioOutputProbe {
  callActive: boolean;
  volume: number | null;
  headphones: boolean | null;
}

/** Nothing known about the output: no call, and nothing that blocks a sound. */
export const AUDIO_UNKNOWN: AudioOutputProbe = { callActive: false, volume: null, headphones: null };

/** The output would be heard: the media volume at least a quarter (or unknown) and no headphones. */
export function audible(p: AudioOutputProbe): boolean {
  return (p.volume === null || p.volume >= AUDIBLE_VOLUME_MIN) && p.headphones !== true;
}

/** A clock offset sample (epoch − uptime) taken on this connection, with its round trip and when. */
export interface LiveOffset {
  offsetMs: number;
  rttMs: number;
  at: number;
}

/** The most samples the live window holds (a bound only: pings come in bursts of 3, every 10 min). */
export const LIVE_OFFSET_WINDOW_MAX = 32;

/**
 * Sample `a` is at least as good as an older `b` now and stays so: its half round trip is at most
 * `b`'s plus the drift since `b` was taken (`OFFSET_DRIFT_MS_PER_S`, 100 ppm), and it ages out later.
 */
function beats(a: LiveOffset, b: LiveOffset): boolean {
  return a.rttMs / 2 <= b.rttMs / 2 + ((a.at - b.at) / 1000) * OFFSET_DRIFT_MS_PER_S;
}

/**
 * The live window after a new sample: the connection's samples of the last 10 min that may still be
 * the best one, oldest (and best) first. Samples older than 10 min leave; so does every sample the new
 * one beats (a newer sample with a slightly longer round trip replaces an old one, a much slower one
 * waits behind it and takes over when the old one ages out). The phone's clock gone back empties it.
 */
export function nextLiveOffset(w: readonly LiveOffset[], offsetMs: number, rttMs: number, now: number): LiveOffset[] {
  const sample: LiveOffset = { offsetMs, rttMs, at: now };
  const kept = w.some((l) => now < l.at) ? [] : w.filter((l) => now - l.at <= LIVE_OFFSET_MAX_AGE_MS);
  while (kept.length > 0 && beats(sample, kept[kept.length - 1]!)) kept.pop();
  if (kept.length >= LIVE_OFFSET_WINDOW_MAX) return kept;
  kept.push(sample);
  return kept;
}

/**
 * The live offset the late rule may use: the best window sample at most 10 min old, none when the
 * phone's clock went back since one was taken.
 */
export function usableLiveOffset(w: readonly LiveOffset[], now: number): LiveOffset | null {
  if (w.some((l) => now < l.at)) return null;
  return w.find((l) => now - l.at <= LIVE_OFFSET_MAX_AGE_MS) ?? null;
}

export interface LinkDeps {
  now(): number;
  store: Pick<DashcamStore, 'latestBoot' | 'ensureBoot' | 'offerOffset' | 'insertEvent' | 'cursor' | 'addCoverage'>;
  /** a fresh lowercase v4 uuid */
  newId(): string;
  /** Write one RX frame; `urgent` (ALERT_ACK) goes before anything queued. Rejects when not written. */
  write(bytes: number[], opts: { withResponse: boolean; urgent?: boolean }): Promise<void>;
  /** The app's alert player (shared with the phone engine's alerts). */
  player: AlertPlayer;
  context(): LinkContext;
  /** minutes since local midnight (0–1439) */
  localMinute(now: number): number;
  /** Ask for a tick at (or after) `at`; null: nothing due. Best effort: rows and frames tick too. */
  wake?(at: number | null): void;
  /** Sleep `ms` (the drive-end catch-up wait). */
  delay(ms: number): Promise<void>;
  /**
   * The audio output now (call, media volume, headphones). `fresh`: read it now (a new routed
   * ALERT); otherwise a read at most 500 ms old will do. Absent: unknown (never blocks a sound).
   */
  audioOutput?(fresh: boolean): AudioOutputProbe;
  /** Android: keep the CPU awake for `ms` (sync; a wake lock renewed by each call). */
  holdAwake?(ms: number): void;
  /**
   * JS timers do not fire now (Android in the background: the host pauses them unless a headless
   * task runs). The drive-end wait then does not wait at all, since a sleep might never end.
   */
  timersPaused?(): boolean;
  onChange?(): void;
  onPaired?(bondCount: number): void;
  onError?(e: unknown, ctx: string): void;
}

interface Session {
  dashcamId: string;
  info: DashcamInfo;
  upAt: number;
  /** when the last COMMAND 7 / RESUME went out (a HELLO answers it) */
  helloRequestAt: number | null;
  helloRetryAt: number | null;
  phase: 'hello' | 'syncing' | 'resumed';
  wireBoot: number | null;
  bootKey: number | null;
  /** the boot row is known (cursor and floor loaded) */
  bootReady: boolean;
  floor: number;
  cursor: number;
  /** the highest seq + 1 the dashcam has announced this boot */
  announcedNext: number;
  /** best clock offset (epoch − uptime) of this boot, in memory (event dating; may come from the stored row) */
  offsetMs: number | null;
  rttMs: number | null;
  /** this connection's recent offset samples, for the late rule (never the stored row) */
  live: LiveOffset[];
  pings: Map<number, number>;
  pingAt: number[];
  echoes: number;
  resumeDueAt: number | null;
  resyncAt: number | null;
  nextSyncAt: number;
  lastStateAt: number | null;
  /** the flags of the last STATE sent (the quiet cadence sends on a change) */
  lastStateFlags: number | null;
  lastFrameAt: number;
  ackDueAt: number | null;
  /** the cursor last sent in an ACK or STATE */
  ackSent: number;
  status: LinkStatus | null;
}

export interface DashcamLink {
  // transport side
  setBluetooth(state: BluetoothState): void;
  connecting(): void;
  /** INFO was read. True: go on (the session, then `linkUp`); false: another DashPal than the paired one (dropped, retried). */
  infoRead(info: DashcamInfo): boolean;
  linkUp(info: DashcamInfo): void;
  linkDown(): void;
  /**
   * The dashcam tables were emptied under a live connection (a sign-out or account wipe): forget
   * the boot, cursor and offset and handshake again on the same connection, so the boot row comes
   * back and RESUME replays from the floor. The alert table and the last STATUS stay.
   */
  restart(): void;
  needsRepair(cause: RepairCause): void;
  /** Three failed verifications in a row (the transport keeps retrying). */
  unverified(): void;
  frame(bytes: ArrayLike<number>): void;
  // app side
  setPaired(paired: PairedDashcam | null): void;
  tick(now?: number): void;
  /**
   * One drive row (host row hook): the context for STATE, a tick, and this row's coverage (written
   * to the drive; returned so the caller can keep the drive's totals). Null: nothing counted (no
   * dashcam paired, not recording, a dry run, a replay it cannot vouch for). `replay`: a journal row
   * taken in again, the past: it never reaches STATE (its speed is not the car's now) nor the sync
   * stamp, and it counts toward the coverage only when the link has been up with the dashcam watching
   * from at or before the row's second until now, unbroken (`watchingSince`): the traced-back start
   * of an automatic drive taken in at its confirmation, a gap filled a moment later. A backlog from
   * before a relaunch, or a drive taken in after it ended, counts nothing.
   */
  row(row: FeatureRow, drive: { clientTripId: string | null; recording: boolean; dryRun: boolean; replay?: boolean }): { moving: boolean; covered: boolean } | null;
  /**
   * Drive end: wait ≤ 3 s for the phone to catch up, then stamp the sync time on the drive, only when
   * its last live row is at most `SYNCED_WITHIN_MS` old (a drive taken in from its journal later, or
   * one whose rows stopped long ago, is not caught up at its end by a sync now).
   */
  beforeFinalize(clientTripId: string, opts?: { dryRun?: boolean }): Promise<void>;
  /** `withResponse` false: a write without response (the aiming picture's acknowledgements, COMMAND 11). */
  command(op: number, arg?: number, opts?: { withResponse?: boolean }): Promise<boolean>;
  /** The aiming stream's AIM and VIEW_STATE frames on this link (a paired phone's re-aim): until the returned function. */
  onViewFrames(fn: (f: AimFrame | ViewStateFrame) => void): () => void;
  /** The phone can play a DashPal alert now; `fresh`: with the audio output read now. */
  canPlay(fresh?: boolean): boolean;
  sendAlertAck(alertId: number, outcome: 0 | 1): void;
  playerUnavailable(): void;
  continuousAlertActive(): boolean;
  snapshot(): LinkSnapshot;
  subscribe(fn: (s: LinkSnapshot) => void): () => void;
  nextWakeAt(): number | null;
  /** Resolves once the persistence chain has drained (tests, drive end). */
  settled(): Promise<void>;
  dispose(): void;
}

const u16 = (n: number): number => ((n % 0x10000) + 0x10000) % 0x10000;

export function createDashcamLink(deps: LinkDeps): DashcamLink {
  const { store } = deps;
  let paired: PairedDashcam | null = null;
  let bt: BluetoothState = 'unknown';
  let connectingNow = false;
  let repairCause: RepairCause | null = null;
  let unverifiedNow = false;
  let session: Session | null = null;
  let visual: DashcamVisual | null = null;
  /** no frame for `STALE_MS` while an alert is held: `held` reads null until the next frame */
  let heldStale = false;
  /** the continuous alerts of the link that last dropped, for a reconnect's re-send */
  let dropped: { boot: number; at: number; entries: ContinuingAlert[] } | null = null;
  let firmware: string | null = null;
  let disposed = false;
  let pingSeq = 0;
  const counters = { badFrames: 0, lateAlerts: 0, stored: 0, ignored: 0, duplicates: 0, orphanEvents: 0, storeErrors: 0 };
  const listeners = new Set<(s: LinkSnapshot) => void>();
  /** the aiming stream's frames on this link (a re-aim: `onViewFrames`) */
  const viewListeners = new Set<(f: AimFrame | ViewStateFrame) => void>();
  /** the latest live drive row and when it arrived (a replayed row never) */
  let lastRow: { row: FeatureRow; at: number } | null = null;
  /** the drive the latest live recording row belonged to, and when it arrived */
  let lastLive: { clientTripId: string; at: number } | null = null;
  /**
   * Since when the link has been up with the dashcam watching on this phone's primary link (each
   * STATUS fresh, calibrating or monitoring, a live face, primary), unbroken; null when it is not.
   * Any drop, a STATUS that says otherwise or one more than `STATUS_FRESH_MS` after the last ends it.
   */
  let watchingSince: number | null = null;
  /** serial chain for HELLO/EVENT persistence */
  let chain: Promise<void> = Promise.resolve();
  /** serial chain for coverage writes (one per row) */
  let coverageChain: Promise<void> = Promise.resolve();
  let lastSnapshot: LinkSnapshot | null = null;
  /** the drive-end wait's sleeps, woken early by any tick or change */
  let napping: (() => void)[] = [];
  /** after a playback failure the phone answers "cannot play" until then */
  let failedUntil = 0;
  /** the last `holdAwake` call (frames while an alert sounds renew it at most once a second) */
  let lastHoldAt: number | null = null;

  function wakeNappers(): void {
    if (napping.length === 0) return;
    const ws = napping;
    napping = [];
    for (const w of ws) w();
  }

  /** Sleep ≤ `ms`, ending early on any tick (a frame, a row, a foreground change) or link change. */
  const nap = (ms: number): Promise<void> => Promise.race([deps.delay(ms), new Promise<void>((resolve) => napping.push(resolve))]);

  // The phone side of DashPal alerts: ACKs go out through this link, at once.
  const alerts = createDashcamAlerts({
    player: deps.player,
    now: () => deps.now(),
    sendAck: (alertId, outcome) => self.sendAlertAck(alertId, outcome),
    canPlay: (fresh) => canPlay(fresh === true),
    onVisual: (v) => {
      visual = v;
    },
    onChange: () => changed(),
    onError: (e) => report(e, 'alerts'),
  });

  function report(e: unknown, ctx: string): void {
    try {
      deps.onError?.(e, ctx);
    } catch {
      // nobody left to tell
    }
  }

  function lifecycle(): Lifecycle {
    if (!paired) return 'unpaired';
    if (bt === 'unauthorized') return 'unauthorized';
    if (session) return 'connected';
    if (repairCause) return 'needs_repair';
    if (unverifiedNow) return 'unverified';
    if (bt === 'off' || bt === 'turning_off' || bt === 'unsupported') return 'bluetooth_off';
    if (connectingNow) return 'connecting';
    return 'idle';
  }

  function synced(): boolean {
    const s = session;
    return s !== null && s.phase === 'resumed' && s.bootReady && s.cursor >= s.announcedNext;
  }

  function snapshot(): LinkSnapshot {
    return {
      lifecycle: lifecycle(),
      paired,
      repairCause,
      status: session?.status ?? null,
      synced: synced(),
      visual,
      held: session === null || heldStale ? null : alerts.held(),
      firmware,
      counters: { ...counters },
    };
  }

  /** What the reconnect's re-send of `f` inherits from the dropped link, if anything (taken once). */
  function inheritFor(s: Session, f: { alertId: number; sound: number; tier: number }, now: number): { since: number; level: number } | undefined {
    if (dropped === null) return undefined;
    if (now - dropped.at > RESEND_WINDOW_MS || now < dropped.at) {
      dropped = null;
      return undefined;
    }
    if (s.wireBoot !== dropped.boot || alerts.has(f.alertId)) return undefined;
    const i = dropped.entries.findIndex((e) => e.alertId === f.alertId && e.sound === f.sound && e.tier === f.tier);
    if (i < 0) return undefined;
    const [e] = dropped.entries.splice(i, 1);
    return { since: e!.since, level: e!.level };
  }

  function changed(): void {
    wakeNappers();
    const next = snapshot();
    const prev = lastSnapshot;
    lastSnapshot = next;
    if (prev && JSON.stringify(prev) === JSON.stringify(next)) return;
    try {
      deps.onChange?.();
    } catch (e) {
      report(e, 'onChange');
    }
    for (const fn of [...listeners]) {
      try {
        fn(next);
      } catch (e) {
        report(e, 'subscriber');
      }
    }
  }

  function holdAwake(now: number): void {
    lastHoldAt = now;
    if (!deps.holdAwake) return;
    try {
      deps.holdAwake(HOLD_AWAKE_MS);
    } catch (e) {
      report(e, 'holdAwake');
    }
  }

  function send(frame: RxFrame, opts: { withResponse: boolean; urgent?: boolean }): Promise<boolean> {
    return deps.write(encodeRx(frame), opts).then(
      () => true,
      (e: unknown) => {
        report(e, `write ${frame.type}`);
        return false;
      }
    );
  }

  // ——— can play, STATE (§3.2, §5) ———

  function probe(fresh: boolean): AudioOutputProbe {
    if (!deps.audioOutput) return AUDIO_UNKNOWN;
    try {
      return deps.audioOutput(fresh) ?? AUDIO_UNKNOWN;
    } catch (e) {
      report(e, 'audioOutput');
      return AUDIO_UNKNOWN;
    }
  }

  /** The phone can play a DashPal alert now (whether a drive is open or RoadWise in front or not). */
  function canPlayIn(c: LinkContext, fresh: boolean): boolean {
    if (!c.playerAvailable || !c.styleAllowsSound || c.callActive) return false;
    if (deps.now() < failedUntil) return false;
    const p = probe(fresh);
    return !p.callActive && audible(p);
  }

  function canPlay(fresh = false): boolean {
    let c: LinkContext;
    try {
      c = deps.context();
    } catch (e) {
      report(e, 'context');
      return false;
    }
    return canPlayIn(c, fresh);
  }

  /** STATE every 900 ms (450 ms during a critical) rather than on a change only (see the header). */
  function isActive(): boolean {
    try {
      const c = deps.context();
      return c.foreground || c.driveOpen || c.recording || alerts.playingAny();
    } catch (e) {
      report(e, 'context');
      return true;
    }
  }

  function stateFrame(now: number, s: Session): Extract<RxFrame, { type: 'STATE' }> {
    let c: LinkContext | null = null;
    try {
      c = deps.context();
    } catch (e) {
      report(e, 'context');
    }
    let flags = 0;
    if (c && canPlayIn(c, false)) flags |= STATE_FLAG.CAN_PLAY;
    if (c?.buzzerToo) flags |= STATE_FLAG.BUZZER_TOO;
    if (c?.recording) flags |= STATE_FLAG.DRIVE_ACTIVE;
    let speedCms = 0;
    const r = lastRow;
    if (c?.recording && r && now - r.at <= ROW_FRESH_MS && now >= r.at) {
      const mps = knownSpeed(r.row);
      const acc = r.row.speedAcc;
      if (mps !== null && Number.isFinite(acc) && acc >= 0 && acc <= SPEED_ACC_MAX_MPS) {
        flags |= STATE_FLAG.SPEED_VALID;
        speedCms = Math.min(0xffff, Math.round(mps * 100));
      }
    }
    let localMin = LOCAL_MIN_UNKNOWN;
    try {
      const m = deps.localMinute(now);
      if (Number.isInteger(m) && m >= 0 && m <= 1439) localMin = m;
    } catch (e) {
      report(e, 'localMinute');
    }
    return {
      type: 'STATE',
      flags,
      ttlDs: STATE_TTL_DS,
      speedCms,
      localMin,
      bootId: s.wireBoot ?? 0,
      ackSeq: s.bootReady ? s.cursor : 0,
    };
  }

  // ——— ticking ———

  function timersPaused(): boolean {
    try {
      return deps.timersPaused?.() ?? false;
    } catch (e) {
      report(e, 'timersPaused');
      return false;
    }
  }

  function tick(nowArg?: number): void {
    tickAt(nowArg ?? deps.now(), false);
  }

  /** One tick; `fromRow`: a drive row's, which sends STATE at once while timers are paused. */
  function tickAt(now: number, fromRow: boolean): void {
    wakeNappers();
    if (disposed) return;
    const s = session;
    if (s) {
      // HELLO retry: COMMAND 7 got no answer.
      if (s.phase === 'hello' && s.helloRetryAt !== null && now >= s.helloRetryAt) requestHello(s, now);
      // TIME_PINGs due.
      while (s.pingAt.length > 0 && s.pingAt[0]! <= now) {
        s.pingAt.shift();
        sendPing(s, now);
      }
      // The 10-minute resync.
      if (s.phase === 'resumed' && now >= s.nextSyncAt && s.pingAt.length === 0) {
        s.nextSyncAt = now + RESYNC_EVERY_MS;
        schedulePings(s, now);
      }
      // RESUME after three echoes or 500 ms, once the boot is known.
      if (s.phase === 'syncing' && s.bootReady && s.resumeDueAt !== null && (s.echoes >= PINGS_PER_SYNC || now >= s.resumeDueAt)) {
        sendResume(s, now);
      }
      // A failed store write: ask the dashcam to replay from the cursor.
      if (s.phase === 'resumed' && s.resyncAt !== null && now >= s.resyncAt && s.bootReady) {
        s.resyncAt = null;
        sendResume(s, now);
      }
      // STATE once resumed (it carries the ACK too): active, every 900 ms (450 ms during a critical)
      // and once per row while timers are paused; quiet, when its flags change. The first one always.
      if (s.phase === 'resumed') {
        let frame: Extract<RxFrame, { type: 'STATE' }> | null = null;
        let due = s.lastStateAt === null;
        if (!due && s.lastStateAt !== null) {
          if (isActive()) {
            const every = alerts.playingCritical() ? STATE_EVERY_CRITICAL_MS : STATE_EVERY_MS;
            due = now - s.lastStateAt >= every || now < s.lastStateAt || (fromRow && now - s.lastStateAt >= ROW_STATE_FLOOR_MS && timersPaused());
          } else {
            frame = stateFrame(now, s);
            due = frame.flags !== s.lastStateFlags;
          }
        }
        if (due) {
          frame ??= stateFrame(now, s);
          s.lastStateAt = now;
          s.lastStateFlags = frame.flags;
          if (s.bootReady) {
            s.ackSent = frame.ackSeq;
            if (s.ackSent >= s.cursor) s.ackDueAt = null;
          }
          void send(frame, { withResponse: false });
        }
      }
      // Batched ACK.
      if (s.ackDueAt !== null && now >= s.ackDueAt && s.bootReady && s.wireBoot !== null) {
        s.ackDueAt = null;
        if (s.cursor !== s.ackSent) {
          s.ackSent = s.cursor;
          void send({ type: 'ACK', bootId: s.wireBoot, ackSeq: s.cursor }, { withResponse: false });
        }
      }
      // 3 s with no frame: the phone stops a continuous alert (and owes ALERT_ACK(0)).
      if (alerts.playingAny() && now - s.lastFrameAt > STALE_MS) alerts.stale();
      // ...and the halo lets go of the held alert until the next frame.
      const stale = alerts.held() !== null && now - s.lastFrameAt > STALE_MS;
      if (stale !== heldStale) {
        heldStale = stale;
        changed();
      }
    }
    alerts.tick(now);
    armWake(now);
  }

  function nextWakeAt(): number | null {
    const s = session;
    const times: number[] = [];
    if (s) {
      if (s.phase === 'hello' && s.helloRetryAt !== null) times.push(s.helloRetryAt);
      if (s.pingAt.length > 0) times.push(s.pingAt[0]!);
      // Only what `tick` can act on: RESUME, a resync and an ACK wait for the boot row (the hello
      // chain ticks once it is known). Waking for them earlier would re-arm a zero-delay timer for
      // as long as the database is slow.
      if (s.phase === 'syncing' && s.resumeDueAt !== null && s.bootReady) times.push(s.resumeDueAt);
      if (s.phase === 'resumed' && s.resyncAt !== null && s.bootReady) times.push(s.resyncAt);
      if (s.phase === 'resumed') {
        // Quiet: no STATE is ever due by time (a flags change comes with a tick of its own).
        if (s.lastStateAt === null || isActive()) times.push((s.lastStateAt ?? 0) + (alerts.playingCritical() ? STATE_EVERY_CRITICAL_MS : STATE_EVERY_MS));
        times.push(s.nextSyncAt);
      }
      if (s.ackDueAt !== null && s.bootReady && s.wireBoot !== null) times.push(s.ackDueAt);
      if (alerts.playingAny() || (!heldStale && alerts.held() !== null)) times.push(s.lastFrameAt + STALE_MS + 1);
    }
    const a = alerts.nextDueAt();
    if (a !== null) times.push(a);
    return times.length === 0 ? null : Math.min(...times);
  }

  function armWake(now: number): void {
    if (!deps.wake) return;
    const at = nextWakeAt();
    try {
      deps.wake(at === null ? null : Math.max(at, now));
    } catch (e) {
      report(e, 'wake');
    }
  }

  // ——— handshake ———

  function requestHello(s: Session, now: number): void {
    s.helloRequestAt = now;
    s.helloRetryAt = now + HELLO_RETRY_MS;
    void send({ type: 'COMMAND', op: COMMAND.HELLO, arg: 0 }, { withResponse: true });
  }

  function schedulePings(s: Session, now: number): void {
    s.pingAt = [];
    for (let i = 0; i < PINGS_PER_SYNC; i++) s.pingAt.push(now + i * PING_GAP_MS);
    while (s.pingAt.length > 0 && s.pingAt[0]! <= now) {
      s.pingAt.shift();
      sendPing(s, now);
    }
  }

  function sendPing(s: Session, now: number): void {
    pingSeq = u16(pingSeq + 1);
    const reqId = pingSeq;
    s.pings.set(reqId, now);
    // Bounded: a ping never answered is forgotten after a few more.
    if (s.pings.size > 16) {
      const oldest = s.pings.keys().next().value;
      if (oldest !== undefined) s.pings.delete(oldest);
    }
    void send({ type: 'TIME_PING', reqId, epochMs: now }, { withResponse: false });
  }

  function sendResume(s: Session, now: number): void {
    if (s.wireBoot === null) return;
    s.phase = 'resumed';
    s.resumeDueAt = null;
    s.helloRequestAt = now;
    s.nextSyncAt = now + RESYNC_EVERY_MS;
    const frame: RxFrame = { type: 'RESUME', bootId: s.wireBoot, nextSeq: s.cursor };
    void send(frame, { withResponse: true }).then((ok) => {
      // Not written: try again shortly (the dashcam withholds live events until a RESUME).
      if (!ok && session === s) s.resyncAt = deps.now() + PING_GAP_MS * 5;
    });
  }

  function offerLive(s: Session, offsetMs: number, rttMs: number, now: number): void {
    s.live = nextLiveOffset(s.live, offsetMs, rttMs, now);
  }

  function liveOffset(s: Session, now: number): LiveOffset | null {
    return usableLiveOffset(s.live, now);
  }

  /** An offset sample (epoch − uptime) with its round trip: kept when it beats the best so far. */
  function offerOffset(s: Session, offsetMs: number, rttMs: number): void {
    if (s.rttMs === null || rttMs < s.rttMs) {
      s.offsetMs = offsetMs;
      s.rttMs = rttMs;
    }
    const bootKey = s.bootKey;
    const dashcamId = s.dashcamId;
    if (bootKey === null) return;
    enqueue(async () => {
      await store.offerOffset(dashcamId, bootKey, offsetMs, rttMs);
    }, 'offset');
  }

  function enqueue(fn: () => Promise<void>, what: string): void {
    chain = chain.then(fn).catch((e: unknown) => {
      counters.storeErrors += 1;
      report(e, what);
      const s = session;
      if (s && s.phase === 'resumed') s.resyncAt = deps.now() + RESYNC_AFTER_FAILURE_MS;
    });
  }

  function onHello(h: Hello, now: number): void {
    const s = session;
    if (!s) return;
    const sameBoot = s.wireBoot === h.bootId;
    // A dashcam that rebooted since the drop: its alerts are new.
    if (dropped !== null && dropped.boot !== h.bootId) dropped = null;
    if (s.wireBoot !== null && !sameBoot) {
      // A new boot while connected: the phone's alert table goes, the handshake starts over.
      dropped = null;
      alerts.clear();
      s.phase = 'hello';
      s.bootKey = null;
      s.bootReady = false;
      s.offsetMs = null;
      s.rttMs = null;
      s.live = [];
      s.announcedNext = 0;
    }
    // An offset sample when the HELLO answers a request within 1 s. Its error can be the whole
    // round trip (`receive − uptime` carries all of the way back), a TIME_PING's at most half of
    // its round trip; samples are ranked by the round trip a ping with the same error bound would
    // have, so the HELLO's counts double and a ping over the same link replaces it.
    let sample: { offset: number; rtt: number } | null = null;
    if (s.helloRequestAt !== null && now - s.helloRequestAt <= HELLO_OFFSET_MAX_MS && now >= s.helloRequestAt) {
      sample = { offset: now - h.uptimeMs, rtt: 2 * (now - s.helloRequestAt) };
    }
    s.helloRequestAt = null;
    s.helloRetryAt = null;
    if (sample) offerLive(s, sample.offset, sample.rtt, now);

    if (sameBoot && s.phase !== 'hello') {
      // The answer to our RESUME (or a second hello): no new handshake.
      s.announcedNext = Math.max(s.announcedNext, h.nextSeq);
      if (sample) offerOffset(s, sample.offset, sample.rtt);
      const dashcamId = s.dashcamId;
      enqueue(async () => {
        if (session !== s || s.bootKey === null) return;
        const row = await store.ensureBoot(dashcamId, s.bootKey, h.oldestSeq);
        s.floor = row.floorSeq;
        s.cursor = await store.cursor(dashcamId, s.bootKey, s.floor);
        markAck(s);
      }, 'hello (same boot)');
      return;
    }

    // The handshake: time sync, then RESUME once the boot is known.
    s.wireBoot = h.bootId;
    s.announcedNext = h.nextSeq;
    s.phase = 'syncing';
    s.echoes = 0;
    s.pings.clear();
    s.resumeDueAt = now + RESUME_AFTER_MS;
    schedulePings(s, now);
    const dashcamId = s.dashcamId;
    enqueue(async () => {
      if (session !== s) return;
      const known = await store.latestBoot(dashcamId, h.bootId);
      // A stored boot with this id but more events than the dashcam says it ever made: another boot
      // that drew the same random id (defence in depth). A new local generation keeps both.
      let bootKey = known?.bootKey ?? h.bootId;
      if (known && h.nextSeq < known.maxSeq + 1) bootKey = known.bootKey + BOOT_GENERATION;
      const row = await store.ensureBoot(dashcamId, bootKey, h.oldestSeq);
      if (session !== s || s.wireBoot !== h.bootId) return;
      s.bootKey = bootKey;
      s.floor = row.floorSeq;
      if (row.offsetMs !== null && row.rttMs !== null && (s.rttMs === null || row.rttMs < s.rttMs)) {
        s.offsetMs = row.offsetMs;
        s.rttMs = row.rttMs;
      }
      if (s.offsetMs !== null && s.rttMs !== null) await store.offerOffset(dashcamId, bootKey, s.offsetMs, s.rttMs);
      s.cursor = await store.cursor(dashcamId, bootKey, s.floor);
      s.ackSent = -1;
      s.bootReady = true;
      tick();
    }, 'hello');
    if (sample) {
      s.offsetMs = sample.offset;
      s.rttMs = sample.rtt;
    }
  }

  function freshSession(info: DashcamInfo, now: number): Session {
    return {
      dashcamId: info.dashcamId,
      info,
      upAt: now,
      helloRequestAt: null,
      helloRetryAt: null,
      phase: 'hello',
      wireBoot: null,
      bootKey: null,
      bootReady: false,
      floor: 0,
      cursor: 0,
      announcedNext: 0,
      offsetMs: null,
      rttMs: null,
      live: [],
      pings: new Map(),
      pingAt: [],
      echoes: 0,
      resumeDueAt: null,
      resyncAt: null,
      nextSyncAt: now + RESYNC_EVERY_MS,
      lastStateAt: null,
      lastStateFlags: null,
      lastFrameAt: now,
      ackDueAt: null,
      ackSent: -1,
      status: null,
    };
  }

  function markAck(s: Session): void {
    if (s.cursor !== s.ackSent && s.ackDueAt === null) s.ackDueAt = deps.now() + ACK_BATCH_MS;
  }

  function onEvent(e: DashcamEventFrame, now: number): void {
    const s = session;
    if (!s) return;
    s.announcedNext = Math.max(s.announcedNext, e.seq + 1);
    const dashcamId = s.dashcamId;
    // Read as the frame arrives, not when the chain gets to it: a drive that closes meanwhile does
    // not make an in-drive event ignored, nor one opening an earlier event in-drive. Unknown (the
    // context threw): not ignored, and the finalize window alone decides.
    let ignored = false;
    try {
      ignored = !deps.context().driveOpen;
    } catch (err) {
      report(err, 'context');
    }
    enqueue(async () => {
      if (session !== s) return;
      const bootKey = s.bootKey;
      if (bootKey === null || !s.bootReady) {
        counters.orphanEvents += 1;
        return;
      }
      const offset = s.offsetMs;
      const atMs = offset === null ? null : offset + e.tMs;
      const inserted = await store.insertEvent({
        dashcamId,
        bootKey,
        seq: e.seq,
        id: deps.newId().toLowerCase(),
        ev: e.ev,
        name: eventName(e.ev),
        tier: e.tier,
        audible: e.audible,
        detail: e.detail,
        tMs: e.tMs,
        durDs: e.durDs,
        value: e.valueX10 / 10,
        atMs,
        startedAtMs: atMs === null ? null : atMs - e.durDs * 100,
        receivedAtMs: now,
        ignored,
      });
      if (inserted) {
        counters.stored += 1;
        if (ignored) counters.ignored += 1;
      } else {
        counters.duplicates += 1;
      }
      if (e.seq >= s.cursor) s.cursor = await store.cursor(dashcamId, bootKey, s.floor);
      markAck(s);
      changed();
      armWake(deps.now());
    }, 'event');
  }

  /** A STATUS saying the dashcam watches a live face for this phone (what a covered second needs). */
  const watching = (st: Pick<LinkStatus, 'state' | 'flags'>): boolean =>
    (st.state === DASHCAM_STATE.CALIBRATING || st.state === DASHCAM_STATE.MONITORING) && (st.flags & STATUS_FLAG.LIVE) !== 0 && (st.flags & STATUS_FLAG.PRIMARY) !== 0;

  function onStatus(st: Status, now: number): void {
    const s = session;
    if (!s) return;
    const prev = s.status;
    s.status = { state: st.state, flags: st.flags, fpsX10: st.fpsX10, tempC: st.tempC, bondCount: st.bondCount, at: now };
    // A gap in the STATUSes is a gap in the watch, whatever came before and after it.
    if (prev === null || now - prev.at > STATUS_FRESH_MS || now < prev.at) watchingSince = null;
    if (!watching(s.status)) watchingSince = null;
    else watchingSince ??= now;
  }

  /** `watchingSince`, while it still holds now (the last STATUS fresh); else null. */
  function watchedSince(now: number): number | null {
    const st = session?.status ?? null;
    if (watchingSince === null || st === null || now - st.at > STATUS_FRESH_MS || now < st.at) {
      watchingSince = null;
      return null;
    }
    return watchingSince;
  }

  // ——— the link ———

  const self: DashcamLink = {
    setBluetooth(state) {
      bt = state;
      if (state !== 'on' && state !== 'unknown' && state !== 'resetting' && state !== 'turning_on') connectingNow = false;
      changed();
    },

    connecting() {
      connectingNow = true;
      changed();
    },

    infoRead(info) {
      firmware = `dms-core ${info.fwMajor}.${info.fwMinor}`;
      // No pairing read yet (the runtime is still loading): the transport already checked the INFO
      // against its target; the link takes the link-up once it knows its pairing (a re-attach).
      if (!paired) return true;
      // Another DashPal than the paired one (the transport's target changed under it): not this link.
      if (info.dashcamId !== paired.dashcamId) return false;
      changed();
      return true;
    },

    linkUp(info) {
      if (disposed || !paired) return;
      // A connect clears the alert table (§3.5).
      alerts.clear();
      const now = deps.now();
      connectingNow = false;
      repairCause = null;
      unverifiedNow = false;
      session = freshSession(info, now);
      watchingSince = null;
      // CCCDs of bonded peers are restored silently: subscribing alone does not produce a HELLO.
      requestHello(session, now);
      changed();
      armWake(now);
    },

    linkDown() {
      watchingSince = null;
      const s = session;
      const entries = alerts.continuing();
      dropped = s !== null && s.wireBoot !== null && entries.length > 0 ? { boot: s.wireBoot, at: deps.now(), entries } : null;
      session = null;
      connectingNow = false;
      heldStale = false;
      alerts.clear();
      changed();
    },

    restart() {
      const old = session;
      if (disposed || !old) return;
      const now = deps.now();
      const s = freshSession(old.info, now);
      s.upAt = old.upAt;
      s.lastFrameAt = old.lastFrameAt;
      s.lastStateAt = old.lastStateAt;
      s.status = old.status;
      // Work queued for the old session sees `session !== s` and stops.
      session = s;
      requestHello(s, now);
      changed();
      armWake(now);
    },

    unverified() {
      unverifiedNow = true;
      changed();
    },

    needsRepair(cause) {
      repairCause = cause;
      session = null;
      watchingSince = null;
      connectingNow = false;
      dropped = null;
      heldStale = false;
      alerts.clear();
      changed();
    },

    frame(bytes) {
      if (disposed) return;
      const now = deps.now();
      const s = session;
      const decoded = decodeTx(bytes);
      if (!decoded.ok) {
        counters.badFrames += 1;
        if (s) {
          s.lastFrameAt = now;
          heldStale = false;
        }
        changed();
        return;
      }
      if (!s) return;
      s.lastFrameAt = now;
      heldStale = false;
      const f = decoded.frame;
      // Android: the CPU stays up from a routed ALERT until 5 s after the last frame of a sounding
      // alert, before anything else is done with the frame (the ACK and the first play included).
      if ((f.type === 'ALERT' && f.route === 1) || (alerts.playingAny() && (lastHoldAt === null || now - lastHoldAt >= HOLD_AWAKE_EVERY_MS || now < lastHoldAt))) {
        holdAwake(now);
      }
      switch (f.type) {
        case 'HELLO':
          onHello(f, now);
          break;
        case 'STATUS':
          onStatus(f, now);
          break;
        case 'EVENT':
          onEvent(f, now);
          break;
        case 'ALERT': {
          const inherit = inheritFor(s, f, now);
          if (f.route === 1 && !alerts.has(f.alertId)) {
            // No clock offset at all on this connection (no HELLO yet, a relaunched app): it can
            // never be judged in time, so the buzzer takes it at once.
            let late = s.offsetMs === null;
            if (!late) {
              const lo = liveOffset(s, now);
              if (lo === null) {
                // No live offset: the dashcam's deadline decides; measure again on this wake.
                s.nextSyncAt = now;
              } else {
                late = now - (lo.offsetMs + f.uptimeMs) > (f.tier >= 3 ? LATE_CRITICAL_ALERT_MS : LATE_ALERT_MS);
              }
            }
            if (late) {
              counters.lateAlerts += 1;
              alerts.onAlert({ ...f, route: 0 }, inherit);
              self.sendAlertAck(f.alertId, 0);
              break;
            }
          }
          const ack = alerts.onAlert(f, inherit);
          // ALERT_ACK before playback starts (the first play runs after this returns).
          if (ack !== null) self.sendAlertAck(f.alertId, ack);
          break;
        }
        case 'ALERT_STOP':
          alerts.onStop(f.alertId);
          break;
        case 'ALERT_FALLBACK':
          alerts.onFallback(f.alertId, f.cause);
          break;
        case 'TIME_ECHO': {
          const sentAt = s.pings.get(f.reqId);
          if (sentAt === undefined || now < sentAt) break;
          s.pings.delete(f.reqId);
          s.echoes += 1;
          offerOffset(s, Math.round((sentAt + now) / 2) - f.uptimeMs, now - sentAt);
          offerLive(s, Math.round((sentAt + now) / 2) - f.uptimeMs, now - sentAt, now);
          break;
        }
        case 'PAIRED':
          try {
            deps.onPaired?.(f.bondCount);
          } catch (e) {
            report(e, 'onPaired');
          }
          break;
        case 'AIM':
        case 'VIEW_STATE':
          for (const fn of [...viewListeners]) {
            try {
              fn(f);
            } catch (e) {
              report(e, 'view frames');
            }
          }
          break;
      }
      tick(now);
      changed();
    },

    setPaired(next) {
      const was = paired;
      const before = was?.dashcamId ?? null;
      paired = next;
      if (next !== null && was !== null && next.dashcamId === before && next.pairedAt !== was.pairedAt) {
        // A new pairing with the same DashPal (Set up again): the old key's repair is settled.
        repairCause = null;
        unverifiedNow = false;
      }
      if ((next?.dashcamId ?? null) !== before) {
        repairCause = null;
        unverifiedNow = false;
        session = null;
        watchingSince = null;
        dropped = null;
        heldStale = false;
        alerts.clear();
      }
      changed();
    },

    tick,

    row(row, drive) {
      if (drive.replay === true) {
        // The past (a journal row taken in again): never STATE's speed, never the sync stamp. Covered
        // only when the dashcam has been watching for this phone, unbroken, since at or before its second.
        if (!paired || !drive.recording || drive.dryRun || drive.clientTripId === null) return null;
        const since = watchedSince(deps.now());
        if (since === null || !(row.ts >= since)) return null;
        const speed = knownSpeed(row);
        const moving = speed !== null && speed >= MOVING_MPS;
        const tripId = drive.clientTripId;
        coverageChain = coverageChain.then(() => store.addCoverage(tripId, moving ? 1 : 0, moving ? 1 : 0, null)).catch((e: unknown) => report(e, 'coverage'));
        return { moving, covered: moving };
      }
      const now = deps.now();
      lastRow = { row, at: now };
      if (drive.recording && drive.clientTripId !== null) lastLive = { clientTripId: drive.clientTripId, at: now };
      tickAt(now, true);
      if (!paired || !drive.recording || drive.dryRun || drive.clientTripId === null) return null;
      const s = session;
      const speed = knownSpeed(row);
      const moving = speed !== null && speed >= MOVING_MPS;
      const st = s?.status ?? null;
      const covered = moving && s !== null && st !== null && now - st.at <= STATUS_FRESH_MS && watching(st);
      const syncedAt = synced() ? now : null;
      const tripId = drive.clientTripId;
      coverageChain = coverageChain
        .then(() => store.addCoverage(tripId, moving ? 1 : 0, covered ? 1 : 0, syncedAt))
        .catch((e: unknown) => report(e, 'coverage'));
      return { moving, covered };
    },

    async beforeFinalize(clientTripId, opts = {}) {
      if (opts.dryRun || !paired) return;
      const deadline = deps.now() + CATCH_UP_MS;
      // Every sleep also ends on a tick, so the deadline and the timer check run on each wake (a
      // foreground app moving to the background ticks the link).
      const waiting = (): boolean => deps.now() < deadline && !timersPaused();
      // The persistence chain, but never past the deadline (a long replay keeps going on its own).
      const drained = async (): Promise<void> => {
        let done = false;
        const settledChain = chain.then(() => {
          done = true;
        });
        while (!done && waiting()) await Promise.race([settledChain, nap(50)]);
      };
      while (session && session.phase !== 'resumed' && waiting()) await nap(100);
      if (session) await drained();
      while (session && !synced() && waiting()) {
        await nap(100);
        await drained();
      }
      await coverageChain;
      // Caught up now says nothing of a drive whose last live second is long gone.
      const live = lastLive !== null && lastLive.clientTripId === clientTripId ? lastLive.at : null;
      const recent = live !== null && deps.now() - live <= SYNCED_WITHIN_MS && deps.now() >= live;
      if (recent && synced()) {
        try {
          await store.addCoverage(clientTripId, 0, 0, deps.now());
        } catch (e) {
          report(e, 'coverage (drive end)');
        }
      }
    },

    async command(op, arg = 0, opts = {}) {
      if (!session) return false;
      return send({ type: 'COMMAND', op, arg }, { withResponse: opts.withResponse !== false });
    },

    onViewFrames(fn) {
      viewListeners.add(fn);
      return () => {
        viewListeners.delete(fn);
      };
    },

    canPlay,

    sendAlertAck(alertId, outcome) {
      if (!session) return;
      void send({ type: 'ALERT_ACK', alertId, outcome }, { withResponse: true, urgent: true });
    },

    playerUnavailable() {
      // A sound failed: "cannot play" for 30 s (ALERT_ACK(0) at once, the buzzer plays), then retry.
      failedUntil = deps.now() + PLAYER_RETRY_MS;
      alerts.playerUnavailable();
    },

    continuousAlertActive: () => alerts.continuousActive(),

    snapshot,

    subscribe(fn) {
      listeners.add(fn);
      return () => {
        listeners.delete(fn);
      };
    },

    nextWakeAt,

    async settled() {
      let seen: Promise<void>;
      do {
        seen = chain;
        await seen;
        await coverageChain;
      } while (seen !== chain);
      await alerts.settled();
    },

    dispose() {
      disposed = true;
      session = null;
      watchingSince = null;
      dropped = null;
      wakeNappers();
      listeners.clear();
      alerts.clear();
      deps.wake?.(null);
    },
  };

  return self;
}

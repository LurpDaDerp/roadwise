// The phone side of the DashPal link (plan §3.3–3.7, §7.3): pure TypeScript, time injected, driven
// by events. Nothing here touches Bluetooth: the transport hands it bytes and connection changes,
// and it hands back frames to write.
//
// `tick(now)` runs on every drive row, every inbound frame and a 1 s timer while the app is in the
// foreground (Android pauses JS timers in the background unless a headless task runs; rows keep
// arriving during a drive). Each tick: STATE if ≥ 900 ms since the last one, ACKs batched ≤ 200 ms,
// TIME_PINGs due, RESUME when due, the 3 s staleness stop, alert repeats, the HELLO retry.
//
// Connection sequence after the transport subscribed to TX (§3.3): COMMAND 7 hello → HELLO →
// TIME_PING ×3 (100 ms apart) → RESUME after the 3 echoes or 500 ms → STATE every second, TIME_PING
// ×3 again every 10 min.
//
// Events (§3.6): persisted (INSERT OR IGNORE, a fresh v4 id) before they are acknowledged; the ACK
// and RESUME cursor is the lowest seq at or above the boot's floor not yet stored. A HELLO whose
// boot id the phone knows but whose next_seq is below what it stored is a different boot (a new
// local generation). Inbound HELLO and EVENT frames are processed on one serial chain, so an event is
// never stored before its boot is known; alert frames are handled at once.
import type { AlertPlayer } from '@/core/alerts/player';
import { knownSpeed } from '@/core/detectors/common';
import type { FeatureRow } from '@/core/engine/types';

import { createDashcamAlerts, STALE_MS, type DashcamVisual } from './alerts';
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
  type DashcamEventFrame,
  type DashcamInfo,
  type Hello,
  type RxFrame,
  type Status,
} from './protocol';
import { BOOT_GENERATION, type DashcamStore } from './store';

// ——— timing (plan §3.3, §3.5, §3.7, §7.3) ———

export const STATE_EVERY_MS = 900;
export const ACK_BATCH_MS = 200;
export const PING_GAP_MS = 100;
export const PINGS_PER_SYNC = 3;
export const RESUME_AFTER_MS = 500;
export const RESYNC_EVERY_MS = 10 * 60_000;
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

export type BluetoothState = 'unknown' | 'resetting' | 'unsupported' | 'unauthorized' | 'off' | 'on' | 'turning_on' | 'turning_off';

export type Lifecycle = 'unpaired' | 'idle' | 'unauthorized' | 'bluetooth_off' | 'connecting' | 'connected' | 'needs_repair';

export type RepairCause = 'peer_not_bonded' | 'bond_lost' | 'wrong_dashcam' | 'reflashed';

/** What the phone is doing, read live each tick. */
export interface LinkContext {
  /** a drive is recording (host status `recording`) */
  recording: boolean;
  /** the app is in the foreground */
  foreground: boolean;
  /** the alert player can sound (host `alertsAvailable`) */
  playerAvailable: boolean;
  /** the alert style is not vibration-only */
  styleAllowsSound: boolean;
  /** a call is active (iOS; Android has no signal and reports false) */
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
  firmware: string | null;
  counters: { badFrames: number; stored: number; duplicates: number; orphanEvents: number; storeErrors: number };
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
  /** best clock offset (epoch − uptime) of this boot, in memory */
  offsetMs: number | null;
  rttMs: number | null;
  pings: Map<number, number>;
  pingAt: number[];
  echoes: number;
  resumeDueAt: number | null;
  resyncAt: number | null;
  nextSyncAt: number;
  lastStateAt: number | null;
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
  /** INFO was read. True: go on (subscribe, then `linkUp`); false: disconnect, no auto-reconnect. */
  infoRead(info: DashcamInfo): boolean;
  linkUp(info: DashcamInfo): void;
  linkDown(): void;
  needsRepair(cause: RepairCause): void;
  frame(bytes: ArrayLike<number>): void;
  // app side
  setPaired(paired: PairedDashcam | null): void;
  tick(now?: number): void;
  /**
   * One drive row (host row hook): the context for STATE, a tick, and this row's coverage (written
   * to the drive; returned so the caller can keep the drive's totals). Null: nothing counted (no
   * dashcam paired, not recording, a dry run).
   */
  row(row: FeatureRow, drive: { clientTripId: string | null; recording: boolean; dryRun: boolean }): { moving: boolean; covered: boolean } | null;
  /** Drive end: wait ≤ 3 s for the phone to catch up, then stamp the sync time on the drive. */
  beforeFinalize(clientTripId: string, opts?: { dryRun?: boolean }): Promise<void>;
  command(op: number, arg?: number): Promise<boolean>;
  canPlay(): boolean;
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
  let session: Session | null = null;
  let visual: DashcamVisual | null = null;
  let firmware: string | null = null;
  let disposed = false;
  let pingSeq = 0;
  const counters = { badFrames: 0, stored: 0, duplicates: 0, orphanEvents: 0, storeErrors: 0 };
  const listeners = new Set<(s: LinkSnapshot) => void>();
  /** the latest drive row and when it arrived */
  let lastRow: { row: FeatureRow; at: number } | null = null;
  /** serial chain for HELLO/EVENT persistence */
  let chain: Promise<void> = Promise.resolve();
  /** serial chain for coverage writes (one per row) */
  let coverageChain: Promise<void> = Promise.resolve();
  let lastSnapshot: LinkSnapshot | null = null;

  // The phone side of DashPal alerts: ACKs go out through this link, at once.
  const alerts = createDashcamAlerts({
    player: deps.player,
    now: () => deps.now(),
    sendAck: (alertId, outcome) => self.sendAlertAck(alertId, outcome),
    canPlay: () => canPlay(),
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
    if (repairCause) return 'needs_repair';
    if (bt === 'unauthorized') return 'unauthorized';
    if (bt === 'off' || bt === 'turning_off' || bt === 'unsupported') return 'bluetooth_off';
    if (session) return 'connected';
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
      firmware,
      counters: { ...counters },
    };
  }

  function changed(): void {
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

  function send(frame: RxFrame, opts: { withResponse: boolean; urgent?: boolean }): Promise<boolean> {
    return deps.write(encodeRx(frame), opts).then(
      () => true,
      (e: unknown) => {
        report(e, `write ${frame.type}`);
        return false;
      }
    );
  }

  // ——— the STATE lease (§3.2, §3.7) ———

  function canPlay(): boolean {
    let c: LinkContext;
    try {
      c = deps.context();
    } catch (e) {
      report(e, 'context');
      return false;
    }
    return (c.recording || c.foreground) && c.playerAvailable && c.styleAllowsSound && !c.callActive;
  }

  function stateFrame(now: number, s: Session): RxFrame {
    let c: LinkContext | null = null;
    try {
      c = deps.context();
    } catch (e) {
      report(e, 'context');
    }
    let flags = 0;
    if (c && (c.recording || c.foreground) && c.playerAvailable && c.styleAllowsSound && !c.callActive) flags |= STATE_FLAG.CAN_PLAY;
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

  function tick(nowArg?: number): void {
    if (disposed) return;
    const now = nowArg ?? deps.now();
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
      // STATE every second once resumed (carries the ACK too).
      if (s.phase === 'resumed' && (s.lastStateAt === null || now - s.lastStateAt >= STATE_EVERY_MS || now < s.lastStateAt)) {
        s.lastStateAt = now;
        const frame = stateFrame(now, s);
        if (frame.type === 'STATE' && s.bootReady) {
          s.ackSent = frame.ackSeq;
          if (s.ackSent >= s.cursor) s.ackDueAt = null;
        }
        void send(frame, { withResponse: false });
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
        times.push((s.lastStateAt ?? 0) + STATE_EVERY_MS);
        times.push(s.nextSyncAt);
      }
      if (s.ackDueAt !== null && s.bootReady && s.wireBoot !== null) times.push(s.ackDueAt);
      if (alerts.playingAny()) times.push(s.lastFrameAt + STALE_MS + 1);
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
    if (s.wireBoot !== null && !sameBoot) {
      // A new boot while connected: the phone's alert table goes, the handshake starts over.
      alerts.clear();
      s.phase = 'hello';
      s.bootKey = null;
      s.bootReady = false;
      s.offsetMs = null;
      s.rttMs = null;
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

  function markAck(s: Session): void {
    if (s.cursor !== s.ackSent && s.ackDueAt === null) s.ackDueAt = deps.now() + ACK_BATCH_MS;
  }

  function onEvent(e: DashcamEventFrame, now: number): void {
    const s = session;
    if (!s) return;
    s.announcedNext = Math.max(s.announcedNext, e.seq + 1);
    const dashcamId = s.dashcamId;
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
      });
      if (inserted) counters.stored += 1;
      else counters.duplicates += 1;
      if (e.seq >= s.cursor) s.cursor = await store.cursor(dashcamId, bootKey, s.floor);
      markAck(s);
      changed();
      armWake(deps.now());
    }, 'event');
  }

  function onStatus(st: Status, now: number): void {
    const s = session;
    if (!s) return;
    s.status = { state: st.state, flags: st.flags, fpsX10: st.fpsX10, tempC: st.tempC, bondCount: st.bondCount, at: now };
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
      if (info.dashcamId !== paired.dashcamId) {
        self.needsRepair('wrong_dashcam');
        return false;
      }
      if (!info.peerBonded) {
        // The dashcam does not hold this phone's bond: touching an encrypted attribute now would
        // raise the OS pairing dialog (possibly mid-drive). Stop; the driver re-pairs from Settings.
        self.needsRepair('peer_not_bonded');
        return false;
      }
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
      session = {
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
        pings: new Map(),
        pingAt: [],
        echoes: 0,
        resumeDueAt: null,
        resyncAt: null,
        nextSyncAt: now + RESYNC_EVERY_MS,
        lastStateAt: null,
        lastFrameAt: now,
        ackDueAt: null,
        ackSent: -1,
        status: null,
      };
      // CCCDs of bonded peers are restored silently: subscribing alone does not produce a HELLO.
      requestHello(session, now);
      changed();
      armWake(now);
    },

    linkDown() {
      session = null;
      connectingNow = false;
      alerts.clear();
      changed();
    },

    needsRepair(cause) {
      repairCause = cause;
      session = null;
      connectingNow = false;
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
        if (s) s.lastFrameAt = now;
        changed();
        return;
      }
      if (!s) return;
      s.lastFrameAt = now;
      const f = decoded.frame;
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
          const ack = alerts.onAlert(f);
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
          break;
        }
        case 'PAIRED':
          try {
            deps.onPaired?.(f.bondCount);
          } catch (e) {
            report(e, 'onPaired');
          }
          break;
      }
      tick(now);
      changed();
    },

    setPaired(next) {
      const before = paired?.dashcamId ?? null;
      paired = next;
      if ((next?.dashcamId ?? null) !== before) {
        repairCause = null;
        session = null;
        alerts.clear();
      }
      changed();
    },

    tick,

    row(row, drive) {
      const now = deps.now();
      lastRow = { row, at: now };
      tick(now);
      if (!paired || !drive.recording || drive.dryRun || drive.clientTripId === null) return null;
      const s = session;
      const speed = knownSpeed(row);
      const moving = speed !== null && speed >= MOVING_MPS;
      const st = s?.status ?? null;
      const covered =
        moving &&
        s !== null &&
        st !== null &&
        now - st.at <= STATUS_FRESH_MS &&
        (st.state === DASHCAM_STATE.CALIBRATING || st.state === DASHCAM_STATE.MONITORING) &&
        (st.flags & STATUS_FLAG.LIVE) !== 0 &&
        (st.flags & STATUS_FLAG.PRIMARY) !== 0;
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
      // The persistence chain, but never past the deadline (a long replay keeps going on its own).
      const drained = async (): Promise<void> => {
        let done = false;
        const settledChain = chain.then(() => {
          done = true;
        });
        while (!done && deps.now() < deadline) await Promise.race([settledChain, deps.delay(50)]);
      };
      while (session && session.phase !== 'resumed' && deps.now() < deadline) await deps.delay(100);
      if (session) await drained();
      while (session && !synced() && deps.now() < deadline) {
        await deps.delay(100);
        await drained();
      }
      await coverageChain;
      if (synced()) {
        try {
          await store.addCoverage(clientTripId, 0, 0, deps.now());
        } catch (e) {
          report(e, 'coverage (drive end)');
        }
      }
    },

    async command(op, arg = 0) {
      if (!session) return false;
      return send({ type: 'COMMAND', op, arg }, { withResponse: true });
    },

    canPlay,

    sendAlertAck(alertId, outcome) {
      if (!session) return;
      void send({ type: 'ALERT_ACK', alertId, outcome }, { withResponse: true, urgent: true });
    },

    playerUnavailable() {
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
      listeners.clear();
      alerts.clear();
      deps.wake?.(null);
    },
  };

  return self;
}

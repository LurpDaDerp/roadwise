/** @jest-environment node */
import type { AlertPlayer } from '@/core/alerts/player';
import type { AlertDecision } from '@/core/alerts/types';
import type { FeatureRow } from '@/core/engine/types';
import { createSqlJsDb } from '@/data/db/__fixtures__/sqljsDriver';
import { createTripsRepo, migrate, type Db } from '@/data/db';

import { cadenceMs } from '../alerts';
import type { PairedDashcam } from '../keys';
import {
  AUDIBLE_VOLUME_MIN,
  audible,
  createDashcamLink,
  HOLD_AWAKE_EVERY_MS,
  HOLD_AWAKE_MS,
  LATE_ALERT_MS,
  LATE_CRITICAL_ALERT_MS,
  LIVE_OFFSET_MAX_AGE_MS,
  LIVE_OFFSET_WINDOW_MAX,
  nextLiveOffset,
  PLAYER_RETRY_MS,
  ROW_STATE_FLOOR_MS,
  STATE_EVERY_CRITICAL_MS,
  STATE_EVERY_MS,
  usableLiveOffset,
  type AudioOutputProbe,
  type DashcamLink,
  type LinkContext,
} from '../link';
import {
  decodeInfo,
  decodeRx,
  encodeInfo,
  encodeTx,
  STATE_FLAG,
  STATE_TTL_DS,
  STATUS_FLAG,
  type DashcamInfo,
  type RxFrame,
  type TxFrame,
} from '../protocol';
import { BOOT_GENERATION, createDashcamStore, type DashcamStore } from '../store';

const T0 = 1_791_600_000_000;
const CAM = 'a4cf12b3c4d5';
const PAIRED: PairedDashcam = { dashcamId: CAM, peripheralId: 'periph-1', name: 'DashPal-C4D5', pairedAt: T0 - 1, secure: true };
const TRIP = '11111111-1111-4111-8111-111111111111';
const MAC = [0xa4, 0xcf, 0x12, 0xb3, 0xc4, 0xd5];
const info = (over: Partial<Omit<DashcamInfo, 'dashcamId' | 'name'>> = {}): DashcamInfo =>
  decodeInfo(encodeInfo({ ver: 1, protoMin: 1, protoMax: 1, fwMajor: 3, fwMinor: 3, mac: MAC, peerBonded: true, bondCount: 1, pairingOpen: false, ...over }))!;

interface Written {
  frame: RxFrame;
  withResponse: boolean;
  urgent: boolean;
  at: number;
}

function fakePlayer() {
  const delivered: (AlertDecision & { at: number; dropped: boolean; acksBefore: number })[] = [];
  let acks = () => 0;
  let stops = 0;
  let hold: (() => void) | null = null;
  let holding = false;
  let clock = () => 0;
  const player: AlertPlayer = {
    async deliver(d) {
      const wanted = d.stillWanted ? d.stillWanted() : true;
      delivered.push({ ...d, at: clock(), dropped: !wanted, acksBefore: acks() });
      if (holding) await new Promise<void>((resolve) => (hold = resolve));
    },
    async stopCurrent() {
      stops += 1;
      hold?.();
      hold = null;
    },
    announce: async () => {},
  };
  return {
    player,
    delivered,
    played: () => delivered.filter((d) => !d.dropped),
    stops: () => stops,
    setClock: (c: () => number) => (clock = c),
    countAcks: (f: () => number) => (acks = f),
    holdNext: (on: boolean) => (holding = on),
    release: () => {
      hold?.();
      hold = null;
    },
  };
}

interface Rig {
  link: DashcamLink;
  db: Db;
  store: DashcamStore;
  clock: { t: number };
  writes: Written[];
  ctx: LinkContext;
  player: ReturnType<typeof fakePlayer>;
  errors: string[];
  wakes: (number | null)[];
  paired: number[];
  /** frames of one type written since the last `clear()` */
  sent<T extends RxFrame['type']>(type: T): Extract<RxFrame, { type: T }>[];
  clear(): void;
  rx(f: TxFrame): void;
  advance(ms: number): void;
  settle(): Promise<void>;
  failWrites: boolean;
  /** what the audio probe answers */
  audio: AudioOutputProbe;
  /** every probe read: `fresh` */
  probes: boolean[];
  /** every holdAwake call, with how many frames had been written before it */
  holds: { ms: number; at: number; writesBefore: number }[];
  holdThrows: boolean;
}

let db: Db;
let n = 0;

beforeEach(async () => {
  db = await createSqlJsDb();
  await migrate(db);
  n = 0;
});

function rig(over: { store?: Partial<DashcamStore>; delay?: (ms: number) => Promise<void>; timersPaused?: () => boolean } = {}): Rig {
  const clock = { t: T0 };
  const writes: Written[] = [];
  const errors: string[] = [];
  const wakes: (number | null)[] = [];
  const paired: number[] = [];
  const player = fakePlayer();
  player.setClock(() => clock.t);
  player.countAcks(() => writes.filter((w) => w.frame.type === 'ALERT_ACK').length);
  const ctx: LinkContext = { recording: false, driveOpen: false, foreground: true, playerAvailable: true, styleAllowsSound: true, callActive: false, buzzerToo: false };
  const store = { ...createDashcamStore(db), ...over.store } as DashcamStore;
  const r: Rig = {
    link: null as unknown as DashcamLink,
    db,
    store,
    clock,
    writes,
    ctx,
    player,
    errors,
    wakes,
    paired,
    failWrites: false,
    audio: { callActive: false, volume: null, headphones: null },
    probes: [],
    holds: [],
    holdThrows: false,
    sent: (type) => writes.filter((w) => w.frame.type === type).map((w) => w.frame) as never,
    clear: () => {
      writes.length = 0;
    },
    rx: (f) => r.link.frame(encodeTx(f)),
    advance: (ms) => {
      clock.t += ms;
      r.link.tick(clock.t);
    },
    settle: async () => {
      await r.link.settled();
      await new Promise<void>((resolve) => setImmediate(resolve));
      await r.link.settled();
    },
  };
  r.link = createDashcamLink({
    now: () => clock.t,
    store,
    newId: () => `00000000-0000-4000-8000-${String((n += 1)).padStart(12, '0')}`,
    write: async (bytes, opts) => {
      if (r.failWrites) throw new Error('write failed');
      const d = decodeRx(bytes);
      if (!d.ok) throw new Error(`bad rx frame ${d.reason}`);
      writes.push({ frame: d.frame, withResponse: opts.withResponse, urgent: opts.urgent === true, at: clock.t });
    },
    player: player.player,
    context: () => ctx,
    localMinute: () => 615,
    delay:
      over.delay ??
      (async (ms) => {
        clock.t += ms;
        await new Promise<void>((resolve) => setImmediate(resolve));
      }),
    timersPaused: over.timersPaused,
    audioOutput: (fresh) => {
      r.probes.push(fresh);
      return { ...r.audio };
    },
    holdAwake: (ms) => {
      r.holds.push({ ms, at: clock.t, writesBefore: writes.length });
      if (r.holdThrows) throw new Error('wake lock');
    },
    wake: (at) => wakes.push(at),
    onPaired: (c) => paired.push(c),
    onError: (e, c) => errors.push(`${c}: ${e instanceof Error ? e.message : String(e)}`),
  });
  r.link.setPaired(PAIRED);
  r.link.setBluetooth('on');
  return r;
}

const UP = 3_600_000; // dashcam uptime at T0 (booted an hour ago)
const uptime = (r: Rig) => r.clock.t - T0 + UP;

/** Link up, HELLO, three echoes (10 ms RTT each), RESUME. */
async function connect(r: Rig, hello: { bootId?: number; nextSeq?: number; oldestSeq?: number } = {}): Promise<void> {
  expect(r.link.infoRead(info())).toBe(true);
  r.link.linkUp(info());
  r.advance(30);
  r.rx({ type: 'HELLO', bootId: hello.bootId ?? 0xdeadbeef, nextSeq: hello.nextSeq ?? 0, oldestSeq: hello.oldestSeq ?? 0, uptimeMs: uptime(r) });
  await r.settle();
  for (let i = 0; i < 3; i++) {
    const ping = r.sent('TIME_PING').at(-1)!;
    r.advance(5);
    r.rx({ type: 'TIME_ECHO', reqId: ping.reqId, uptimeMs: uptime(r) });
    r.advance(5);
    r.advance(PING_STEP);
  }
  await r.settle();
  r.link.tick(r.clock.t);
}
const PING_STEP = 100;

const ev = (seq: number, o: Partial<Extract<TxFrame, { type: 'EVENT' }>> = {}): TxFrame => ({
  type: 'EVENT',
  seq,
  tMs: UP + seq * 1000,
  durDs: 15,
  ev: 0,
  tier: 3,
  audible: true,
  detail: 0,
  valueX10: 12,
  ...o,
});

const alert = (o: Partial<Extract<TxFrame, { type: 'ALERT' }>> = {}): TxFrame => ({
  type: 'ALERT',
  alertId: 513,
  sound: 1,
  tier: 2,
  level: 0,
  mode: 1,
  route: 1,
  uptimeMs: UP,
  ...o,
});

function row(at: number, over: Partial<FeatureRow> = {}): FeatureRow {
  return {
    ts: at,
    lat: 40,
    lng: -75,
    hAcc: 5,
    speed: 20,
    speedAcc: 0.5,
    course: 0,
    alt: 0,
    gnssValid: true,
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
    ...over,
  };
}

// ——— §3.3 the connection sequence ———

describe('connection sequence (§3.3)', () => {
  test('link up → COMMAND 7 hello; HELLO → three TIME_PINGs 100 ms apart; RESUME after the three echoes; then STATE every second', async () => {
    const r = rig();
    r.link.linkUp(info());
    expect(r.sent('COMMAND')).toEqual([{ type: 'COMMAND', op: 7, arg: 0 }]);
    expect(r.writes[0]!.withResponse).toBe(true);
    expect(r.link.snapshot().lifecycle).toBe('connected');
    r.advance(40);
    r.rx({ type: 'HELLO', bootId: 0xdeadbeef, nextSeq: 5, oldestSeq: 2, uptimeMs: uptime(r) });
    await r.settle();
    expect(r.sent('TIME_PING')).toHaveLength(1);
    r.advance(100);
    r.advance(100);
    const pings = r.sent('TIME_PING');
    expect(pings).toHaveLength(3);
    expect(new Set(pings.map((p) => p.reqId)).size).toBe(3);
    expect(r.sent('RESUME')).toEqual([]);
    expect(r.sent('STATE')).toEqual([]);
    for (const p of pings) r.rx({ type: 'TIME_ECHO', reqId: p.reqId, uptimeMs: uptime(r) });
    await r.settle();
    // RESUME at the cursor: nothing stored yet, so the boot's floor (oldest_seq).
    expect(r.sent('RESUME')).toEqual([{ type: 'RESUME', bootId: 0xdeadbeef, nextSeq: 2 }]);
    const states = r.sent('STATE');
    expect(states.length).toBe(1);
    r.clear();
    r.advance(500);
    expect(r.sent('STATE')).toEqual([]);
    r.advance(400);
    expect(r.sent('STATE')).toHaveLength(1);
    r.advance(899);
    expect(r.sent('STATE')).toHaveLength(1);
    r.advance(1);
    expect(r.sent('STATE')).toHaveLength(2);
  });

  test('RESUME 500 ms after the HELLO when the echoes do not come', async () => {
    const r = rig();
    r.link.linkUp(info());
    r.rx({ type: 'HELLO', bootId: 7, nextSeq: 0, oldestSeq: 0, uptimeMs: UP });
    await r.settle();
    r.advance(499);
    expect(r.sent('RESUME')).toEqual([]);
    r.advance(1);
    expect(r.sent('RESUME')).toEqual([{ type: 'RESUME', bootId: 7, nextSeq: 0 }]);
  });

  test('row 14: every link-up asks for HELLO (restored CCCDs send none); no answer in 2 s asks again', async () => {
    const r = rig();
    r.link.linkUp(info());
    r.advance(1999);
    expect(r.sent('COMMAND')).toHaveLength(1);
    r.advance(1);
    expect(r.sent('COMMAND')).toHaveLength(2);
    r.link.linkDown();
    r.clear();
    r.link.linkUp(info());
    expect(r.sent('COMMAND')).toEqual([{ type: 'COMMAND', op: 7, arg: 0 }]);
  });

  test('TIME_PING ×3 again every 10 minutes, triggered from ticks', async () => {
    const r = rig();
    await connect(r);
    r.clear();
    r.advance(9 * 60_000);
    expect(r.sent('TIME_PING')).toEqual([]);
    r.advance(61_000);
    r.advance(100);
    r.advance(100);
    expect(r.sent('TIME_PING')).toHaveLength(3);
    // No second RESUME: a resync is pings only.
    expect(r.sent('RESUME')).toEqual([]);
  });

  test('the HELLO that answers RESUME starts no second handshake', async () => {
    const r = rig();
    await connect(r, { nextSeq: 3 });
    r.clear();
    r.rx({ type: 'HELLO', bootId: 0xdeadbeef, nextSeq: 3, oldestSeq: 0, uptimeMs: uptime(r) });
    await r.settle();
    r.advance(1000);
    expect(r.sent('TIME_PING')).toEqual([]);
    expect(r.sent('RESUME')).toEqual([]);
  });
});

// ——— §3.6 events: persist, then ACK ———

describe('events (§3.6)', () => {
  test('each EVENT is stored with a fresh lowercase v4 id before it is acknowledged; ACKs are batched ≤ 200 ms; STATE carries the cursor', async () => {
    const r = rig();
    await connect(r);
    r.clear();
    r.rx(ev(0));
    r.rx(ev(1, { ev: 3, tier: 2, detail: 0, valueX10: -7 }));
    await r.settle();
    const { rows } = await db.execute('SELECT seq, id, name, tier, audible, value, at_ms, started_at_ms FROM dashcam_events ORDER BY seq');
    expect(rows).toHaveLength(2);
    expect(rows[1]).toMatchObject({ seq: 1, name: 'LONG_GLANCE', tier: 2, audible: 1, value: -0.7 });
    for (const row of rows) expect(String(row.id)).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    // the wall-time cache from the offset known at receipt (dashcam uptime UP == T0 here, ±RTT/2)
    expect(Math.abs(Number(rows[0]!.at_ms) - T0)).toBeLessThanOrEqual(10);
    expect(r.sent('ACK')).toEqual([]);
    r.advance(199);
    expect(r.sent('ACK')).toEqual([]);
    r.advance(1);
    expect(r.sent('ACK')).toEqual([{ type: 'ACK', bootId: 0xdeadbeef, ackSeq: 2 }]);
    r.advance(1000);
    expect(r.sent('STATE').at(-1)).toMatchObject({ bootId: 0xdeadbeef, ackSeq: 2 });
  });

  test('row 12: an event whose write never finished is never acknowledged; re-sent, it is stored once', async () => {
    let failSeq: number | null = 1;
    const base = createDashcamStore(db);
    const r = rig({
      store: {
        insertEvent: async (e) => {
          if (e.seq === failSeq) throw new Error('process died before the write');
          return base.insertEvent(e);
        },
      },
    });
    await connect(r);
    r.rx(ev(0));
    r.rx(ev(1));
    r.rx(ev(2));
    await r.settle();
    r.advance(300);
    expect(r.sent('ACK').at(-1)).toEqual({ type: 'ACK', bootId: 0xdeadbeef, ackSeq: 1 });
    expect(r.link.snapshot().counters.storeErrors).toBe(1);
    // The failure asks the dashcam to replay from the cursor (it replays only on RESUME).
    r.clear();
    failSeq = null;
    r.advance(5000);
    expect(r.sent('RESUME')).toEqual([{ type: 'RESUME', bootId: 0xdeadbeef, nextSeq: 1 }]);
    r.rx({ type: 'HELLO', bootId: 0xdeadbeef, nextSeq: 3, oldestSeq: 0, uptimeMs: uptime(r) });
    r.rx(ev(1));
    r.rx(ev(2));
    await r.settle();
    r.advance(300);
    expect(r.sent('ACK').at(-1)).toEqual({ type: 'ACK', bootId: 0xdeadbeef, ackSeq: 3 });
    expect((await db.execute('SELECT seq FROM dashcam_events ORDER BY seq')).rows).toEqual([{ seq: 0 }, { seq: 1 }, { seq: 2 }]);
    expect(r.link.snapshot().counters).toMatchObject({ stored: 3, duplicates: 1 });
  });

  test('row 11: a reconnect RESUMEs at the cursor; the replay is deduplicated; a gap below oldest_seq advances the floor', async () => {
    const r = rig();
    await connect(r, { nextSeq: 0 });
    for (const s of [0, 1, 2]) r.rx(ev(s));
    await r.settle();
    r.link.linkDown();
    expect(r.link.snapshot().lifecycle).toBe('idle');
    r.clear();
    // The dashcam made events 3..9 meanwhile; its ring now starts at 5 (3 and 4 are gone).
    await connect(r, { nextSeq: 10, oldestSeq: 5 });
    expect(r.sent('RESUME')).toEqual([{ type: 'RESUME', bootId: 0xdeadbeef, nextSeq: 5 }]);
    for (const s of [5, 6, 7, 8, 9]) r.rx(ev(s));
    r.rx(ev(6)); // replayed twice
    await r.settle();
    r.advance(300);
    expect(r.sent('ACK').at(-1)).toEqual({ type: 'ACK', bootId: 0xdeadbeef, ackSeq: 10 });
    expect((await db.execute('SELECT COUNT(*) AS n FROM dashcam_events')).rows).toEqual([{ n: 8 }]);
    expect((await r.store.getBoot(CAM, 0xdeadbeef))?.floorSeq).toBe(5);
    expect(r.link.snapshot().synced).toBe(true);
  });

  test('the dashcam tables wiped under a live link (a sign-out): restart() handshakes again on the same connection, the boot row comes back and the replay makes the phone synced', async () => {
    const r = rig();
    await connect(r, { nextSeq: 0 });
    r.rx(ev(0));
    r.rx(ev(1));
    r.rx(alert({ alertId: 4, route: 0 }));
    await r.settle();
    expect(r.link.snapshot().synced).toBe(true);
    // wipeForSignOut, with the dashcam still connected.
    await db.execute('DELETE FROM dashcam_events');
    await db.execute('DELETE FROM dashcam_boots');
    r.clear();
    r.link.restart();
    expect(r.sent('COMMAND')).toEqual([{ type: 'COMMAND', op: 7, arg: 0 }]);
    expect(r.link.snapshot()).toMatchObject({ lifecycle: 'connected', synced: false, visual: { alertId: 4 } });
    r.advance(30);
    r.rx({ type: 'HELLO', bootId: 0xdeadbeef, nextSeq: 3, oldestSeq: 0, uptimeMs: uptime(r) });
    await r.settle();
    for (let i = 0; i < 3; i++) {
      const ping = r.sent('TIME_PING').at(-1)!;
      r.advance(5);
      r.rx({ type: 'TIME_ECHO', reqId: ping.reqId, uptimeMs: uptime(r) });
      r.advance(5);
      r.advance(PING_STEP);
    }
    await r.settle();
    r.link.tick(r.clock.t);
    // RESUME from the floor: the dashcam replays its ring, and the new event 2 follows.
    expect(r.sent('RESUME')).toEqual([{ type: 'RESUME', bootId: 0xdeadbeef, nextSeq: 0 }]);
    for (const seq of [0, 1, 2]) r.rx(ev(seq));
    await r.settle();
    expect(r.link.snapshot().synced).toBe(true);
    expect((await db.execute('SELECT seq FROM dashcam_events ORDER BY seq')).rows).toEqual([{ seq: 0 }, { seq: 1 }, { seq: 2 }]);
    expect((await r.store.getBoot(CAM, 0xdeadbeef))?.offsetMs).not.toBeNull();
    expect(r.errors).toEqual([]);
    // Not connected: nothing to restart.
    r.link.linkDown();
    r.clear();
    r.link.restart();
    expect(r.writes).toEqual([]);
  });

  test('row 13: a reboot (new random boot id) keeps its own offsets and stores seq 0 again; the alert table is cleared', async () => {
    const r = rig();
    await connect(r, { bootId: 111 });
    r.rx(ev(0));
    r.rx(alert());
    await r.settle();
    expect(r.player.played()).toHaveLength(1);
    r.link.linkDown();
    await connect(r, { bootId: 222 });
    r.rx(ev(0));
    await r.settle();
    const { rows } = await db.execute('SELECT boot_id, seq FROM dashcam_events ORDER BY boot_id');
    expect(rows).toEqual([
      { boot_id: 111, seq: 0 },
      { boot_id: 222, seq: 0 },
    ]);
    const boots = await db.execute('SELECT boot_id, offset_ms IS NOT NULL AS has FROM dashcam_boots ORDER BY boot_id');
    expect(boots.rows).toEqual([
      { boot_id: 111, has: 1 },
      { boot_id: 222, has: 1 },
    ]);
  });

  test('a HELLO with a known boot id but fewer events than stored is another boot: a new local generation', async () => {
    const r = rig();
    await connect(r, { bootId: 42 });
    for (const s of [0, 1, 2, 3]) r.rx(ev(s));
    await r.settle();
    r.link.linkDown();
    r.clear();
    await connect(r, { bootId: 42, nextSeq: 2 });
    expect(r.sent('RESUME')).toEqual([{ type: 'RESUME', bootId: 42, nextSeq: 0 }]);
    r.rx(ev(0, { ev: 1 }));
    r.rx(ev(1, { ev: 1 }));
    await r.settle();
    const { rows } = await db.execute('SELECT boot_id, seq, name FROM dashcam_events WHERE boot_id > ? ORDER BY seq', [BOOT_GENERATION]);
    expect(rows).toEqual([
      { boot_id: 42 + BOOT_GENERATION, seq: 0, name: 'SLEEP' },
      { boot_id: 42 + BOOT_GENERATION, seq: 1, name: 'SLEEP' },
    ]);
    r.advance(300);
    expect(r.sent('ACK').at(-1)).toEqual({ type: 'ACK', bootId: 42, ackSeq: 2 });
  });

  test('an EVENT before any HELLO of the connection is not stored (its boot is unknown)', async () => {
    const r = rig();
    r.link.linkUp(info());
    r.rx(ev(0));
    await r.settle();
    expect((await db.execute('SELECT COUNT(*) AS n FROM dashcam_events')).rows).toEqual([{ n: 0 }]);
  });
});

// ——— row 15: the clock offset ———

test('row 15: the offset error is within RTT/2 of the truth; the best (lowest-RTT) sample wins and is persisted; a late HELLO gives none', async () => {
  const r = rig();
  const truth = T0 - UP; // epoch = uptime + truth
  r.link.linkUp(info());
  r.advance(1500); // HELLO 1.5 s after the request: no sample
  r.rx({ type: 'HELLO', bootId: 9, nextSeq: 0, oldestSeq: 0, uptimeMs: r.clock.t - truth - 20 });
  await r.settle();
  expect((await r.store.getBoot(CAM, 9))?.offsetMs).toBeNull();
  // Asymmetric paths: 30 ms out, 10 ms back (RTT 40), then 4 ms each way (RTT 8).
  const ping = (out: number, back: number) => {
    const p = r.sent('TIME_PING').at(-1)!;
    r.clock.t += out;
    const echoUptime = r.clock.t - truth;
    r.clock.t += back;
    r.rx({ type: 'TIME_ECHO', reqId: p.reqId, uptimeMs: echoUptime });
  };
  ping(30, 10);
  await r.settle();
  let boot = await r.store.getBoot(CAM, 9);
  expect(boot?.rttMs).toBe(40);
  expect(Math.abs(boot!.offsetMs! - truth)).toBeLessThanOrEqual(20);
  r.advance(100);
  ping(4, 4);
  await r.settle();
  boot = await r.store.getBoot(CAM, 9);
  expect(boot?.rttMs).toBe(8);
  expect(Math.abs(boot!.offsetMs! - truth)).toBeLessThanOrEqual(4);
  r.advance(100);
  ping(50, 50); // worse: ignored
  await r.settle();
  expect((await r.store.getBoot(CAM, 9))?.rttMs).toBe(8);
  // RESUME followed the three echoes.
  expect(r.sent('RESUME')).toHaveLength(1);
  // An echo for an unknown request id is ignored.
  r.rx({ type: 'TIME_ECHO', reqId: 999, uptimeMs: 1 });
  await r.settle();
  expect((await r.store.getBoot(CAM, 9))?.rttMs).toBe(8);
});

test('row 15: a timely HELLO gives a first offset, but a TIME_PING over the same asymmetric link (30 ms down, 10 ms up) replaces it: the error stays within RTT/2 (found by the cross-repo e2e)', async () => {
  const r = rig();
  const truth = T0 - UP;
  r.link.linkUp(info());
  // COMMAND 7 takes 10 ms out, HELLO 30 ms back: the HELLO sample is off by 30 ms.
  r.clock.t += 10;
  const helloUptime = r.clock.t - truth;
  r.clock.t += 30;
  r.rx({ type: 'HELLO', bootId: 9, nextSeq: 0, oldestSeq: 0, uptimeMs: helloUptime });
  await r.settle();
  expect((await r.store.getBoot(CAM, 9))?.offsetMs).toBe(truth + 30);
  const p = r.sent('TIME_PING').at(-1)!;
  r.clock.t += 10;
  const echoUptime = r.clock.t - truth;
  r.clock.t += 30;
  r.rx({ type: 'TIME_ECHO', reqId: p.reqId, uptimeMs: echoUptime });
  await r.settle();
  const boot = await r.store.getBoot(CAM, 9);
  expect(boot?.rttMs).toBe(40);
  expect(boot!.offsetMs! - truth).toBe(10);
});

// ——— events with no drive open: stored as delivery records, ignored ———

describe('events with no drive open', () => {
  const flags = async () => (await db.execute('SELECT seq, ignored FROM dashcam_events ORDER BY seq')).rows;
  const status = (r: Rig, flags: number) => r.rx({ type: 'STATUS', uptimeMs: uptime(r), state: 3, flags, fpsX10: 200, tempC: 40, bondCount: 1 });
  const openDrive = (r: Rig, open: boolean) => {
    r.ctx.recording = open;
    r.ctx.driveOpen = open;
  };

  test('an event with no drive open is stored once, marked ignored; the cursor, ACK and STATE still reach next_seq and the phone is synced', async () => {
    const r = rig();
    await connect(r, { nextSeq: 0 });
    r.clear();
    r.rx(ev(0));
    r.rx(ev(1));
    await r.settle();
    r.advance(300);
    expect(await flags()).toEqual([
      { seq: 0, ignored: 1 },
      { seq: 1, ignored: 1 },
    ]);
    expect(r.sent('ACK').at(-1)).toEqual({ type: 'ACK', bootId: 0xdeadbeef, ackSeq: 2 });
    r.advance(1000);
    expect(r.sent('STATE').at(-1)).toMatchObject({ ackSeq: 2 });
    expect(r.link.snapshot()).toMatchObject({ synced: true, counters: { stored: 2, ignored: 2, duplicates: 0 } });
  });

  test('reconnect mid-drive with a whole-ring replay: the copies stored before the drive stay ignored and are not duplicated; the new ones are in the drive; coverage and the sync stamp are untouched by the ignored ones', async () => {
    await createTripsRepo(db).insert({ client_trip_id: TRIP, started_at: T0, tz: 'UTC', status: 'recording' }, T0);
    const r = rig();
    await connect(r, { nextSeq: 0 });
    r.rx(ev(0));
    r.rx(ev(1));
    await r.settle();
    // Start Drive; rows with a live, primary dashcam.
    openDrive(r, true);
    const drive = { clientTripId: TRIP, recording: true, dryRun: false };
    status(r, STATUS_FLAG.LIVE | STATUS_FLAG.PRIMARY);
    r.link.row(row(r.clock.t), drive);
    r.rx(ev(2));
    await r.settle();
    r.link.linkDown();
    r.clear();
    // The dashcam made 3 and 4 while the link was down; it replays its whole ring (0..4).
    await connect(r, { nextSeq: 5, oldestSeq: 0 });
    expect(r.sent('RESUME')).toEqual([{ type: 'RESUME', bootId: 0xdeadbeef, nextSeq: 3 }]);
    for (const s of [0, 1, 2, 3, 4]) r.rx(ev(s));
    await r.settle();
    status(r, STATUS_FLAG.LIVE | STATUS_FLAG.PRIMARY);
    r.link.row(row(r.clock.t), drive);
    r.advance(300);
    expect(await flags()).toEqual([
      { seq: 0, ignored: 1 },
      { seq: 1, ignored: 1 },
      { seq: 2, ignored: 0 },
      { seq: 3, ignored: 0 },
      { seq: 4, ignored: 0 },
    ]);
    expect(r.sent('ACK').at(-1)).toEqual({ type: 'ACK', bootId: 0xdeadbeef, ackSeq: 5 });
    expect(r.link.snapshot()).toMatchObject({ synced: true, counters: { stored: 5, ignored: 2, duplicates: 3 } });
    // The drive ends: the catch-up finds the phone synced and stamps it.
    r.ctx.recording = false;
    await r.link.beforeFinalize(TRIP);
    expect(await r.store.coverage(TRIP)).toEqual({ movingS: 2, coveredS: 2, lastSyncedAtMs: r.clock.t });
  });

  test('the 7-day prune under a live link (one boot, one socket): the cursor never moves back, the phone stays synced, and a whole-ring replay stores nothing pruned again', async () => {
    const r = rig();
    await connect(r, { nextSeq: 0 });
    for (const s of [0, 1, 2]) r.rx(ev(s));
    await r.settle();
    r.advance(300);
    expect(r.link.snapshot().synced).toBe(true);
    // A week on, the foreground jobs prune all three while the link is still up.
    expect(await r.store.pruneUnattached(r.clock.t + 1)).toBe(3);
    r.clear();
    r.advance(1000);
    expect(r.sent('STATE').at(-1)).toMatchObject({ ackSeq: 3 });
    r.rx(ev(3));
    await r.settle();
    r.advance(300);
    expect(r.sent('ACK').at(-1)).toEqual({ type: 'ACK', bootId: 0xdeadbeef, ackSeq: 4 });
    expect(r.link.snapshot().synced).toBe(true);
    // A reconnect RESUMEs at the cursor; a dashcam that replays its whole ring re-stores nothing pruned.
    r.link.linkDown();
    r.clear();
    await connect(r, { nextSeq: 4, oldestSeq: 0 });
    expect(r.sent('RESUME')).toEqual([{ type: 'RESUME', bootId: 0xdeadbeef, nextSeq: 4 }]);
    for (const s of [0, 1, 2, 3]) r.rx(ev(s));
    await r.settle();
    r.advance(300);
    expect(await flags()).toEqual([{ seq: 3, ignored: 1 }]);
    expect(r.link.snapshot()).toMatchObject({ synced: true, counters: { stored: 4, duplicates: 4 } });
  });

  test('in the drive and during the drive-end catch-up (finalizing) an event is not ignored; after finalize it is; the drive state is read as the frame arrives', async () => {
    const r = rig();
    await connect(r, { nextSeq: 0 });
    openDrive(r, true);
    r.rx(ev(0)); // recording
    await r.settle();
    // The drive ends: finalizing (no longer recording), the catch-up still in the drive.
    r.ctx.recording = false;
    const ending = r.link.beforeFinalize(TRIP);
    r.rx(ev(1));
    await ending;
    // Arrived in the drive, written after it closed: not ignored.
    r.rx(ev(2));
    r.ctx.driveOpen = false;
    await r.settle();
    // Finalize has finished: ignored; and one that arrived with no drive open stays ignored when a
    // drive opens before its write.
    r.rx(ev(3));
    await r.settle();
    r.rx(ev(4));
    openDrive(r, true);
    await r.settle();
    expect(await flags()).toEqual([
      { seq: 0, ignored: 0 },
      { seq: 1, ignored: 0 },
      { seq: 2, ignored: 0 },
      { seq: 3, ignored: 1 },
      { seq: 4, ignored: 1 },
    ]);
    // The same seqs replayed now (a drive open) change nothing.
    for (const s of [3, 4]) r.rx(ev(s));
    await r.settle();
    expect((await flags()).slice(3)).toEqual([
      { seq: 3, ignored: 1 },
      { seq: 4, ignored: 1 },
    ]);
    expect(r.link.snapshot().counters).toMatchObject({ stored: 5, ignored: 2, duplicates: 2 });
    expect(r.link.snapshot().synced).toBe(true);
  });
});

// ——— STATE: lease and context (§3.2, §3.7) ———

describe('STATE (§3.2, §3.7)', () => {
  test('can_play, buzzer_too, drive_active; local_min; ttl 30', async () => {
    const r = rig();
    await connect(r);
    const last = () => r.sent('STATE').at(-1)!;
    r.advance(1000);
    expect(last()).toMatchObject({ flags: STATE_FLAG.CAN_PLAY, ttlDs: 30, localMin: 615, speedCms: 0 });
    r.ctx.buzzerToo = true;
    r.ctx.recording = true;
    r.advance(1000);
    expect(last().flags).toBe(STATE_FLAG.CAN_PLAY | STATE_FLAG.BUZZER_TOO | STATE_FLAG.DRIVE_ACTIVE);
  });

  test('row 4: no can_play under vibration-only, on a call (the host\'s or the probe\'s), with the player unavailable, a media volume under a quarter or headphones; in the background with no drive it can play', async () => {
    const r = rig();
    await connect(r);
    const can = () => {
      r.advance(1000);
      return (r.sent('STATE').at(-1)!.flags & STATE_FLAG.CAN_PLAY) !== 0;
    };
    expect(can()).toBe(true);
    r.ctx.styleAllowsSound = false;
    expect(can()).toBe(false);
    r.ctx.styleAllowsSound = true;
    r.ctx.callActive = true;
    expect(can()).toBe(false);
    r.ctx.callActive = false;
    r.audio.callActive = true;
    expect(can()).toBe(false);
    r.audio.callActive = false;
    r.ctx.playerAvailable = false;
    expect(can()).toBe(false);
    r.ctx.playerAvailable = true;
    r.audio.volume = 0.2;
    expect(can()).toBe(false);
    r.audio.volume = 0.5;
    r.audio.headphones = true;
    expect(can()).toBe(false);
    r.audio.headphones = false;
    expect(can()).toBe(true);
    // Neither a drive nor RoadWise in front is needed any more.
    r.ctx.foreground = false;
    expect(r.link.canPlay()).toBe(true);
    expect(r.link.canPlay(true)).toBe(true);
  });

  test('speed_valid only while recording, from a row ≤ 2 s old with a fix, speed ≥ 0 and accuracy ≤ 2 m/s', async () => {
    const r = rig();
    await connect(r);
    const last = () => r.sent('STATE').at(-1)!;
    const valid = () => (last().flags & STATE_FLAG.SPEED_VALID) !== 0;
    r.advance(1000);
    r.link.row(row(r.clock.t, { speed: 13.4 }), { clientTripId: null, recording: false, dryRun: false });
    r.advance(1000);
    expect(valid()).toBe(false); // not recording
    r.ctx.recording = true;
    r.link.row(row(r.clock.t, { speed: 13.416 }), { clientTripId: TRIP, recording: true, dryRun: false });
    r.advance(1000);
    expect(valid()).toBe(true);
    expect(last().speedCms).toBe(1342);
    r.advance(1001); // the row is now 2.001 s old
    expect(valid()).toBe(false);
    for (const bad of [{ gnssValid: false }, { speed: -1 }, { speedAcc: 2.01 }, { speedAcc: -1 }, { speedAcc: NaN }]) {
      r.link.row(row(r.clock.t, bad), { clientTripId: TRIP, recording: true, dryRun: false });
      r.advance(1000);
      expect(valid()).toBe(false);
      expect(last().speedCms).toBe(0);
    }
    r.link.row(row(r.clock.t, { speedAcc: 2 }), { clientTripId: TRIP, recording: true, dryRun: false });
    r.advance(1000);
    expect(valid()).toBe(true);
  });

  test('row 31: with timers never firing (Android background), rows alone keep STATE going about once a second', async () => {
    const r = rig();
    await connect(r);
    r.ctx.recording = true;
    r.clear();
    for (let i = 0; i < 30; i++) {
      r.clock.t += 1000; // no tick() but the row's
      r.link.row(row(r.clock.t), { clientTripId: null, recording: true, dryRun: false });
    }
    const states = r.writes.filter((w) => w.frame.type === 'STATE');
    expect(states).toHaveLength(30);
    expect(states.every((w) => (w.frame as Extract<RxFrame, { type: 'STATE' }>).flags & STATE_FLAG.DRIVE_ACTIVE)).toBe(true);
  });

  test('with timers paused, every row renews the lease: rows 0.85 s then 2.2 s apart never leave a 3 s gap between STATEs', async () => {
    const paused = { on: true };
    const r = rig({ timersPaused: () => paused.on });
    await connect(r);
    r.ctx.recording = true;
    r.ctx.foreground = false;
    r.link.row(row(r.clock.t), { clientTripId: null, recording: true, dryRun: false });
    r.clear();
    for (let i = 0; i < 20; i++) {
      r.clock.t += i % 2 === 0 ? 850 : 2200; // no tick() but the row's
      r.link.row(row(r.clock.t), { clientTripId: null, recording: true, dryRun: false });
    }
    const states = r.writes.filter((w) => w.frame.type === 'STATE');
    expect(states).toHaveLength(20);
    const gaps = states.slice(1).map((w, i) => w.at - states[i]!.at);
    expect(Math.max(...gaps)).toBeLessThanOrEqual(2200);
    expect(states.every((w) => ((w.frame as Extract<RxFrame, { type: 'STATE' }>).flags & STATE_FLAG.CAN_PLAY) !== 0)).toBe(true);
    // With timers running, the 1 s cadence stands: a row 0.85 s after a STATE sends none.
    paused.on = false;
    r.clock.t += 1000;
    r.link.row(row(r.clock.t), { clientTripId: null, recording: true, dryRun: false });
    r.clear();
    r.clock.t += 850;
    r.link.row(row(r.clock.t), { clientTripId: null, recording: true, dryRun: false });
    expect(r.sent('STATE')).toEqual([]);
    // A frame never renews it early, paused or not (an event replay is many frames).
    paused.on = true;
    r.clock.t += 20; // 870 ms after the last STATE
    r.rx({ type: 'STATUS', uptimeMs: uptime(r), state: 3, flags: STATUS_FLAG.LIVE, fpsX10: 150, tempC: 40, bondCount: 1 });
    expect(r.sent('STATE')).toEqual([]);
  });

  test('with timers paused, a row sends one STATE at most: a wake or frame tick that just sent it counts, and the lease still never lapses', async () => {
    const r = rig({ timersPaused: () => true });
    await connect(r);
    r.ctx.recording = true;
    r.ctx.foreground = false;
    r.link.row(row(r.clock.t), { clientTripId: null, recording: true, dryRun: false });
    r.clear();
    for (let i = 0; i < 10; i++) {
      // The row's timer pump fires the due wake (a tick at the same instant), then the row ticks.
      r.clock.t += 1000;
      r.link.tick(r.clock.t);
      r.link.row(row(r.clock.t), { clientTripId: null, recording: true, dryRun: false });
    }
    expect(r.sent('STATE')).toHaveLength(10);
    // A frame tick sends STATE just under 300 ms before a row: the row adds none; the next row, 2.5 s later, renews.
    r.clear();
    r.clock.t += 950;
    r.rx({ type: 'STATUS', uptimeMs: uptime(r), state: 3, flags: STATUS_FLAG.LIVE, fpsX10: 150, tempC: 40, bondCount: 1 });
    const frameState = r.clock.t;
    r.clock.t += ROW_STATE_FLOOR_MS - 1;
    r.link.row(row(r.clock.t), { clientTripId: null, recording: true, dryRun: false });
    r.clock.t += 2500;
    r.link.row(row(r.clock.t), { clientTripId: null, recording: true, dryRun: false });
    const states = r.writes.filter((w) => w.frame.type === 'STATE');
    expect(states.map((w) => w.at - frameState)).toEqual([0, ROW_STATE_FLOOR_MS - 1 + 2500]);
    expect(ROW_STATE_FLOOR_MS - 1 + 2500).toBeLessThan(STATE_TTL_DS * 100);
  });

  test('a wake time is always asked for while connected (the timer is best effort)', async () => {
    const r = rig();
    await connect(r);
    r.advance(1000);
    const at = r.wakes.at(-1);
    expect(at).not.toBeNull();
    expect(at!).toBeLessThanOrEqual(r.clock.t + 1000);
  });

  test('a slow database never makes the wake time "now" forever: RESUME waits for the boot row without a zero-delay timer loop (found by the cross-repo e2e)', async () => {
    let releaseBoot: (() => void) | null = null;
    const real = createDashcamStore(db);
    const r = rig({
      store: {
        ensureBoot: async (...args: Parameters<DashcamStore['ensureBoot']>) => {
          await new Promise<void>((resolve) => (releaseBoot = resolve));
          return real.ensureBoot(...args);
        },
      },
    });
    expect(r.link.infoRead(info())).toBe(true);
    r.link.linkUp(info());
    r.advance(30);
    r.rx({ type: 'HELLO', bootId: 0xdeadbeef, nextSeq: 0, oldestSeq: 0, uptimeMs: uptime(r) });
    const drain = async () => {
      for (let i = 0; i < 20; i++) await new Promise<void>((resolve) => setImmediate(resolve));
    };
    await drain(); // (not settle(): the persistence chain is the thing held)
    // Past the 500 ms RESUME point with the boot row still unknown: nothing to do now.
    r.advance(800);
    const wake = r.link.nextWakeAt();
    expect(wake === null || wake > r.clock.t).toBe(true);
    expect(r.sent('RESUME')).toEqual([]);
    // The boot row arrives: the hello chain ticks and RESUME goes out at once.
    (releaseBoot as (() => void) | null)?.();
    await r.settle();
    expect(r.sent('RESUME')).toEqual([{ type: 'RESUME', bootId: 0xdeadbeef, nextSeq: 0 }]);
  });
});

// ——— §3.5 alerts on the phone ———

describe('alerts (§3.5)', () => {
  test('route 1 and able to play: ALERT_ACK(1) goes out before the first play, urgent; the first play speaks and vibrates at its first-play strength', async () => {
    const r = rig();
    await connect(r);
    r.clear();
    r.rx(alert({ sound: 1, tier: 2 }));
    expect(r.writes.map((w) => [w.frame.type, w.urgent])).toEqual([['ALERT_ACK', true]]);
    expect(r.sent('ALERT_ACK')).toEqual([{ type: 'ALERT_ACK', alertId: 513, outcome: 1 }]);
    await r.settle();
    // The ACK was written before the play was handed to the player.
    expect(r.player.delivered[0]!.acksBefore).toBe(1);
    expect(r.player.played()).toEqual([
      expect.objectContaining({ kind: 'dashpal', level: 2, tone: 'dp_glance', voice: 'Eyes on the road', intensity: 2, holdSession: true }),
    ]);
    expect(r.link.snapshot().visual).toMatchObject({ alertId: 513, sound: 1, level: 0, onPhone: true });
  });

  test('repeats at the sound cadence, never faster than an item finishes; repeats are voiceless at strength 2; a level change speaks again and shortens the wake cadence', async () => {
    const r = rig();
    await connect(r);
    r.rx(alert({ alertId: 9, sound: 3, tier: 3, level: 0 }));
    await r.settle();
    expect(r.player.played()[0]).toMatchObject({ tone: 'dp_wake', voice: 'Wake up', voiceAlways: true, intensity: 4 });
    const step = (ms: number) => {
      r.clock.t += ms;
      r.rx({ type: 'STATUS', uptimeMs: uptime(r), state: 3, flags: 0, fpsX10: 200, tempC: 40, bondCount: 1 });
    };
    step(cadenceMs(3, 0) - 1);
    await r.settle();
    expect(r.player.played()).toHaveLength(1);
    step(1);
    await r.settle();
    expect(r.player.played()).toHaveLength(2);
    expect(r.player.played()[1]).toMatchObject({ intensity: 2 });
    expect(r.player.played()[1]!.voice).toBeUndefined();
    // Level 2: the same id again, no new ACK; speaks once more; 1.0 s cadence.
    r.clear();
    r.rx(alert({ alertId: 9, sound: 3, tier: 3, level: 2 }));
    expect(r.sent('ALERT_ACK')).toEqual([]);
    step(1500);
    await r.settle();
    expect(r.player.played()[2]).toMatchObject({ voice: 'Wake up' });
    step(1000);
    await r.settle();
    expect(r.player.played()).toHaveLength(4);
    expect(r.player.played()[3]!.voice).toBeUndefined();
    expect(r.link.snapshot().visual).toMatchObject({ key: expect.stringMatching(/^\d+:9:2$/), alertId: 9, level: 2 });
  });

  test('an item still playing holds the next repeat (at most one DashPal item in the player)', async () => {
    const r = rig();
    await connect(r);
    r.player.holdNext(true);
    r.rx(alert({ alertId: 1, sound: 1, tier: 2 }));
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(r.player.delivered).toHaveLength(1);
    for (let i = 0; i < 10; i++) {
      r.clock.t += 1000; // the dashcam keeps talking: not stale
      r.rx({ type: 'STATUS', uptimeMs: uptime(r), state: 3, flags: 0, fpsX10: 200, tempC: 40, bondCount: 1 });
    }
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(r.player.delivered).toHaveLength(1);
    r.player.holdNext(false);
    r.player.release();
    await r.settle();
    expect(r.player.delivered).toHaveLength(2); // the one owed, at once (it is past due)
  });

  test('row 3: ALERT_FALLBACK cause 1, 2 or 3 stops the phone; cause 4 (the buzzer joined) keeps it playing; ALERT_STOP ends it', async () => {
    for (const cause of [1, 2, 3]) {
      const r = rig();
      await connect(r);
      r.rx(alert({ alertId: 5 }));
      await r.settle();
      r.rx({ type: 'ALERT_FALLBACK', alertId: 5, cause });
      await r.settle();
      const before = r.player.played().length;
      r.clock.t += 10_000;
      r.rx({ type: 'STATUS', uptimeMs: uptime(r), state: 3, flags: 0, fpsX10: 200, tempC: 40, bondCount: 1 });
      await r.settle();
      expect(r.player.played().length).toBe(before);
      expect(r.player.stops()).toBeGreaterThan(0);
      // the dashcam took it over: the phone owes no ALERT_ACK(0)
      expect(r.sent('ALERT_ACK').filter((a) => a.outcome === 0)).toEqual([]);
    }
    const r = rig();
    await connect(r);
    r.rx(alert({ alertId: 5 }));
    await r.settle();
    r.rx({ type: 'ALERT_FALLBACK', alertId: 5, cause: 4 });
    r.clock.t += 2500;
    r.rx({ type: 'STATUS', uptimeMs: uptime(r), state: 3, flags: 0, fpsX10: 200, tempC: 40, bondCount: 1 });
    await r.settle();
    expect(r.player.played()).toHaveLength(2);
    r.rx({ type: 'ALERT_STOP', alertId: 5, reason: 0 });
    r.clock.t += 5000;
    r.rx({ type: 'STATUS', uptimeMs: uptime(r), state: 3, flags: 0, fpsX10: 200, tempC: 40, bondCount: 1 });
    await r.settle();
    expect(r.player.played()).toHaveLength(2);
    expect(r.link.continuousAlertActive()).toBe(false);
  });

  test('row 2: no frame for 3 s mid continuous alert: the phone stops and sends ALERT_ACK(0) (the buzzer takes over)', async () => {
    const r = rig();
    await connect(r);
    r.rx(alert({ alertId: 77, sound: 2, tier: 2 }));
    await r.settle();
    r.clear();
    r.advance(3000);
    expect(r.sent('ALERT_ACK')).toEqual([]);
    r.advance(1);
    expect(r.sent('ALERT_ACK')).toEqual([{ type: 'ALERT_ACK', alertId: 77, outcome: 0 }]);
    const n = r.player.played().length;
    r.advance(10_000);
    await r.settle();
    expect(r.player.played().length).toBe(n);
  });

  test('row 4: route 1 when the phone cannot play: ALERT_ACK(0), haptic + visual only; route 0: no ACK, haptic + visual only', async () => {
    const r = rig();
    await connect(r);
    r.ctx.callActive = true;
    r.clear();
    r.rx(alert({ alertId: 3, sound: 2, tier: 2 }));
    await r.settle();
    expect(r.sent('ALERT_ACK')).toEqual([{ type: 'ALERT_ACK', alertId: 3, outcome: 0 }]);
    expect(r.player.played()).toEqual([expect.objectContaining({ silent: true, intensity: 3 })]);
    r.ctx.callActive = false;
    r.rx(alert({ alertId: 4, sound: 1, tier: 2, route: 0 }));
    await r.settle();
    expect(r.sent('ALERT_ACK')).toHaveLength(1);
    expect(r.player.played()[1]).toMatchObject({ silent: true, tone: 'dp_glance' });
    expect(r.player.played()[1]!.voice).toBeUndefined();
    r.advance(10_000);
    await r.settle();
    expect(r.player.played()).toHaveLength(2); // no repeats for a visual-only alert
    expect(r.link.snapshot().visual).toMatchObject({ alertId: 4, onPhone: false });
  });

  test('a routed ALERT handled past the ACK deadline (the JS thread woke late): ALERT_ACK(0), visual only, never a second chime; a late level step of a playing alert keeps it', async () => {
    const r = rig();
    await connect(r);
    r.clear();
    const sentAt = uptime(r);
    r.advance(LATE_ALERT_MS + 1);
    r.rx(alert({ alertId: 21, sound: 5, tier: 1, mode: 0, uptimeMs: sentAt }));
    await r.settle();
    expect(r.sent('ALERT_ACK')).toEqual([{ type: 'ALERT_ACK', alertId: 21, outcome: 0 }]);
    expect(r.player.played()).toEqual([expect.objectContaining({ silent: true })]);
    expect(r.link.snapshot().counters.lateAlerts).toBe(1);

    // On time: played and confirmed; its level step arriving late is still the same alert.
    r.clear();
    r.rx(alert({ alertId: 22, sound: 3, tier: 3, uptimeMs: uptime(r) }));
    await r.settle();
    expect(r.sent('ALERT_ACK')).toEqual([{ type: 'ALERT_ACK', alertId: 22, outcome: 1 }]);
    const stepAt = uptime(r);
    r.advance(LATE_ALERT_MS + 1);
    r.rx(alert({ alertId: 22, sound: 3, tier: 3, level: 1, uptimeMs: stepAt }));
    await r.settle();
    expect(r.sent('ALERT_ACK')).toEqual([{ type: 'ALERT_ACK', alertId: 22, outcome: 1 }]);
    expect(r.link.snapshot().visual).toMatchObject({ alertId: 22, onPhone: true });
  });

  test('the phone that can no longer play mid alert (a call starts) says ALERT_ACK(0) and stops', async () => {
    const r = rig();
    await connect(r);
    r.rx(alert({ alertId: 8 }));
    await r.settle();
    r.clear();
    r.ctx.callActive = true;
    r.advance(100);
    expect(r.sent('ALERT_ACK')).toEqual([{ type: 'ALERT_ACK', alertId: 8, outcome: 0 }]);
  });

  test('the player failing during a confirmed item: ALERT_ACK(0) and stop', async () => {
    const r = rig();
    await connect(r);
    r.player.holdNext(true);
    r.rx(alert({ alertId: 12 }));
    await new Promise<void>((resolve) => setImmediate(resolve));
    r.clear();
    r.link.playerUnavailable();
    expect(r.sent('ALERT_ACK')).toEqual([{ type: 'ALERT_ACK', alertId: 12, outcome: 0 }]);
    r.player.holdNext(false);
    r.player.release();
  });

  test('a tier-3 alert preempts the player; one-shots play once; a disconnect clears the table and stops the phone', async () => {
    const r = rig();
    await connect(r);
    const stops = r.player.stops();
    r.rx(alert({ alertId: 20, sound: 3, tier: 3 }));
    expect(r.player.stops()).toBe(stops + 1);
    await r.settle();
    r.rx(alert({ alertId: 21, sound: 5, tier: 1, mode: 0 }));
    await r.settle();
    expect(r.player.played().filter((d) => d.level === 1)).toHaveLength(1);
    r.advance(5000);
    await r.settle();
    expect(r.player.played().filter((d) => d.level === 1)).toHaveLength(1);
    expect(r.link.continuousAlertActive()).toBe(true);
    r.link.linkDown();
    expect(r.link.continuousAlertActive()).toBe(false);
    const n = r.player.played().length;
    r.advance(10_000);
    await r.settle();
    expect(r.player.played().length).toBe(n);
  });

  test('a reconnect clears the alert table; an active alert re-sent with route 0 is visual only', async () => {
    const r = rig();
    await connect(r);
    r.rx(alert({ alertId: 30 }));
    await r.settle();
    r.link.linkDown();
    await connect(r);
    r.clear();
    r.rx(alert({ alertId: 30, route: 0 }));
    await r.settle();
    expect(r.sent('ALERT_ACK')).toEqual([]);
    expect(r.player.played().at(-1)).toMatchObject({ silent: true });
  });
});

// ——— lifecycle, repair, malformed ———

describe('lifecycle', () => {
  test('INFO of another dashcam than the paired one is refused (the transport drops that connection and tries again); link v2 has no bond flag to check', () => {
    const r = rig();
    expect(r.link.infoRead(info({ peerBonded: false }))).toBe(true);
    expect(r.link.snapshot().firmware).toBe('dms-core 3.3');
    const r2 = rig();
    expect(r2.link.infoRead(info({ mac: [0, 0, 0, 0, 0, 0xff] }))).toBe(false);
    expect(r2.link.snapshot().lifecycle).not.toBe('needs_repair');
  });

  test('a soft repair (unknown_phone, downgrade) and a device that cannot prove itself (unverified) never stop anything; one link-up clears both', () => {
    const r = rig();
    r.link.needsRepair('unknown_phone');
    expect(r.link.snapshot()).toMatchObject({ lifecycle: 'needs_repair', repairCause: 'unknown_phone' });
    r.link.unverified();
    expect(r.link.snapshot().lifecycle).toBe('needs_repair'); // the dashcam's own word first
    r.link.linkUp(info());
    expect(r.link.snapshot()).toMatchObject({ lifecycle: 'connected', repairCause: null });
    r.link.linkDown();
    r.link.unverified();
    expect(r.link.snapshot().lifecycle).toBe('unverified');
    r.link.needsRepair('downgrade');
    expect(r.link.snapshot()).toMatchObject({ lifecycle: 'needs_repair', repairCause: 'downgrade' });
    r.link.linkUp(info());
    expect(r.link.snapshot().lifecycle).toBe('connected');
    r.link.linkDown();
    expect(r.link.snapshot().lifecycle).toBe('idle');
    // a new pairing clears them too
    r.link.unverified();
    r.link.setPaired(null);
    r.link.setPaired(PAIRED);
    expect(r.link.snapshot().lifecycle).toBe('idle');
  });

  test('Set up again of the same DashPal (a new pairedAt) clears its repair and unverified state before any reconnect', () => {
    const r = rig();
    r.link.needsRepair('unknown_phone');
    r.link.setPaired({ ...PAIRED }); // the same record again (a load): the repair stays
    expect(r.link.snapshot().lifecycle).toBe('needs_repair');
    r.link.setPaired({ ...PAIRED, pairedAt: PAIRED.pairedAt + 5000 });
    expect(r.link.snapshot()).toMatchObject({ lifecycle: 'idle', repairCause: null });
    r.link.unverified();
    expect(r.link.snapshot().lifecycle).toBe('unverified');
    r.link.setPaired({ ...PAIRED, pairedAt: PAIRED.pairedAt + 9000 });
    expect(r.link.snapshot().lifecycle).toBe('idle');
  });

  test('Bluetooth not allowed shows before a repair (nothing can be retried without it)', () => {
    const r = rig();
    r.link.needsRepair('unknown_phone');
    r.link.setBluetooth('unauthorized');
    expect(r.link.snapshot().lifecycle).toBe('unauthorized');
    r.link.setBluetooth('off');
    expect(r.link.snapshot().lifecycle).toBe('needs_repair');
  });

  test('row 22: Bluetooth off / not allowed; unpaired; connecting; idle', () => {
    const r = rig();
    expect(r.link.snapshot().lifecycle).toBe('idle');
    r.link.connecting();
    expect(r.link.snapshot().lifecycle).toBe('connecting');
    r.link.setBluetooth('off');
    expect(r.link.snapshot().lifecycle).toBe('bluetooth_off');
    r.link.setBluetooth('unauthorized');
    expect(r.link.snapshot().lifecycle).toBe('unauthorized');
    r.link.setBluetooth('on');
    expect(r.link.snapshot().lifecycle).toBe('idle');
    r.link.setPaired(null);
    expect(r.link.snapshot().lifecycle).toBe('unpaired');
  });

  test('row 25: shorter, unknown-type and other-version frames are ignored and counted; longer frames are accepted', async () => {
    const r = rig();
    await connect(r);
    r.link.frame([]);
    r.link.frame([0x03, 1, 0, 0]);
    r.link.frame([0x09, 1, 0, 0, 0]);
    r.link.frame([0x02, 2, 0, 0, 0, 0, 3, 0, 0, 0, 0]);
    r.link.frame([...encodeTx({ type: 'STATUS', uptimeMs: 5, state: 3, flags: STATUS_FLAG.LIVE, fpsX10: 200, tempC: 30, bondCount: 1 }), 0xaa, 0xbb]);
    await r.settle();
    expect(r.link.snapshot().counters.badFrames).toBe(4);
    expect(r.link.snapshot().status).toMatchObject({ state: 3, flags: STATUS_FLAG.LIVE });
    expect(r.errors).toEqual([]);
  });

  test('PAIRED is reported', async () => {
    const r = rig();
    await connect(r);
    r.rx({ type: 'PAIRED', bondCount: 2 });
    expect(r.paired).toEqual([2]);
  });

  test('a write that fails is reported, never thrown', async () => {
    const r = rig();
    await connect(r);
    r.failWrites = true;
    r.advance(1000);
    await r.settle();
    expect(r.errors.some((e) => e.startsWith('write STATE'))).toBe(true);
  });
});

// ——— coverage and the drive end (§7.5, §7.7) ———

describe('coverage (§7.5)', () => {
  beforeEach(async () => {
    await createTripsRepo(db).insert({ client_trip_id: TRIP, started_at: T0, tz: 'UTC', status: 'recording' }, T0);
  });

  const status = (r: Rig, flags: number, state = 3) =>
    r.rx({ type: 'STATUS', uptimeMs: uptime(r), state, flags, fpsX10: 200, tempC: 40, bondCount: 1 });

  test('row 24: covered = moving ∧ connected ∧ STATUS ≤ 5 s old ∧ calibrating/monitoring ∧ live ∧ primary', async () => {
    const r = rig();
    await connect(r);
    r.ctx.recording = true;
    const drive = { clientTripId: TRIP, recording: true, dryRun: false };
    const at = () => r.clock.t;
    status(r, STATUS_FLAG.LIVE | STATUS_FLAG.PRIMARY);
    r.link.row(row(at()), drive); // covered
    status(r, STATUS_FLAG.LIVE); // another phone is primary
    r.link.row(row(at()), drive);
    status(r, STATUS_FLAG.PRIMARY); // no live face
    r.link.row(row(at()), drive);
    status(r, STATUS_FLAG.LIVE | STATUS_FLAG.PRIMARY, 4); // limited
    r.link.row(row(at()), drive);
    status(r, STATUS_FLAG.LIVE | STATUS_FLAG.PRIMARY, 2); // calibrating counts
    r.link.row(row(at()), drive);
    r.link.row(row(at(), { speed: 2 }), drive); // under 5 mph: neither
    r.clock.t += 5001; // stale STATUS
    r.link.row(row(at()), drive);
    status(r, STATUS_FLAG.LIVE | STATUS_FLAG.PRIMARY);
    r.link.linkDown();
    r.link.row(row(at()), drive); // disconnected
    await r.settle();
    expect(await r.store.coverage(TRIP)).toEqual({ movingS: 7, coveredS: 2, lastSyncedAtMs: expect.any(Number) });
  });

  test('no dashcam writes on a dry-run host, outside a drive, or with no dashcam paired', async () => {
    const r = rig();
    await connect(r);
    r.link.row(row(r.clock.t), { clientTripId: TRIP, recording: true, dryRun: true });
    r.link.row(row(r.clock.t), { clientTripId: TRIP, recording: false, dryRun: false });
    r.link.setPaired(null);
    r.link.row(row(r.clock.t), { clientTripId: TRIP, recording: true, dryRun: false });
    await r.settle();
    expect(await r.store.coverage(TRIP)).toBeNull();
  });

  test('a replayed row (the journal taken in again) counts no coverage, stamps no sync time and is never the speed STATE sends', async () => {
    const r = rig();
    await connect(r);
    r.ctx.recording = true;
    const live = { clientTripId: TRIP, recording: true, dryRun: false };
    const replay = { ...live, replay: true };
    status(r, STATUS_FLAG.LIVE | STATUS_FLAG.PRIMARY);
    // Twenty minutes of the drive replayed at 60 km/h while the car now stands still.
    for (let i = 0; i < 30; i++) expect(r.link.row(row(r.clock.t, { speed: 16.7 }), replay)).toBeNull();
    r.advance(1000);
    const state = () => r.sent('STATE').at(-1)!;
    expect(state().flags & STATE_FLAG.SPEED_VALID).toBe(0);
    expect(state().speedCms).toBe(0);
    await r.settle();
    expect(await r.store.coverage(TRIP)).toBeNull();
    // A live row is the car now: its speed, its coverage.
    r.link.row(row(r.clock.t, { speed: 0 }), live);
    r.link.row(row(r.clock.t, { speed: 16.7 }), replay);
    r.advance(1000);
    expect(state().flags & STATE_FLAG.SPEED_VALID).toBe(STATE_FLAG.SPEED_VALID);
    expect(state().speedCms).toBe(0);
    await r.settle();
    expect(await r.store.coverage(TRIP)).toEqual({ movingS: 0, coveredS: 0, lastSyncedAtMs: expect.any(Number) });
  });

  test('a replayed row sends no STATE of its own (timers paused: only live rows do)', async () => {
    const r = rig({ timersPaused: () => true });
    await connect(r);
    r.ctx.recording = true;
    r.clear();
    for (let i = 0; i < 5; i++) {
      r.clock.t += 1000;
      r.link.row(row(r.clock.t), { clientTripId: TRIP, recording: true, dryRun: false, replay: true });
    }
    expect(r.sent('STATE')).toEqual([]);
    r.clock.t += 1000;
    r.link.row(row(r.clock.t), { clientTripId: TRIP, recording: true, dryRun: false });
    expect(r.sent('STATE')).toHaveLength(1);
  });

  test('the drive end stamps the sync time only when the drive had a live row in the last 30 s: never for one taken in from its journal', async () => {
    const r = rig();
    await connect(r, { nextSeq: 0 });
    expect(r.link.snapshot().synced).toBe(true);
    // An ended drive taken in at a launch: every row a replay.
    r.link.row(row(r.clock.t), { clientTripId: TRIP, recording: true, dryRun: false, replay: true });
    await r.link.beforeFinalize(TRIP);
    expect((await r.store.coverage(TRIP))?.lastSyncedAtMs ?? null).toBeNull();
    // A drive whose last live row is 31 s old.
    const OLD = '55555555-5555-4555-8555-555555555555';
    await createTripsRepo(db).insert({ client_trip_id: OLD, started_at: T0, tz: 'UTC', status: 'recording' }, T0);
    r.link.row(row(r.clock.t), { clientTripId: OLD, recording: true, dryRun: false });
    const liveAt = r.clock.t;
    r.advance(31_000);
    await r.link.beforeFinalize(OLD);
    expect((await r.store.coverage(OLD))?.lastSyncedAtMs).toBe(liveAt);
    // One whose last live row was a moment ago: stamped now.
    r.link.row(row(r.clock.t), { clientTripId: TRIP, recording: true, dryRun: false });
    r.advance(500);
    await r.link.beforeFinalize(TRIP);
    expect((await r.store.coverage(TRIP))?.lastSyncedAtMs).toBe(r.clock.t);
  });

  test('the drive end waits for the phone to catch up (≤ 3 s), then stamps the sync time; disconnected: no stamp', async () => {
    const r = rig();
    await connect(r, { nextSeq: 2 });
    // The dashcam announced 2 events; none is stored yet. The drive's last live row was just now.
    expect(r.link.snapshot().synced).toBe(false);
    r.link.row(row(r.clock.t), { clientTripId: TRIP, recording: true, dryRun: false });
    const ending = r.link.beforeFinalize(TRIP);
    r.rx(ev(0));
    r.rx(ev(1));
    await ending;
    const cov = await r.store.coverage(TRIP);
    expect(cov?.lastSyncedAtMs).toBeGreaterThanOrEqual(T0);
    expect(r.link.snapshot().synced).toBe(true);

    const r2 = rig();
    await connect(r2, { nextSeq: 5 });
    const t = r2.clock.t;
    await r2.link.beforeFinalize(TRIP);
    expect(r2.clock.t - t).toBeGreaterThanOrEqual(3000);
    expect(r2.clock.t - t).toBeLessThan(3300);
    expect((await r2.store.coverage(TRIP))?.lastSyncedAtMs ?? null).toBe(cov?.lastSyncedAtMs ?? null);

    const r3 = rig();
    const t3 = r3.clock.t;
    await r3.link.beforeFinalize(TRIP);
    expect(r3.clock.t).toBe(t3);
  });

  test('the drive-end wait never hangs on paused JS timers (Android in the background): it wakes on frames and ticks, and does not wait while timers are paused', async () => {
    // Timers that never fire, as on Android with the app in the background.
    let paused = false;
    // One database per test: each case ends its own drive.
    const [T2, T3, T4] = ['2', '3', '4'].map((d) => `${d.repeat(8)}-${d.repeat(4)}-4${d.repeat(3)}-8${d.repeat(3)}-${d.repeat(12)}`) as [string, string, string];
    for (const id of [T2, T3, T4]) await createTripsRepo(db).insert({ client_trip_id: id, started_at: T0, tz: 'UTC', status: 'recording' }, T0);
    const never = () => new Promise<void>(() => {});
    const r = rig({ delay: never, timersPaused: () => paused });
    await connect(r, { nextSeq: 2 });
    expect(r.link.snapshot().synced).toBe(false);
    r.link.row(row(r.clock.t), { clientTripId: TRIP, recording: true, dryRun: false });
    let done = false;
    const ending = r.link.beforeFinalize(TRIP).then(() => (done = true));
    await r.settle();
    expect(done).toBe(false);
    // Inbound frames wake the wait: the events land, the phone is synced, the drive is stamped.
    r.rx(ev(0));
    r.rx(ev(1));
    await ending;
    expect((await r.store.coverage(TRIP))?.lastSyncedAtMs).toBeGreaterThanOrEqual(T0);

    // Mid-wait the app goes to the background: the runtime ticks the link, and the wait ends.
    const r2 = rig({ delay: never, timersPaused: () => paused });
    await connect(r2, { nextSeq: 5 });
    let done2 = false;
    const ending2 = r2.link.beforeFinalize(T2).then(() => (done2 = true));
    await r2.settle();
    expect(done2).toBe(false);
    paused = true;
    r2.link.tick();
    await ending2;
    expect((await r2.store.coverage(T2))?.lastSyncedAtMs ?? null).toBeNull();

    // Already in the background at drive end: no wait at all; a synced link still stamps.
    const r3 = rig({ delay: never, timersPaused: () => paused });
    await connect(r3, { nextSeq: 5 });
    await r3.link.beforeFinalize(T3);
    expect((await r3.store.coverage(T3))?.lastSyncedAtMs ?? null).toBeNull();
    const r4 = rig({ delay: never, timersPaused: () => paused });
    await connect(r4, { nextSeq: 0 });
    expect(r4.link.snapshot().synced).toBe(true);
    r4.link.row(row(r4.clock.t), { clientTripId: T4, recording: true, dryRun: false });
    await r4.link.beforeFinalize(T4);
    expect((await r4.store.coverage(T4))?.lastSyncedAtMs).toBeGreaterThanOrEqual(T0);
    expect([...r.errors, ...r2.errors, ...r3.errors, ...r4.errors]).toEqual([]);
  });
});

// ——— the HUD halo's held alert (drive-screen design §5.3-5.4) ———

describe('held alert', () => {
  test('a continuous ALERT is held; a one-shot is not; ALERT_STOP lets go', async () => {
    const r = rig();
    await connect(r);
    expect(r.link.snapshot().held).toBeNull();
    r.rx(alert({ alertId: 40, sound: 5, tier: 1, mode: 0 }));
    await r.settle();
    expect(r.link.snapshot().held).toBeNull();
    const at = r.clock.t;
    r.rx(alert({ alertId: 41, sound: 1, tier: 2 }));
    expect(r.link.snapshot().held).toEqual({ sound: 1, tier: 2, level: 0, since: at });
    r.advance(1000);
    r.rx(alert({ alertId: 41, sound: 1, tier: 2, level: 1 }));
    expect(r.link.snapshot().held).toEqual({ sound: 1, tier: 2, level: 1, since: at });
    r.rx({ type: 'ALERT_STOP', alertId: 41, reason: 0 });
    expect(r.link.snapshot().held).toBeNull();
    await r.settle();
  });

  test('3 s with no frame: held goes null (and a wake is asked for it); the next frame brings it back; a drop empties it', async () => {
    const r = rig();
    await connect(r);
    r.rx(alert({ alertId: 50, sound: 1, tier: 2, route: 0 }));
    await r.settle();
    const last = r.clock.t;
    expect(r.link.nextWakeAt()).toBeLessThanOrEqual(last + 3001);
    r.advance(3000);
    expect(r.link.snapshot().held).toMatchObject({ sound: 1 });
    r.advance(1);
    expect(r.link.snapshot().held).toBeNull();
    r.rx({ type: 'STATUS', uptimeMs: uptime(r), state: 3, flags: 0, fpsX10: 150, tempC: 40, bondCount: 1 });
    expect(r.link.snapshot().held).toMatchObject({ sound: 1, since: last });
    r.link.linkDown();
    expect(r.link.snapshot().held).toBeNull();
    await r.settle();
  });

  test('a reconnect within 10 s on the same boot: the re-sent alert keeps its since and flashes as a resend', async () => {
    const r = rig();
    await connect(r);
    const since = r.clock.t;
    r.rx(alert({ alertId: 60, sound: 3, tier: 3, level: 1 }));
    await r.settle();
    r.advance(1000);
    r.link.linkDown();
    r.advance(4000);
    await connect(r);
    r.rx(alert({ alertId: 60, sound: 3, tier: 3, level: 1, route: 0 }));
    expect(r.link.snapshot().held).toEqual({ sound: 3, tier: 3, level: 1, since });
    expect(r.link.snapshot().visual).toMatchObject({ alertId: 60, resend: true });
    await r.settle();
  });

  test('not a resend: after more than 10 s, after a dashcam reboot, for another alert id, or at a higher level', async () => {
    // after 11 s
    let r = rig();
    await connect(r);
    r.rx(alert({ alertId: 61, route: 0 }));
    await r.settle();
    r.link.linkDown();
    r.advance(11_000);
    await connect(r);
    let at = r.clock.t;
    r.rx(alert({ alertId: 61, route: 0 }));
    expect(r.link.snapshot().held).toMatchObject({ since: at });
    expect(r.link.snapshot().visual).toMatchObject({ resend: false });
    await r.settle();

    // a different boot
    r = rig();
    await connect(r);
    r.rx(alert({ alertId: 62, route: 0 }));
    await r.settle();
    r.link.linkDown();
    r.advance(2000);
    await connect(r, { bootId: 0x1234 });
    at = r.clock.t;
    r.rx(alert({ alertId: 62, route: 0 }));
    expect(r.link.snapshot().held).toMatchObject({ since: at });
    expect(r.link.snapshot().visual).toMatchObject({ resend: false });
    await r.settle();

    // another id, then a higher level of the dropped one
    r = rig();
    await connect(r);
    r.rx(alert({ alertId: 63, route: 0 }));
    r.rx(alert({ alertId: 64, sound: 6, route: 0 }));
    await r.settle();
    r.link.linkDown();
    r.advance(2000);
    await connect(r);
    r.rx(alert({ alertId: 65, route: 0 }));
    expect(r.link.snapshot().visual).toMatchObject({ alertId: 65, resend: false });
    r.rx(alert({ alertId: 63, level: 2, route: 0 }));
    expect(r.link.snapshot().visual).toMatchObject({ alertId: 63, resend: false });
    r.rx(alert({ alertId: 64, sound: 6, route: 0 }));
    expect(r.link.snapshot().visual).toMatchObject({ alertId: 64, resend: true });
    await r.settle();
  });

  test('a repair or a pairing change forgets the dropped alerts', async () => {
    const r = rig();
    await connect(r);
    r.rx(alert({ alertId: 70, route: 0 }));
    await r.settle();
    r.link.linkDown();
    r.link.needsRepair('unknown_phone');
    r.link.setPaired(PAIRED);
    r.link.setPaired(null);
    r.link.setPaired(PAIRED);
    r.advance(1000);
    await connect(r);
    r.rx(alert({ alertId: 70, route: 0 }));
    expect(r.link.snapshot().visual).toMatchObject({ resend: false });
    await r.settle();
  });
});

describe('phone-first sound routing (BLE_PROTOCOL §1, §5)', () => {
  let nextId = 900;
  /** One routed ALERT, answered; then stopped, so it never stays playing into the next case. */
  async function answer(r: Rig, o: Partial<Extract<TxFrame, { type: 'ALERT' }>> = {}): Promise<number | undefined> {
    nextId += 1;
    const id = nextId;
    r.rx(alert({ alertId: id, uptimeMs: uptime(r), ...o }));
    await r.settle();
    const got = r.sent('ALERT_ACK').filter((a) => a.alertId === id);
    r.rx({ type: 'ALERT_STOP', alertId: id, reason: 0 });
    await r.settle();
    return got.length === 1 ? got[0]!.outcome : undefined;
  }
  const statesIn = (r: Rig, from: number) => r.writes.filter((w) => w.frame.type === 'STATE' && w.at >= from);

  test('(1) RoadWise in the background with no drive: STATE says can_play, and a routed ALERT is answered ACK(1) and played', async () => {
    const r = rig();
    await connect(r);
    r.ctx.foreground = false;
    // A flags change goes out in the quiet cadence, so the dashcam learns can_play from the background too.
    r.ctx.styleAllowsSound = false;
    r.advance(100);
    expect(r.sent('STATE').at(-1)!.flags & STATE_FLAG.CAN_PLAY).toBe(0);
    r.ctx.styleAllowsSound = true;
    r.advance(100);
    expect(r.sent('STATE').at(-1)!.flags & STATE_FLAG.CAN_PLAY).toBe(STATE_FLAG.CAN_PLAY);
    r.clear();
    r.rx(alert({ alertId: 7, uptimeMs: uptime(r) }));
    await r.settle();
    expect(r.sent('ALERT_ACK')).toEqual([{ type: 'ALERT_ACK', alertId: 7, outcome: 1 }]);
    const played = r.player.played();
    expect(played[0]).toMatchObject({ tone: 'dp_glance', acksBefore: 1 });
    expect(played[0]!.silent).toBeUndefined();
  });

  test('(2)-(4) the fresh probe decides: a call, a media volume under a quarter, headphones and vibration-only answer ACK(0); an unknown volume or output plays', async () => {
    const r = rig();
    await connect(r);
    r.ctx.foreground = false;
    expect(AUDIBLE_VOLUME_MIN).toBe(0.25);
    expect(await answer(r)).toBe(1);
    r.audio.callActive = true;
    expect(await answer(r)).toBe(0);
    r.audio.callActive = false;
    for (const [volume, outcome] of [
      [0, 0],
      [0.24, 0],
      [0.25, 1],
      [1, 1],
      [null, 1],
    ] as const) {
      r.audio.volume = volume;
      expect({ volume, ack: await answer(r) }).toEqual({ volume, ack: outcome });
    }
    for (const [headphones, outcome] of [
      [true, 0],
      [false, 1],
      [null, 1],
    ] as const) {
      r.audio.headphones = headphones;
      expect({ headphones, ack: await answer(r) }).toEqual({ headphones, ack: outcome });
    }
    r.ctx.styleAllowsSound = false;
    expect(await answer(r)).toBe(0);
    r.ctx.styleAllowsSound = true;
    r.ctx.callActive = true; // the host's own (iOS) call signal still counts
    expect(await answer(r)).toBe(0);
  });

  test('audible(): volume null or ≥ 0.25 and no headphones', () => {
    expect(audible({ callActive: false, volume: null, headphones: null })).toBe(true);
    expect(audible({ callActive: false, volume: 0.25, headphones: false })).toBe(true);
    expect(audible({ callActive: false, volume: 0.2499, headphones: null })).toBe(false);
    expect(audible({ callActive: false, volume: 1, headphones: true })).toBe(false);
  });

  test('(5) after a playback failure the phone answers ACK(0) for 30 s, then plays again', async () => {
    const r = rig();
    await connect(r);
    r.link.playerUnavailable();
    const failedAt = r.clock.t;
    expect(await answer(r)).toBe(0);
    r.clock.t = failedAt + PLAYER_RETRY_MS - 1;
    expect(await answer(r)).toBe(0);
    expect(r.sent('STATE').at(-1)!.flags & STATE_FLAG.CAN_PLAY).toBe(0);
    r.clock.t = failedAt + PLAYER_RETRY_MS + 1;
    expect(await answer(r)).toBe(1);
    r.advance(1000);
    expect(r.sent('STATE').at(-1)!.flags & STATE_FLAG.CAN_PLAY).toBe(STATE_FLAG.CAN_PLAY);
  });

  test('(6) a routed ALERT before the connection has any clock offset (no HELLO yet): ACK(0), shown only, counted late', async () => {
    const r = rig();
    expect(r.link.infoRead(info())).toBe(true);
    r.link.linkUp(info());
    r.advance(30);
    r.clear();
    r.rx(alert({ alertId: 3, uptimeMs: uptime(r) }));
    await r.settle();
    expect(r.sent('ALERT_ACK')).toEqual([{ type: 'ALERT_ACK', alertId: 3, outcome: 0 }]);
    expect(r.player.played()).toEqual([expect.objectContaining({ silent: true })]);
    expect(r.link.snapshot().counters.lateAlerts).toBe(1);
    // A route-0 ALERT is never late: no ACK at all.
    r.rx(alert({ alertId: 4, route: 0, uptimeMs: uptime(r) }));
    await r.settle();
    expect(r.sent('ALERT_ACK')).toHaveLength(1);
  });

  test('(7) the late rule on the live offset: a warning late after 750 ms, a critical after 400 ms', async () => {
    const r = rig();
    await connect(r);
    const at = async (ms: number, tier: number) => {
      const sentAt = uptime(r);
      r.clock.t += ms;
      return answer(r, { tier, sound: tier >= 3 ? 3 : 1, uptimeMs: sentAt });
    };
    expect(LATE_CRITICAL_ALERT_MS).toBe(400);
    // The connection's offset is good to a few ms (5 ms echoes): 10 ms either side of each bound.
    expect(await at(LATE_ALERT_MS - 10, 2)).toBe(1);
    expect(await at(LATE_ALERT_MS + 10, 2)).toBe(0);
    expect(await at(LATE_CRITICAL_ALERT_MS - 10, 3)).toBe(1);
    expect(await at(LATE_CRITICAL_ALERT_MS + 10, 3)).toBe(0);
    // A warning 600 ms late is still played; a critical that late is not.
    expect(await at(600, 2)).toBe(1);
    expect(await at(600, 3)).toBe(0);
    expect(r.link.snapshot().counters.lateAlerts).toBe(3);
  });

  test('(7b) after 8 h asleep with the dashcam clock 1152 ms behind (40 ppm), an on-time ALERT is not called late; TIME_PINGs go out on that frame', async () => {
    const r = rig();
    await connect(r);
    r.clock.t += 8 * 3_600_000; // suspended: no tick at all
    r.clear();
    expect(await answer(r, { uptimeMs: uptime(r) - 1152 })).toBe(1);
    expect(r.sent('TIME_PING').length).toBeGreaterThanOrEqual(1);
    expect(r.writes.findIndex((w) => w.frame.type === 'TIME_PING')).toBeGreaterThan(r.writes.findIndex((w) => w.frame.type === 'ALERT_ACK'));
    expect(r.link.snapshot().counters.lateAlerts).toBe(0);
  });

  test('(7c) a live sample 11 min old (the resync pings went unanswered) is not used: the late rule is skipped and pings go out at once', async () => {
    const r = rig();
    await connect(r);
    const t0 = r.clock.t;
    // Ticks through the 10-min resync: its pings go out, the dashcam never answers them.
    while (r.clock.t < t0 + 11 * 60_000) r.advance(1000);
    r.clear();
    const sentAt = uptime(r);
    r.clock.t += 2000; // 2 s late by any offset
    expect(await answer(r, { uptimeMs: sentAt })).toBe(1);
    expect(r.sent('TIME_PING').length).toBeGreaterThanOrEqual(1);
  });

  test('(7d)-(7e) the live offset: a newer sample with a slightly longer round trip replaces it, a much slower one does not; a clock gone back or an old one is unusable', () => {
    const w0 = nextLiveOffset([], 100, 40, 1000);
    const l0 = { offsetMs: 100, rttMs: 40, at: 1000 };
    expect(w0).toEqual([l0]);
    // 5 min later: 60 ms (half 30) ≤ 20 + 300 s × 0.1 ms/s = 50 → replaced; 400 ms (half 200) → kept.
    expect(nextLiveOffset(w0, 105, 60, 1000 + 300_000)).toEqual([{ offsetMs: 105, rttMs: 60, at: 301_000 }]);
    const slow = nextLiveOffset(w0, 300, 400, 1000 + 300_000);
    expect(usableLiveOffset(slow, 1000 + 300_000)).toEqual(l0);
    // The phone's clock went back: the new sample wins, and no older one is usable meanwhile.
    expect(nextLiveOffset(w0, 90, 400, 500)).toEqual([{ offsetMs: 90, rttMs: 400, at: 500 }]);
    expect(usableLiveOffset(w0, 1000 + LIVE_OFFSET_MAX_AGE_MS)).toEqual(l0);
    expect(usableLiveOffset(w0, 1000 + LIVE_OFFSET_MAX_AGE_MS + 1)).toBeNull();
    expect(usableLiveOffset(w0, 999)).toBeNull();
    expect(usableLiveOffset([], 1000)).toBeNull();
    // The window stays bounded.
    let w = w0;
    for (let i = 1; i <= 100; i++) w = nextLiveOffset(w, 100, 40 + i * 10, 1000 + i);
    expect(w.length).toBeLessThanOrEqual(LIVE_OFFSET_WINDOW_MAX);
    expect(usableLiveOffset(w, 1100)).toEqual(l0);
  });

  test('(7g) a fast sample ages out: the best slower sample of the last 10 min takes over, and a slower one after an expired sample is used at once', () => {
    const min = 60_000;
    // Front at 20 ms, then the background's wake-laden 200-300 ms echoes 9 and 10 min later.
    let w = nextLiveOffset([], 100, 20, 0);
    w = nextLiveOffset(w, 101, 300, 9 * min);
    w = nextLiveOffset(w, 102, 200, 10 * min);
    expect(usableLiveOffset(w, 10 * min)).toMatchObject({ rttMs: 20 });
    // At 11 min the 20 ms sample is gone: the 200 ms one (it beats the 300 ms one) is the live offset.
    expect(usableLiveOffset(w, 11 * min)).toMatchObject({ rttMs: 200, offsetMs: 102 });
    expect(usableLiveOffset(w, 20 * min)).toMatchObject({ rttMs: 200 });
    expect(usableLiveOffset(w, 20 * min + 1)).toBeNull();
    // An 11-min-old 40 ms sample, then a 200 ms echo (an iPhone woken from the background): usable.
    const old = nextLiveOffset([], 100, 40, 0);
    expect(usableLiveOffset(nextLiveOffset(old, 103, 200, 11 * min), 11 * min)).toEqual({ offsetMs: 103, rttMs: 200, at: 11 * min });
  });

  test('(7f) the late rule follows the live offset while the stored row keeps the best round trip for event dating', async () => {
    const r = rig();
    await connect(r);
    const best = await r.store.latestBoot(CAM, 0xdeadbeef);
    expect(best?.rttMs).not.toBeNull();
    const t0 = r.clock.t;
    while (r.clock.t < t0 + 10 * 60_000 + 50) r.advance(100);
    // The resync: the dashcam's clock has drifted 800 ms behind; slower echoes (40 ms) carry it.
    const pings = r.sent('TIME_PING').filter((p) => p.epochMs >= t0 + 10 * 60_000 - 200);
    expect(pings.length).toBeGreaterThanOrEqual(1);
    for (const ping of pings) {
      const backAt = ping.epochMs + 40;
      r.clock.t = Math.max(r.clock.t, backAt);
      r.rx({ type: 'TIME_ECHO', reqId: ping.reqId, uptimeMs: ping.epochMs + 20 - T0 + UP - 800 });
    }
    await r.settle();
    // On time by the dashcam's own clock: the live offset sees it so; the old best offset would call it 800 ms late.
    expect(await answer(r, { uptimeMs: uptime(r) - 800 })).toBe(1);
    const stored = await r.store.latestBoot(CAM, 0xdeadbeef);
    expect(stored).toMatchObject({ rttMs: best!.rttMs, offsetMs: best!.offsetMs });
    expect(Math.abs(best!.offsetMs! - (T0 - UP))).toBeLessThanOrEqual(5);
  });

  test('(8) STATE cadence: every ≥ 900 ms in front; quiet in the background with no drive (only a flags change); every ≥ 900 ms while an alert sounds, ≥ 450 ms during a critical', async () => {
    expect([STATE_EVERY_MS, STATE_EVERY_CRITICAL_MS]).toEqual([900, 450]);
    const r = rig();
    await connect(r);
    let from = r.clock.t + 1;
    for (let i = 0; i < 50; i++) r.advance(100);
    let gaps = statesIn(r, from)
      .slice(1)
      .map((w, i) => w.at - statesIn(r, from)[i]!.at);
    expect(gaps.length).toBeGreaterThanOrEqual(4);
    for (const g of gaps) expect(g).toBeGreaterThanOrEqual(900);

    // Background, no drive, nothing sounding: no STATE for a minute of ticks.
    r.ctx.foreground = false;
    from = r.clock.t + 1;
    for (let i = 0; i < 600; i++) r.advance(100);
    expect(statesIn(r, from)).toEqual([]);
    // can_play flips (vibration only): exactly one STATE.
    r.ctx.styleAllowsSound = false;
    from = r.clock.t + 1;
    for (let i = 0; i < 100; i++) r.advance(100);
    expect(statesIn(r, from).map((w) => (w.frame as Extract<RxFrame, { type: 'STATE' }>).flags & STATE_FLAG.CAN_PLAY)).toEqual([0]);
    r.ctx.styleAllowsSound = true;
    r.advance(100);

    // A warning sounding in the background: active again.
    r.rx(alert({ alertId: 50, uptimeMs: uptime(r) }));
    await r.settle();
    from = r.clock.t + 1;
    for (let i = 0; i < 50; i++) {
      r.advance(100);
      // The dashcam's STATUS every 500 ms to the routed phone keeps the alert from going stale.
      if (i % 5 === 0) r.rx({ type: 'STATUS', uptimeMs: uptime(r), state: 3, flags: STATUS_FLAG.LIVE, fpsX10: 150, tempC: 40, bondCount: 1 });
    }
    const warn = statesIn(r, from);
    gaps = warn.slice(1).map((w, i) => w.at - warn[i]!.at);
    expect(gaps.length).toBeGreaterThanOrEqual(4);
    for (const g of gaps) expect(g).toBeGreaterThanOrEqual(900);
    r.rx({ type: 'ALERT_STOP', alertId: 50, reason: 0 });
    await r.settle();

    // A critical: every 450-500 ms (the ticks are 100 ms apart here).
    r.rx(alert({ alertId: 51, sound: 3, tier: 3, uptimeMs: uptime(r) }));
    await r.settle();
    from = r.clock.t + 1;
    for (let i = 0; i < 30; i++) {
      r.advance(100);
      r.rx({ type: 'STATUS', uptimeMs: uptime(r), state: 3, flags: STATUS_FLAG.LIVE, fpsX10: 150, tempC: 40, bondCount: 1 });
    }
    const crit = statesIn(r, from);
    gaps = crit.slice(1).map((w, i) => w.at - crit[i]!.at);
    expect(gaps.length).toBeGreaterThanOrEqual(4);
    for (const g of gaps) {
      expect(g).toBeGreaterThanOrEqual(450);
      expect(g).toBeLessThanOrEqual(500);
    }
    r.rx({ type: 'ALERT_STOP', alertId: 51, reason: 0 });
    await r.settle();
    // Nothing sounding any more: quiet again.
    from = r.clock.t + 1;
    for (let i = 0; i < 100; i++) r.advance(100);
    expect(statesIn(r, from)).toEqual([]);
    // Quiet asks for no wake for a STATE (only the 10-min resync and what the alerts need).
    expect(r.link.nextWakeAt()! - r.clock.t).toBeGreaterThan(60_000);
  });

  test('(8) quiet from the start: the first STATE after RESUME still goes out, then none', async () => {
    const r = rig();
    r.ctx.foreground = false;
    await connect(r);
    expect(r.sent('STATE')).toHaveLength(1);
    for (let i = 0; i < 300; i++) r.advance(100);
    expect(r.sent('STATE')).toHaveLength(1);
  });

  test('(9) a fresh probe for each new routed ALERT; ticks read the memo', async () => {
    const r = rig();
    await connect(r);
    r.advance(1000);
    r.probes.length = 0;
    r.rx(alert({ alertId: 60, uptimeMs: uptime(r) }));
    expect(r.probes[0]).toBe(true);
    r.probes.length = 0;
    r.advance(1000);
    expect(r.probes.length).toBeGreaterThan(0);
    expect(r.probes.every((f) => f === false)).toBe(true);
    // A route-0 ALERT asks nothing fresh.
    r.probes.length = 0;
    r.rx(alert({ alertId: 61, route: 0, uptimeMs: uptime(r) }));
    expect(r.probes.includes(true)).toBe(false);
    await r.settle();
  });

  test('(9) a throwing probe is reported and reads as unknown (it plays)', async () => {
    const r = rig();
    await connect(r);
    // The rig's probe reads r.audio: make that read throw.
    Object.defineProperty(r, 'audio', {
      get() {
        throw new Error('probe failed');
      },
    });
    expect(await answer(r)).toBe(1);
    expect(r.errors.some((e) => e.startsWith('audioOutput:'))).toBe(true);
  });

  test('(11) holdAwake: before the ACK on every routed ALERT; at most once a second on frames while an alert sounds; never for a route-0 ALERT with nothing sounding; a throw is reported and the ALERT still answered', async () => {
    expect([HOLD_AWAKE_MS, HOLD_AWAKE_EVERY_MS]).toEqual([5000, 1000]);
    const r = rig();
    await connect(r);
    r.rx(alert({ alertId: 70, route: 0, uptimeMs: uptime(r) }));
    await r.settle();
    expect(r.holds).toEqual([]);
    r.rx({ type: 'ALERT_STOP', alertId: 70, reason: 0 });
    r.clear();
    r.rx(alert({ alertId: 71, uptimeMs: uptime(r) }));
    expect(r.holds).toHaveLength(1);
    expect(r.holds[0]!.ms).toBe(HOLD_AWAKE_MS);
    const ackAt = r.writes.findIndex((w) => w.frame.type === 'ALERT_ACK');
    expect(ackAt).toBeGreaterThanOrEqual(r.holds[0]!.writesBefore);
    expect(r.holds[0]!.writesBefore).toBe(0);
    await r.settle();
    // STATUS every 200 ms for 3 s while it sounds: renewed about once a second.
    const first = r.holds[0]!.at;
    for (let i = 0; i < 15; i++) {
      r.clock.t += 200;
      r.rx({ type: 'STATUS', uptimeMs: uptime(r), state: 3, flags: STATUS_FLAG.LIVE, fpsX10: 150, tempC: 40, bondCount: 1 });
    }
    const renewals = r.holds.slice(1).map((h) => h.at - first);
    expect(renewals).toEqual([1000, 2000, 3000]);
    // Stopped: frames hold nothing.
    r.rx({ type: 'ALERT_STOP', alertId: 71, reason: 0 });
    await r.settle();
    const n = r.holds.length;
    for (let i = 0; i < 10; i++) {
      r.clock.t += 500;
      r.rx({ type: 'STATUS', uptimeMs: uptime(r), state: 3, flags: STATUS_FLAG.LIVE, fpsX10: 150, tempC: 40, bondCount: 1 });
    }
    expect(r.holds).toHaveLength(n);
    // A wake lock that throws: reported, the ALERT answered all the same.
    r.holdThrows = true;
    r.clear();
    r.rx(alert({ alertId: 72, uptimeMs: uptime(r) }));
    await r.settle();
    expect(r.sent('ALERT_ACK')).toEqual([{ type: 'ALERT_ACK', alertId: 72, outcome: 1 }]);
    expect(r.errors.some((e) => e.startsWith('holdAwake:'))).toBe(true);
  });
});

// ——— the aiming picture's frames on the paired link (a re-aim) ———

describe('the aiming frames on the paired link', () => {
  test('AIM and VIEW_STATE reach the view listeners, only while subscribed; a listener that throws is reported', async () => {
    const r = rig();
    await connect(r);
    const got: string[] = [];
    const off = r.link.onViewFrames((f) => got.push(f.type === 'AIM' ? `aim:${f.score}` : `view:${f.on}:${f.reason}:${f.leftS}`));
    r.rx({ type: 'VIEW_STATE', on: 1, reason: 0, leftS: 600 });
    r.rx({ type: 'AIM', seq: 3, score: 92, hint: 0, flags: 7, iod: 50, yaw: -4, pitch: 2 });
    off();
    r.rx({ type: 'AIM', seq: 4, score: 40, hint: 2, flags: 3, iod: 50, yaw: 0, pitch: 0 });
    expect(got).toEqual(['view:1:0:600', 'aim:92']);
    r.link.onViewFrames(() => {
      throw new Error('boom');
    });
    r.rx({ type: 'VIEW_STATE', on: 0, reason: 3, leftS: 590 });
    expect(r.errors.some((e) => e.includes('boom'))).toBe(true);
  });

  test('a command may go without response (the picture acknowledgements)', async () => {
    const r = rig();
    await connect(r);
    r.clear();
    await r.link.command(11, 7, { withResponse: false });
    await r.link.command(10, 1);
    expect(r.writes.filter((w) => w.frame.type === 'COMMAND').map((w) => [w.frame, w.withResponse])).toEqual([
      [{ type: 'COMMAND', op: 11, arg: 7 }, false],
      [{ type: 'COMMAND', op: 10, arg: 1 }, true],
    ]);
  });
});

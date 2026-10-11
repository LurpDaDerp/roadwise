/** @jest-environment node */
import type { AlertPlayer } from '@/core/alerts/player';
import type { AlertDecision } from '@/core/alerts/types';
import type { FeatureRow } from '@/core/engine/types';
import { createSqlJsDb } from '@/data/db/__fixtures__/sqljsDriver';
import { createTripsRepo, migrate, type Db } from '@/data/db';

import { cadenceMs } from '../alerts';
import type { PairedDashcam } from '../keys';
import { createDashcamLink, type DashcamLink, type LinkContext } from '../link';
import {
  decodeInfo,
  decodeRx,
  encodeInfo,
  encodeTx,
  STATE_FLAG,
  STATUS_FLAG,
  type DashcamInfo,
  type RxFrame,
  type TxFrame,
} from '../protocol';
import { BOOT_GENERATION, createDashcamStore, type DashcamStore } from '../store';

const T0 = 1_791_600_000_000;
const CAM = 'a4cf12b3c4d5';
const PAIRED: PairedDashcam = { dashcamId: CAM, peripheralId: 'periph-1', name: 'DashPal-C4D5', pairedAt: T0 - 1 };
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
}

let db: Db;
let n = 0;

beforeEach(async () => {
  db = await createSqlJsDb();
  await migrate(db);
  n = 0;
});

function rig(over: { store?: Partial<DashcamStore> } = {}): Rig {
  const clock = { t: T0 };
  const writes: Written[] = [];
  const errors: string[] = [];
  const wakes: (number | null)[] = [];
  const paired: number[] = [];
  const player = fakePlayer();
  player.setClock(() => clock.t);
  player.countAcks(() => writes.filter((w) => w.frame.type === 'ALERT_ACK').length);
  const ctx: LinkContext = { recording: false, foreground: true, playerAvailable: true, styleAllowsSound: true, callActive: false, buzzerToo: false };
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
    delay: async (ms) => {
      clock.t += ms;
      await new Promise<void>((resolve) => setImmediate(resolve));
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

  test('row 4: no can_play under vibration-only, on a call, with the player unavailable, or in the background outside a drive', async () => {
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
    r.ctx.playerAvailable = false;
    expect(can()).toBe(false);
    r.ctx.playerAvailable = true;
    r.ctx.foreground = false;
    expect(can()).toBe(false);
    r.ctx.recording = true;
    expect(can()).toBe(true);
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

  test('a wake time is always asked for while connected (the timer is best effort)', async () => {
    const r = rig();
    await connect(r);
    r.advance(1000);
    const at = r.wakes.at(-1);
    expect(at).not.toBeNull();
    expect(at!).toBeLessThanOrEqual(r.clock.t + 1000);
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
    expect(r.link.snapshot().visual).toMatchObject({ key: '9:2' });
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
  test('row 21: INFO peer_bonded = 0, or another dashcam: needs_repair, the encrypted attributes are never touched', () => {
    const r = rig();
    expect(r.link.infoRead(info({ peerBonded: false }))).toBe(false);
    expect(r.link.snapshot()).toMatchObject({ lifecycle: 'needs_repair', repairCause: 'peer_not_bonded' });
    const r2 = rig();
    expect(r2.link.infoRead(info({ mac: [0, 0, 0, 0, 0, 0xff] }))).toBe(false);
    expect(r2.link.snapshot()).toMatchObject({ lifecycle: 'needs_repair', repairCause: 'wrong_dashcam' });
    // a later successful link-up (re-paired) clears it
    r2.link.linkUp(info());
    expect(r2.link.snapshot().lifecycle).toBe('connected');
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

  test('the drive end waits for the phone to catch up (≤ 3 s), then stamps the sync time; disconnected: no stamp', async () => {
    const r = rig();
    await connect(r, { nextSeq: 2 });
    // The dashcam announced 2 events; none is stored yet.
    expect(r.link.snapshot().synced).toBe(false);
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
});

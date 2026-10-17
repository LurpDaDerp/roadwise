/** @jest-environment node */
// Pairing v3 end to end (docs/BLE_PROTOCOL.md §2, §2.2, §3.3, §4): the app's setup flow, transport
// and runtime against the firmware's link and auth cores in the simulator: one-tap pairing with no
// code, the setup hold (the provisional phone, the advertised services, the known stop), its commit
// on Next, its undo on Cancel, on the phone's absence and on 5 or 10 presses, a reconnect under the
// new key during the hold, Set up again with prev_id, Add another phone, and the session rules kept
// from link v2. A scripted raw phone plays the second phone, the spoofs and the injector, built on
// the app's own auth.ts.
import { blindedId, DIR_PD, pairFin, pairKeysV3, pairOpen, parseAuthRecord, R, sealRaw, sessionFin, sessionKeys, sessionRequest } from '../auth';
import { randomBytes } from '../crypto';
import { COMMAND, decodeInfo, encodeRx, fromHex, STATE_FLAG, toHex } from '../protocol';
import type { SetupFlow, SetupPhase, SetupStart } from '../setup';
import { describeSim } from './suite';
import { CAM, linkedA, phoneKey, scenario, type Phone, type World } from './world';

const BOOT = '5eed0003';
const END: SetupPhase['kind'][] = ['done', 'failed', 'cancelled', 'busy', 'denied'];

async function setupTo(w: World, flow: SetupFlow, kinds: SetupPhase['kind'][], maxMs = 90_000): Promise<SetupPhase> {
  await w.until(() => kinds.includes(flow.phase().kind), maxMs, `setup ${kinds.join('/')} (at ${flow.phase().kind})`);
  return flow.phase();
}

interface Run {
  flow: SetupFlow;
  /** world time of the Pair tap, and of each phase's first appearance */
  tapAt: number;
  at: Partial<Record<SetupPhase['kind'], number>>;
  end: SetupPhase;
}

/** The app's setup: start, Pair on screen 1, then Next on screen 2 (`next: false`: stop on screen 2). */
async function setUp(w: World, p: Phone, opts: SetupStart = {}, o: { next?: boolean } = {}): Promise<Run> {
  const flow = p.setup();
  const at: Run['at'] = {};
  flow.subscribe((ph) => void (at[ph.kind] ??= w.W));
  void flow.start(opts);
  const first = await setupTo(w, flow, ['confirm', ...END]);
  if (first.kind !== 'confirm') return { flow, tapAt: w.W, at, end: first };
  const tapAt = w.W;
  flow.pair();
  const second = await setupTo(w, flow, ['instructions', ...END]);
  if (second.kind !== 'instructions' || o.next === false) return { flow, tapAt, at, end: second };
  flow.next();
  return { flow, tapAt, at, end: await setupTo(w, flow, END) };
}

const phonesLine = async (w: World): Promise<string> => (await w.dashcam('PHONES')).find((l) => l.startsWith('PHONES')) ?? '';
const ctx = async (w: World): Promise<string> => (await w.dashcam('CTXQ')).find((l) => l.startsWith('CTX')) ?? '';

/** A raw phone on its own connection (the second phone, spoofs and injectors), over the simulator's lines. */
function rawPhone(w: World, conn: number) {
  const ask = async (line: string, prefix: string): Promise<string> => (await w.dashcam(line)).find((l) => l.startsWith(prefix)) ?? '';
  const self = {
    conn,
    connect: () => w.dashcam(`C ${conn}`),
    disconnect: () => w.dashcam(`D ${conn}`),
    info: async () => decodeInfo(fromHex((await ask(`INFO ${conn}`, `INFO ${conn} `)).split(' ')[2] ?? ''))!,
    write: async (bytes: Uint8Array | number[]) => (await ask(`AW ${conn} ${toHex(bytes)}`, `AW ${conn} `)).split(' ')[2],
    read: async () => fromHex((await ask(`AR ${conn}`, `AR ${conn} `)).split(' ')[2] ?? ''),
    /** a PAIR_OPEN (and its PAIR_FIN when the answer confirms the key) */
    async pair(o: { idP?: Uint8Array; prev?: { id: Uint8Array; kPair: Uint8Array } | null; fin?: boolean } = {}) {
      const info = await self.info();
      const idP = o.idP ?? randomBytes(8);
      const a = randomBytes(32);
      const open = pairOpen({ mac: info.mac, nc: info.nonce!, idP, a, np: randomBytes(16), prev: o.prev ?? null });
      await self.write(open.bytes);
      const resp = parseAuthRecord(await self.read());
      if (resp.kind !== 'pair_resp') return { open, resp, idP, kPair: null as Uint8Array | null, fin: null as unknown };
      const keys = pairKeysV3({ mac: info.mac, nc: info.nonce!, open: open.bytes, a, B: resp.B, Nd: resp.Nd })!;
      let fin: unknown = null;
      if (o.fin !== false) {
        await self.write(pairFin(keys.proofP));
        fin = parseAuthRecord(await self.read());
      }
      return { open, resp, idP, kPair: keys.K_pair, fin };
    },
    /** a session with this key; `badFin`: a wrong proof */
    async session(id: Uint8Array, kPair: Uint8Array, o: { badFin?: boolean } = {}) {
      const info = await self.info();
      const np = randomBytes(16);
      await self.write(sessionRequest(kPair, info.mac, info.nonce!, np));
      const resp = parseAuthRecord(await self.read());
      if (resp.kind !== 'session_resp') return { resp, keys: null };
      const keys = sessionKeys(kPair, info.mac, id, np, resp.Nd);
      const proof = o.badFin ? new Uint8Array(16).fill(7) : keys.proofP;
      await self.write(sessionFin(proof));
      return { resp: parseAuthRecord(await self.read()), keys };
    },
  };
  return self;
}

describeSim('DashPal pairing v3 (firmware simulator ↔ app setup flow)', () => {
  test.each(['ios', 'android'] as const)('a new DashPal (%s): advertised new; one tap pairs, held provisionally (setup advertised, a known stop, no can_play), Next commits; the window closes and the app connects with the committed key', (platform) =>
    scenario({ bootId: BOOT, bonded: [] }, async (w) => {
      expect(w.lines('ADV 00f0')).toHaveLength(1);
      expect(w.lines('WINDOW 1')).toHaveLength(1); // no phone: open from boot
      const p = await w.addPhone({ name: 'P', conn: 1, platform });
      const r = await setUp(w, p, {}, { next: false });
      expect(r.end).toMatchObject({ kind: 'instructions', reconnecting: false });
      // nothing went to the dashcam before the tap
      expect(w.log.some((l) => l.dir === 'in' && l.line.startsWith('AW ') && l.at < r.tapAt)).toBe(false);
      // tap → check mark within a few seconds (built to finish within 10 s)
      expect(r.at.connected! - r.tapAt).toBeLessThanOrEqual(3500);
      const paired = w.lines('PAIRED 1 ');
      expect(paired).toHaveLength(1);
      const id = paired[0]!.line.split(' ')[2]!;
      expect(w.holdConn).toBe(1);
      expect(w.adv).toBe('00f1');
      expect(w.buzzer().filter((b) => b.line === 'PLAY once 6')).toHaveLength(1);
      // held, not stored
      expect(await phonesLine(w)).toBe('PHONES 0');
      // the setup's STATE: never can_play; no speed reported → the engine takes the car as stopped
      const states = w.rxOf('STATE', 1);
      expect(states.length).toBeGreaterThan(0);
      expect(states.every((s) => (s.f.flags & (STATE_FLAG.CAN_PLAY | STATE_FLAG.SPEED_VALID)) === 0)).toBe(true);
      expect((await ctx(w)).split(' ')[1]).toMatch(/^0(\.0+)?$/);
      expect(w.rxOf('COMMAND', 1).map((c) => c.f.op)).toEqual(expect.arrayContaining([COMMAND.HELLO, COMMAND.PAIR_CONFIRM, COMMAND.AIM]));
      expect(w.txOf('PAIRED', 1)).toHaveLength(1);
      r.flow.next();
      const end = await setupTo(w, r.flow, END);
      expect(end).toMatchObject({ kind: 'done', phones: 1, notAllYours: false, paired: { dashcamId: CAM, name: 'DashPal-C4D5', secure: true } });
      expect(w.lines(`COMMIT 1 ${id}`)).toHaveLength(1);
      expect(w.holdConn).toBeNull();
      expect(w.lines('WINDOW 0')).toHaveLength(1);
      expect(w.adv).toBe('0001');
      expect(w.txOf('SETUP_RESULT', 1).map((x) => [x.f.op, x.f.code, x.f.bondCount])).toEqual([[8, R.OK, 1]]);
      const auth = (await p.secrets.readAuth())!;
      expect(auth.phoneId).toBe(id);
      expect(await phonesLine(w)).toBe(`PHONES 1 ${id}`);
      expect(await p.secrets.readPendingAuth()).toBeNull();
      await w.connected(p);
      expect(p.errors.filter((e) => !e.startsWith('transport'))).toEqual([]);
    }));

  test('the setup STATE carries a fresh speed: the engine reads it during the hold', () =>
    scenario({ bootId: BOOT, bonded: [] }, async (w) => {
      const p = await w.addPhone({ name: 'P', conn: 1, platform: 'android' });
      p.setupSpeed.cms = 1000;
      const r = await setUp(w, p, {}, { next: false });
      expect(r.end.kind).toBe('instructions');
      await w.advance(2000);
      expect(w.rxOf('STATE', 1).at(-1)!.f).toMatchObject({ flags: STATE_FLAG.SPEED_VALID, speedCms: 1000 });
      expect(Number((await ctx(w)).split(' ')[1])).toBeCloseTo(36, 0);
      await r.flow.cancel();
    }));

  test('a second phone during the hold: INFO says busy, PAIR_OPEN gets R_BUSY; after the commit the window is closed', () =>
    scenario({ bootId: BOOT, bonded: [] }, async (w) => {
      const p = await w.addPhone({ name: 'P', conn: 1 });
      const r = await setUp(w, p, {}, { next: false });
      expect(r.end.kind).toBe('instructions');
      const x = rawPhone(w, 5);
      await x.connect();
      const info = await x.info();
      expect([info.pairingOpen, info.setupBusy, info.bondCount]).toEqual([true, true, 1]);
      expect((await x.pair()).resp).toEqual({ kind: 'result', code: R.BUSY });
      r.flow.next();
      expect((await setupTo(w, r.flow, END)).kind).toBe('done');
      expect((await x.info()).pairingOpen).toBe(false);
      expect((await x.pair()).resp).toEqual({ kind: 'result', code: R.NOT_NOW });
    }));

  test('Cancel after the pairing: COMMAND 9, SETUP_RESULT(9, R_OK), the provisional phone forgotten, the DashPal ready to pair again and the link ended 1 s later; the key is gone; a new setup pairs at once', () =>
    scenario({ bootId: BOOT, bonded: [] }, async (w) => {
      const p = await w.addPhone({ name: 'P', conn: 1 });
      const r = await setUp(w, p, {}, { next: false });
      const id = w.lines('PAIRED 1 ')[0]!.line.split(' ')[2]!;
      const t0 = w.mark();
      void r.flow.cancel();
      expect(r.flow.phase().kind).toBe('stopping');
      expect((await setupTo(w, r.flow, END)).kind).toBe('cancelled');
      expect(w.rxOf('COMMAND', 1, t0).map((c) => c.f.op)).toContain(COMMAND.SETUP_CANCEL);
      expect(w.txOf('SETUP_RESULT', 1, t0).map((x) => [x.f.op, x.f.code])).toEqual([[9, R.OK]]);
      expect(w.lines(`UNDO ${id} cancel`, t0)).toHaveLength(1);
      expect(w.holdConn).toBeNull();
      expect(w.adv).toBe('00f0');
      await w.advance(1500);
      expect(await phonesLine(w)).toBe('PHONES 0');
      expect(await p.secrets.readPendingAuth()).toBeNull();
      expect(await p.secrets.readAuth()).toBeNull();
      const again = await setUp(w, p);
      expect(again.end).toMatchObject({ kind: 'done', phones: 1 });
    }));

  test('the phone gone after the pairing: the DashPal undoes the hold by itself 60 s later and is ready to pair again', () =>
    scenario({ bootId: BOOT, bonded: [] }, async (w) => {
      const p = await w.addPhone({ name: 'P', conn: 1 });
      const r = await setUp(w, p, {}, { next: false });
      const id = w.lines('PAIRED 1 ')[0]!.line.split(' ')[2]!;
      const goneAt = w.W;
      await w.crash(p);
      await w.until(() => w.lines(`UNDO ${id} expired`).length === 1, 70_000, 'the grace undo');
      const undo = w.lines(`UNDO ${id} expired`)[0]!;
      expect(undo.at - goneAt).toBeGreaterThanOrEqual(59_900);
      expect(undo.at - goneAt).toBeLessThan(61_000);
      expect(w.adv).toBe('00f0');
      expect(await phonesLine(w)).toBe('PHONES 0');
      void r;
    }));

  test('a link lost during the hold and back within the grace: a session under the provisional key, screen 2 again, and Next commits', () =>
    scenario({ bootId: BOOT, bonded: [] }, async (w) => {
      const p = await w.addPhone({ name: 'P', conn: 1, platform: 'android' });
      const r = await setUp(w, p, {}, { next: false });
      const t0 = w.mark();
      await w.linkLost(p);
      await w.until(() => w.lines('AUTH 1 up', t0).length === 1 && r.flow.phase().kind === 'instructions' && !(r.flow.phase() as { reconnecting: boolean }).reconnecting, 30_000, 'back on screen 2');
      expect(w.holdConn).toBe(1);
      r.flow.next();
      expect(await setupTo(w, r.flow, END)).toMatchObject({ kind: 'done' });
      expect(w.lines('COMMIT 1')).toHaveLength(1);
      await w.connected(p);
    }));

  test('5 presses during the hold undo it (the phone’s setup ends: lost); 10 presses forget every phone', () =>
    scenario({ bootId: BOOT, bonded: [] }, async (w) => {
      const p = await w.addPhone({ name: 'P', conn: 1 });
      const r = await setUp(w, p, {}, { next: false });
      const id = w.lines('PAIRED 1 ')[0]!.line.split(' ')[2]!;
      await w.dashcam('PRESS5');
      expect(w.lines(`UNDO ${id} window`)).toHaveLength(1);
      expect(await setupTo(w, r.flow, END, 60_000)).toMatchObject({ kind: 'failed', reason: 'lost' });
      expect(await p.secrets.readPendingAuth()).toBeNull();
      expect(w.adv).toBe('00f0');
      // a fresh setup pairs; then 10 presses forget it
      expect((await setUp(w, p)).end.kind).toBe('done');
      await w.connected(p);
      await w.dashcam('PRESS10');
      expect(await phonesLine(w)).toBe('PHONES 0');
      expect(w.adv).toBe('00f0');
      await w.until(() => p.rt.state().link.lifecycle === 'needs_repair', 5000, 'needs repair');
    }));

  test('Set up again (prev_id proven): the old record stays through the hold and is replaced at the commit; a cancelled one leaves it', () =>
    scenario({ bootId: BOOT, bonded: ['A'] }, async (w) => {
      const a = await linkedA(w);
      const old = phoneKey('A').id;
      await w.dashcam('PRESS5');
      expect(w.adv).toBe('00f2');
      const cancelled = await setUp(w, a, { again: true }, { next: false });
      expect(cancelled.end.kind).toBe('instructions');
      expect(cancelled.at.confirm).toBeDefined();
      expect(await phonesLine(w)).toBe(`PHONES 1 ${old}`);
      await cancelled.flow.cancel();
      await setupTo(w, cancelled.flow, END);
      expect(await phonesLine(w)).toBe(`PHONES 1 ${old}`);
      expect((await a.secrets.readAuth())?.phoneId).toBe(old);
      await w.connected(a, 10_000);
      // pairing mode is open again (the undo reopened it): set up again and commit
      const r = await setUp(w, a, { again: true });
      expect(r.end).toMatchObject({ kind: 'done', phones: 1 });
      const auth = (await a.secrets.readAuth())!;
      expect(auth.phoneId).not.toBe(old);
      expect(await phonesLine(w)).toBe(`PHONES 1 ${auth.phoneId}`);
      await w.connected(a, 10_000);
    }));

  test('Set up again with pairing mode closed: “Press the DashPal’s button 5 times”, and setup goes on by itself once it opens', () =>
    scenario({ bootId: BOOT, bonded: ['A'] }, async (w) => {
      const a = await linkedA(w);
      const flow = a.setup();
      void flow.start({ again: true });
      await setupTo(w, flow, ['confirm']);
      flow.pair();
      await setupTo(w, flow, ['press_button']);
      await w.advance(2000);
      await w.dashcam('PRESS5');
      await setupTo(w, flow, ['instructions']);
      flow.next();
      expect(await setupTo(w, flow, END)).toMatchObject({ kind: 'done', phones: 1 });
    }));

  test('Add another phone: A sends COMMAND 3 (no code); B finds the DashPal with phones paired and pairs with one tap; A sees 2 phones and no new-phone notice', () =>
    scenario({ bootId: BOOT, bonded: ['A'] }, async (w) => {
      const a = await linkedA(w);
      expect(await a.rt.addPhone()).toEqual({ openedAt: expect.any(Number) });
      await w.until(() => w.adv === '00f2', 2000, 'pairing open with phones');
      const b = await w.addPhone({ name: 'B', conn: 2, platform: 'android' });
      const r = await setUp(w, b);
      expect(r.at.confirm).toBeDefined();
      expect(r.end).toMatchObject({ kind: 'done', phones: 2, notAllYours: true });
      await w.until(() => a.rt.state().link.status?.bondCount === 2, 5000, 'A sees 2 phones');
      expect(a.rt.state().newPhone).toBe(false);
    }));

  test('a drop and a reconnect: a new session, then HELLO and RESUME through it; and a dashcam reboot keeps the pairing', () =>
    scenario({ bootId: BOOT, bonded: ['A'] }, async (w) => {
      const a = await linkedA(w);
      const t0 = w.mark();
      await w.linkLost(a);
      await w.connected(a);
      expect(w.lines('AUTH 1 up', t0)).toHaveLength(1);
      expect(w.rxOf('RESUME', 1, t0)).toHaveLength(1);
      expect(w.txOf('HELLO', 1, t0).length).toBeGreaterThan(0);
      await w.reboot({ gapMs: 3000 });
      await w.connected(a, 5000);
    }));

  test('every phone forgotten at the dashcam (10 presses): a soft repair (needs pairing again), retried at 30 s and never halted; Set up again pairs in the window they opened', () =>
    scenario({ bootId: BOOT, bonded: ['A'] }, async (w) => {
      const a = await linkedA(w);
      await w.dashcam('PRESS10');
      await w.until(() => a.rt.state().link.lifecycle === 'needs_repair', 3000, 'needs repair');
      expect(a.rt.state().link.repairCause).toBe('unknown_phone');
      const n = () => w.log.filter((l) => l.dir === 'in' && l.line === 'C 1').length;
      const before = n();
      await w.advance(31_000);
      expect(n()).toBe(before + 1);
      expect(a.rt.state().link.lifecycle).toBe('needs_repair');
      const r = await setUp(w, a, { again: true });
      expect(r.end).toMatchObject({ kind: 'done' });
      await w.connected(a, 5000);
      expect(a.rt.state().link.repairCause).toBeNull();
    }));

  test('a device at the paired address that is not the DashPal (another identity): unverified after 3 tries, still retrying, and never a frame written to it', () =>
    scenario({ bootId: BOOT, bonded: ['A'], mac: 'a4cf12b3c4ff' }, async (w) => {
      const a = await w.addPhone({ name: 'A', conn: 1, paired: true });
      await w.until(() => a.rt.state().link.lifecycle === 'unverified', 10_000, 'unverified');
      expect(w.log.some((l) => l.dir === 'in' && (l.line.startsWith('RX ') || l.line.startsWith('AW ')))).toBe(false);
      const n = w.log.filter((l) => l.dir === 'in' && l.line === 'C 1').length;
      await w.advance(20_000);
      expect(w.log.filter((l) => l.dir === 'in' && l.line === 'C 1').length).toBeGreaterThan(n);
    }));

  test('a spoofed phone: an unknown blinded id is R_UNKNOWN_PHONE; the right id with a wrong proof ends its connection 1 s later', () =>
    scenario({ bootId: BOOT, bonded: ['A'] }, async (w) => {
      const x = rawPhone(w, 5);
      await x.connect();
      const unknown = await x.session(randomBytes(8), randomBytes(32));
      expect(unknown.resp).toEqual({ kind: 'result', code: R.UNKNOWN_PHONE });
      const k = phoneKey('A');
      const bad = await x.session(Uint8Array.from(fromHex(k.id)), Uint8Array.from(fromHex(k.kPair)), { badFin: true });
      expect(bad.resp).toEqual({ kind: 'result', code: R.WRONG_PROOF });
      await w.advance(1100);
      expect(w.lines('TERM 5 proof')).toHaveLength(1);
    }));

  test('replays: a captured TX frame re-delivered is dropped and the link kept; a captured RX frame injected is dropped as a replay at the dashcam', () =>
    scenario({ bootId: BOOT, bonded: ['A'] }, async (w) => {
      const a = await linkedA(w);
      const tx = w.lines('TX 1').at(-1)!.line.split(' ')[2]!;
      const before = a.rt.state().link.counters.badFrames;
      a.ble.notify(a.peripheralId, fromHex(tx));
      await w.settle();
      expect(a.rt.state().link.lifecycle).toBe('connected');
      expect(a.rt.state().link.counters.badFrames).toBe(before);
      const rx = w.log.filter((l) => l.dir === 'in' && l.line.startsWith('RX 1 ')).at(-1)!.line.split(' ')[2]!;
      await w.dashcam(`RX 1 ${rx}`);
      expect(w.lines('DROP 1 replay')).toHaveLength(1);
      expect(a.rt.state().link.lifecycle).toBe('connected');
    }));

  test('a co-resident writer: 31 frames that do not open keep the link and the routing; the 32nd ends it, and the phone reconnects with a new session', () =>
    scenario({ bootId: BOOT, bonded: ['A'] }, async (w) => {
      const a = await linkedA(w);
      const junk = (i: number) => toHex(sealRaw(new Uint8Array(16).fill(i), DIR_PD, 1000 + i, encodeRx({ type: 'COMMAND', op: 7, arg: 0 })));
      for (let i = 0; i < 31; i++) await w.dashcam(`RX 1 ${junk(i)}`);
      expect(w.lines('DROP 1 bad')).toHaveLength(31);
      expect(w.lines('TERM 1')).toEqual([]);
      const t0 = w.W;
      await w.dashcam('SND 1 2 0');
      expect(w.rxOf('ALERT_ACK', 1, t0).map((x) => x.f.outcome)).toEqual([1]);
      await w.dashcam('SNDOFF');
      await w.dashcam(`RX 1 ${junk(31)}`);
      expect(w.lines('TERM 1 seal')).toHaveLength(1);
      await w.connected(a, 5000);
    }));

  test('an iPhone relaunched with the connection kept (state restoration): the session runs again on it (AUTH rekey), COMMAND 7, and a routed ALERT reaches the new process sealed', () =>
    scenario({ bootId: BOOT, bonded: ['A'] }, async (w) => {
      const a = await linkedA(w, { platform: 'ios' });
      const t0 = w.mark();
      const a2 = await w.relaunch(a);
      await w.until(() => a2.rt.state().link.lifecycle === 'connected' && a2.rt.state().link.synced, 5000, 'relaunched and synced');
      expect(w.lines('AUTH 1 rekey', t0)).toHaveLength(1);
      expect(w.log.slice(t0.mark).filter((l) => l.dir === 'in' && l.line.startsWith('C 1'))).toEqual([]);
      expect(w.rxOf('COMMAND', 1, t0).map((x) => x.f.op)).toContain(7);
      const t1 = w.W;
      await w.dashcam('SND 1 2 0');
      expect(w.txOf('ALERT', 1, t1).map((x) => x.f.route)).toEqual([1]);
      expect(w.rxOf('ALERT_ACK', 1, t1).map((x) => x.f.outcome)).toEqual([1]);
    }));

  test('the phone’s identity is blinded: two sessions of the same phone send different blinded ids, neither its id', () =>
    scenario({ bootId: BOOT, bonded: ['A'] }, async (w) => {
      const a = await linkedA(w);
      await w.linkLost(a);
      await w.connected(a);
      const reqs = w.log.filter((l) => l.dir === 'in' && l.line.startsWith('AW 1 2002')).map((l) => l.line.split(' ')[2]!.slice(4, 20));
      expect(reqs.length).toBeGreaterThanOrEqual(2);
      expect(new Set(reqs).size).toBe(reqs.length);
      expect(reqs).not.toContain(phoneKey('A').id);
      void blindedId;
    }));

  test('Forget DashPal: COMMAND 4 sealed, the dashcam deletes this phone and ends the link (TERM forget); the key is gone and nothing reconnects', () =>
    scenario({ bootId: BOOT, bonded: ['A'] }, async (w) => {
      const a = await linkedA(w);
      await a.rt.forget();
      await w.settle();
      expect(w.lines('TERM 1 forget')).toHaveLength(1);
      expect(await phonesLine(w)).toBe('PHONES 0');
      expect(await a.secrets.readAuth()).toBeNull();
      const n = w.log.filter((l) => l.dir === 'in' && l.line.startsWith('C 1')).length;
      await w.advance(60_000);
      expect(w.log.filter((l) => l.dir === 'in' && l.line.startsWith('C 1')).length).toBe(n);
      expect(a.rt.state().link.lifecycle).toBe('unpaired');
    }));

  test('the dashcam failing to compute its answer (PAIRFAIL 1): the retry with a new Nc pairs; three failures end the setup with nothing kept', () =>
    scenario({ bootId: BOOT, bonded: [] }, async (w) => {
      await w.dashcam('PAIRFAIL 1');
      const p = await w.addPhone({ name: 'P', conn: 1 });
      expect((await setUp(w, p)).end.kind).toBe('done');
      expect(w.log.filter((l) => l.dir === 'in' && l.line.startsWith('AW 1 1202'))).toHaveLength(2);
    }));

  test('three failures in a row (PAIRFAIL 3): “That didn’t work”, nothing stored on either side', () =>
    scenario({ bootId: BOOT, bonded: [] }, async (w) => {
      await w.dashcam('PAIRFAIL 3');
      const p = await w.addPhone({ name: 'P', conn: 1 });
      expect((await setUp(w, p)).end).toMatchObject({ kind: 'failed', reason: 'error' });
      expect(await phonesLine(w)).toBe('PHONES 0');
      expect(await p.secrets.readAuth()).toBeNull();
      expect(await p.secrets.readPendingAuth()).toBeNull();
    }));
});

/** @jest-environment node */
// Pairing v3 end to end (docs/BLE_PROTOCOL.md §2, §2.2, §3.3, §4): the app's setup flow, transport
// and runtime against the firmware's link and auth cores in the simulator: one-tap pairing with no
// code, the setup hold (the provisional phone, the advertised services, the known stop), its commit
// on Next, its undo on Cancel, on the phone's absence and on 5 or 10 presses, a reconnect under the
// new key during the hold, Set up again with prev_id, Add another phone, the session rules kept
// from link v2, and the setup's aiming picture (§3.4, §3.5): VIEW records reassembled byte for byte
// at each MTU, the 2 images unacknowledged at most, AIM frames, the dash-dot LED, and the stream
// refused or stopped while the car moves, in a drive, after Add another phone, when RoadWise leaves
// the front and on Next and Cancel. A scripted raw phone plays the second phone, the spoofs and the injector, built on
// the app's own auth.ts.
import { blindedId, DIR_PD, pairFin, pairKeysV3, pairOpen, parseAuthRecord, proofOk, R, sealRaw, sessionFin, sessionKeys, sessionRequest } from '../auth';
import { randomBytes, x25519Public } from '../crypto';
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

  test('a relay with its own key behind the owner’s prev_proof (the owner’s PAIR_OPEN seen in flight over the real Nc): it pairs as a new phone, and the owner’s record stays', () =>
    scenario({ bootId: BOOT, bonded: ['A'] }, async (w) => {
      await w.dashcam('PRESS5');
      expect(w.adv).toBe('00f2');
      const x = rawPhone(w, 5);
      await x.connect();
      const info = await x.info();
      const owner = phoneKey('A');
      const prev = { id: Uint8Array.from(fromHex(owner.id)), kPair: Uint8Array.from(fromHex(owner.kPair)) };
      const idP = randomBytes(8);
      // the owner's Set up again request, as the relay saw it (never delivered)
      const captured = pairOpen({ mac: info.mac, nc: info.nonce!, idP, a: randomBytes(32), np: randomBytes(16), prev }).bytes;
      const a = randomBytes(32);
      const req = Uint8Array.from([...captured.slice(0, 34), ...x25519Public(a), ...captured.slice(66)]);
      await x.write(req);
      const resp = parseAuthRecord(await x.read());
      if (resp.kind !== 'pair_resp') throw new Error(`PAIR_OPEN answered ${JSON.stringify(resp)}`);
      const keys = pairKeysV3({ mac: info.mac, nc: info.nonce!, open: req, a, B: resp.B, Nd: resp.Nd })!;
      expect(proofOk(keys.proofD, resp.proofD)).toBe(true);
      await x.write(pairFin(keys.proofP));
      expect(parseAuthRecord(await x.read())).toEqual({ kind: 'result', code: R.OK }); // it pairs, as anyone in range may
      const s = await x.session(idP, keys.K_pair);
      expect(s.resp).toEqual({ kind: 'result', code: R.OK });
      const rx = (ctr: number, op: number) => w.dashcam(`RX 5 ${toHex(sealRaw(s.keys!.k_pd, DIR_PD, ctr, encodeRx({ type: 'COMMAND', op, arg: 0 })))}`);
      await rx(0, COMMAND.HELLO);
      await rx(1, COMMAND.SETUP_DONE);
      expect(w.lines(`COMMIT 5 ${toHex(idP)}`)).toHaveLength(1);
      expect(await phonesLine(w)).toBe(`PHONES 2 ${owner.id} ${toHex(idP)}`); // a new phone: the owner's record stays
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
      // The simulator refuses the aiming stream in a window that COMMAND 3 opened (VIEW_STATE not_allowed).
      expect(r.end).toMatchObject({ kind: 'done', phones: 2, notAllYours: true, aimedElsewhere: true });
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

// ——— the setup's aiming picture (BLE_PROTOCOL §3.4, §3.5) ———

/** The simulator's stand-in JPEG for image `frame` (ff d8, (i*31 + frame*7) & 0xff, ff d9). */
const standIn = (len: number, frame: number): number[] =>
  Array.from({ length: len }, (_, i) => (i < 2 ? [0xff, 0xd8][i]! : i >= len - 2 ? [0xff, 0xd9][i - (len - 2)]! : (i * 31 + frame * 7) & 0xff));

/** Paired and on screen 2, the picture's listeners recording, then Start (`start: false`: not yet). */
async function toAim(w: World, p: Phone, o: { start?: boolean } = {}) {
  const r = await setUp(w, p, {}, { next: false });
  expect(r.end.kind).toBe('instructions');
  const frames: number[][] = [];
  const aims: (number | null)[] = [];
  r.flow.onViewFrame((j) => void frames.push(Array.from(j)));
  r.flow.onAim((a) => void aims.push(a ? a.score : null));
  if (o.start !== false) r.flow.startAim();
  return { ...r, frames, aims };
}

const aimOf = (flow: SetupFlow) => flow.phase() as Extract<SetupPhase, { kind: 'aim' }>;
const viewq = async (w: World): Promise<string[]> => ((await w.dashcam('VIEWQ')).find((l) => l.startsWith('VIEWS')) ?? '').split(' ');

describeSim('DashPal aiming picture (firmware simulator ↔ app setup flow)', () => {
  test.each([
    ['android', 247],
    ['ios', 185],
    ['android', 100],
  ] as const)('Start streams the picture (%s, MTU %i): VIEW records reassembled byte for byte and acknowledged, at most 2 images unacknowledged, AIM frames decoded, the dash-dot LED; Next stops it, then commits', (platform, mtu) =>
    scenario({ bootId: BOOT, bonded: [] }, async (w) => {
      const p = await w.addPhone({ name: 'P', conn: 1, platform, mtu });
      const a = await toAim(w, p);
      await w.until(() => w.lines('VIEW 1 on').length === 1, 3000, 'the stream on');
      expect(w.lines('LED aim 1')).toHaveLength(1);
      expect(aimOf(a.flow)).toMatchObject({ kind: 'aim', status: 'starting' });
      // One image of 2900 bytes, cut for this MTU, reassembled and acknowledged.
      await w.dashcam('VIEWF 2900');
      await w.until(() => a.frames.length === 1, 3000, 'the first image');
      expect(a.frames[0]).toEqual(standIn(2900, 1));
      const records = w.lines('VX 1 ').map((l) => fromHex(l.line.split(' ')[3]!));
      expect(records.length).toBe(Math.ceil(2900 / (mtu - 31)));
      expect(records.every((rec) => rec.length - 8 <= mtu - 31)).toBe(true);
      await w.until(() => w.rxOf('COMMAND', 1).some((c) => c.f.op === COMMAND.VIEW_ACK && c.f.arg === 1), 2000, 'its acknowledgement');
      await w.until(() => aimOf(a.flow).status === 'live', 1000, 'live');
      expect(await viewq(w)).toEqual(['VIEWS', '1', '1', '0', '1', expect.stringMatching(/^\d+$/)]);
      // AIM: the engine's result reaches the screen.
      await w.dashcam('AIMF 96 0 7 60 -8 5');
      await w.until(() => a.aims.includes(96), 2000, 'the AIM frame');
      // The phone's acknowledgements held up: never more than 2 images out.
      p.latency.up = 1200;
      for (let k = 0; k < 3; k++) {
        await w.advance(300);
        await w.dashcam('VIEWF 2900');
      }
      await w.advance(100);
      const q = await viewq(w);
      expect(Number(q[3])).toBe(2);
      expect(Number(q[4])).toBe(3);
      p.latency.up = 0;
      await w.until(() => a.frames.length === 3, 5000, 'two more images');
      expect(a.frames[1]).toEqual(standIn(2900, 2));
      // Next: the stream stops before the commit.
      const t0 = w.mark();
      a.flow.next();
      expect(await setupTo(w, a.flow, END)).toMatchObject({ kind: 'done', aimedElsewhere: false });
      const off = w.lines('VIEW 1 off 0', t0)[0];
      const commit = w.lines('COMMIT 1 ', t0)[0];
      expect(off).toBeDefined();
      expect(commit).toBeDefined();
      expect(off!.at).toBeLessThanOrEqual(commit!.at);
      expect(w.lines('LED aim 0', t0)).toHaveLength(1);
      expect(a.aims.at(-1)).toBeNull();
      // Nothing more after it.
      const n = a.frames.length;
      await w.dashcam('VIEWF 2900');
      await w.advance(500);
      expect(a.frames).toHaveLength(n);
      expect(p.errors).toEqual([]);
    }));

  test('the car moving: a start is refused (moving, Try again); a running picture stops when the phone reports 5 km/h; Next still finishes', () =>
    scenario({ bootId: BOOT, bonded: [] }, async (w) => {
      const p = await w.addPhone({ name: 'P', conn: 1, platform: 'android' });
      p.setupSpeed.cms = 150;
      const a = await toAim(w, p, { start: false });
      await w.advance(1000); // a STATE with the speed
      a.flow.startAim();
      await w.until(() => aimOf(a.flow)?.status === 'refused', 3000, 'refused');
      expect(aimOf(a.flow)).toMatchObject({ status: 'refused', reason: 'moving' });
      expect(w.lines('VIEW 1 on')).toHaveLength(0);
      // Stopped: Try again starts it; moving again stops it.
      p.setupSpeed.cms = null;
      await w.advance(1000);
      a.flow.startAim();
      await w.until(() => w.lines('VIEW 1 on').length === 1, 3000, 'the stream on');
      p.setupSpeed.cms = 150;
      await w.until(() => w.lines('VIEW 1 off 2').length === 1, 3000, 'stopped for moving');
      await w.until(() => aimOf(a.flow).status === 'refused', 1000, 'refused');
      expect(aimOf(a.flow)).toMatchObject({ reason: 'moving' });
      expect(w.lines('LED aim 0')).toHaveLength(1);
      a.flow.next();
      expect(await setupTo(w, a.flow, END)).toMatchObject({ kind: 'done' });
    }));

  test('a drive open on another phone: the picture is refused (drive), with Next only', () =>
    scenario({ bootId: BOOT, bonded: ['A'] }, async (w) => {
      const phoneA = await linkedA(w, { recording: true });
      await w.advance(1500);
      await w.dashcam('PAIRWIN 1');
      const b = await w.addPhone({ name: 'B', conn: 2, platform: 'android' });
      const a = await toAim(w, b);
      await w.until(() => aimOf(a.flow)?.status === 'refused', 5000, 'refused');
      expect(aimOf(a.flow)).toMatchObject({ reason: 'drive' });
      expect(w.lines('VIEW 2 on')).toHaveLength(0);
      const starts = w.rxOf('COMMAND', 2).filter((c) => c.f.op === COMMAND.AIM && c.f.arg === 1).length;
      a.flow.startAim();
      await w.advance(500);
      expect(w.rxOf('COMMAND', 2).filter((c) => c.f.op === COMMAND.AIM && c.f.arg === 1)).toHaveLength(starts);
      a.flow.next();
      expect(await setupTo(w, a.flow, END)).toMatchObject({ kind: 'done', phones: 2 });
      void phoneA;
    }));

  test('Add another phone: the DashPal never streams to the phone it added (not allowed), and Start does nothing', () =>
    scenario({ bootId: BOOT, bonded: ['A'] }, async (w) => {
      const phoneA = await linkedA(w);
      await phoneA.rt.addPhone();
      await w.until(() => w.adv === '00f2', 2000, 'pairing open with phones');
      const b = await w.addPhone({ name: 'B', conn: 2, platform: 'android' });
      const a = await toAim(w, b, { start: false });
      await w.until(() => a.flow.phase().kind === 'instructions' && !(a.flow.phase() as { aimAllowed: boolean }).aimAllowed, 2000, 'aiming not allowed');
      a.flow.startAim();
      await w.advance(500);
      expect(w.rxOf('COMMAND', 2).filter((c) => c.f.op === COMMAND.AIM && c.f.arg === 1)).toHaveLength(0);
      expect(w.lines('VIEW 2 on')).toHaveLength(0);
      expect(await viewq(w)).toEqual(['VIEWS', '0', '-', '0', '0', expect.stringMatching(/^\d+$/)]);
      a.flow.next();
      expect(await setupTo(w, a.flow, END)).toMatchObject({ kind: 'done', aimedElsewhere: true });
    }));

  test('RoadWise leaving the front stops the picture (the phone says so first); back in front it starts again, numbering from 1', () =>
    scenario({ bootId: BOOT, bonded: [] }, async (w) => {
      const p = await w.addPhone({ name: 'P', conn: 1, platform: 'ios' });
      const a = await toAim(w, p);
      await w.until(() => w.lines('VIEW 1 on').length === 1, 3000, 'the stream on');
      await w.dashcam('VIEWF 1200');
      await w.until(() => a.frames.length === 1, 3000, 'the first image');
      p.appState.emit('inactive');
      await w.until(() => w.lines('VIEW 1 off 0').length === 1, 2000, 'stopped by the phone');
      expect(w.lines('LED aim 0')).toHaveLength(1);
      await w.dashcam('VIEWF 1200');
      await w.advance(500);
      expect(a.frames).toHaveLength(1);
      p.appState.emit('active');
      await w.until(() => w.lines('VIEW 1 on').length === 2, 3000, 'on again');
      await w.dashcam('VIEWF 1200');
      await w.until(() => a.frames.length === 2, 3000, 'the new stream’s first image');
      expect(a.frames[1]).toEqual(standIn(1200, 1));
      await a.flow.cancel();
      await setupTo(w, a.flow, ['cancelled']);
      expect(w.lines('UNDO ')).toHaveLength(1);
    }));

  test('Cancel on screen 3: the picture stops, then the setup is undone on both sides', () =>
    scenario({ bootId: BOOT, bonded: [] }, async (w) => {
      const p = await w.addPhone({ name: 'P', conn: 1, platform: 'android' });
      const a = await toAim(w, p);
      await w.until(() => w.lines('VIEW 1 on').length === 1, 3000, 'the stream on');
      const t0 = w.mark();
      await a.flow.cancel();
      await setupTo(w, a.flow, ['cancelled']);
      await w.until(() => w.lines('UNDO ', t0).length === 1, 3000, 'undone');
      const off = w.lines('VIEW 1 off', t0)[0]!;
      expect(off.line).toBe('VIEW 1 off 0');
      expect(off.at).toBeLessThanOrEqual(w.lines('UNDO ', t0)[0]!.at);
      expect(await phonesLine(w)).toBe('PHONES 0');
      expect(w.adv).toBe('00f0');
    }));
});

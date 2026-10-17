/** @jest-environment node */
// Pairing v2 end to end (pairing v2 §15.3; docs/BLE_PROTOCOL.md §2.2, §3.3): the app's setup flow,
// transport and runtime against the firmware's auth core in the simulator (the pairing code, the
// claim, the records, sessions on every connection, sealed frames). A scripted raw phone plays the
// strangers, the spoofs and the injector, built on the app's own auth.ts.
import { blindedId, pairFin, pairKeys, pairRequest, parseAuthRecord, sealRaw, sessionFin, sessionKeys, sessionRequest, DIR_PD } from '../auth';
import { randomBytes } from '../crypto';
import { formatCode, type PairingCode } from '../label';
import { decodeInfo, encodeRx, fromHex, toHex } from '../protocol';
import type { SetupFlow, SetupPhase, SetupStart } from '../setup';
import { describeSim } from './suite';
import { CAM, LABEL_S, MAC, linkedA, phoneKey, scenario, type Phone, type World } from './world';

const BOOT = '5eed0002';
const LABEL: PairingCode = { S: LABEL_S, kind: 'label' };
const link = (code: PairingCode = LABEL, d: string = CAM) => `roadwise://dashpal#d=${d}&k=${formatCode(code.S, code.kind, { dashes: false })}`;

async function setupTo(w: World, flow: SetupFlow, kinds: SetupPhase['kind'][], maxMs = 90_000): Promise<SetupPhase> {
  await w.until(() => kinds.includes(flow.phase().kind), maxMs, `setup ${kinds.join('/')} (at ${flow.phase().kind})`);
  return flow.phase();
}

const END: SetupPhase['kind'][] = ['done', 'failed', 'cancelled', 'busy', 'denied'];

/** Run the app's setup with a scanned code (the in-app scanner), to its end. */
async function pairByScan(w: World, p: Phone, text: string = link(), opts: SetupStart = {}): Promise<{ flow: SetupFlow; scanAt: number; end: SetupPhase }> {
  const flow = p.setup();
  void flow.start(opts);
  await setupTo(w, flow, ['code', ...END]);
  const scanAt = w.W;
  if (flow.phase().kind === 'code') flow.scanned(text);
  const end = await setupTo(w, flow, END);
  return { flow, scanAt, end };
}

/** A raw phone on its own connection (the strangers, spoofs and injectors), over the simulator's lines. */
function rawPhone(w: World, conn: number) {
  const ask = async (line: string, prefix: string): Promise<string> => (await w.dashcam(line)).find((l) => l.startsWith(prefix)) ?? '';
  const self = {
    conn,
    connect: () => w.dashcam(`C ${conn}`),
    disconnect: () => w.dashcam(`D ${conn}`),
    info: async () => decodeInfo(fromHex((await ask(`INFO ${conn}`, `INFO ${conn} `)).split(' ')[2] ?? ''))!,
    write: async (bytes: Uint8Array | number[]) => (await ask(`AW ${conn} ${toHex(bytes)}`, `AW ${conn} `)).split(' ')[2],
    read: async () => fromHex((await ask(`AR ${conn}`, `AR ${conn} `)).split(' ')[2] ?? ''),
    /** a PAIR_REQ (and its PAIR_FIN when the answer proves out); the AW line's hex is kept for replays */
    async pair(code: Uint8Array, o: { idP?: Uint8Array; prev?: { id: Uint8Array; kPair: Uint8Array } | null; fin?: boolean } = {}) {
      const info = await self.info();
      const idP = o.idP ?? randomBytes(8);
      const a = randomBytes(32);
      const req = pairRequest({ code, mac: info.mac, nc: info.nonce!, idP, a, np: randomBytes(16), prev: o.prev ?? null });
      await self.write(req.bytes);
      const resp = parseAuthRecord(await self.read());
      if (resp.kind !== 'pair_resp') return { req, resp, idP, kPair: null as Uint8Array | null };
      const keys = pairKeys({ code, mac: info.mac, nc: info.nonce!, req: req.bytes, a, B: resp.B, Nd: resp.Nd })!;
      if (o.fin !== false) {
        await self.write(pairFin(keys.proofP));
        await self.read();
      }
      return { req, resp, idP, kPair: keys.K_pair };
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

describeSim('DashPal pairing v2 (firmware simulator ↔ app setup flow)', () => {
  test.each(['ios', 'android'] as const)('first setup from a scan (%s): the code proven, PAIRED, the chime once, the window closed, then the app connects through a session, all within 2 s', (platform) =>
    scenario({ bootId: BOOT, bonded: [] }, async (w) => {
      expect(w.lines('WINDOW 1')).toHaveLength(1); // no phone: open from boot
      const p = await w.addPhone({ name: 'P', conn: 1, platform });
      const { scanAt, end } = await pairByScan(w, p);
      expect(end).toMatchObject({ kind: 'done', phones: 1, notAllYours: false, paired: { dashcamId: CAM, name: 'DashPal-C4D5', secure: true } });
      expect(w.W - scanAt).toBeLessThanOrEqual(2000);
      expect(w.lines('PAIRED 1')).toHaveLength(1);
      expect(w.buzzer().filter((b) => b.line === 'PLAY once 6')).toHaveLength(1);
      expect(w.lines('WINDOW 0')).toHaveLength(1);
      const auth = (await p.secrets.readAuth())!;
      expect(auth.code).toBe(formatCode(LABEL_S, 'label', { dashes: false }));
      expect((await w.dashcam('PHONES')).find((l) => l.startsWith('PHONES'))).toBe(`PHONES 1 ${auth.phoneId}`);
      await w.connected(p);
      expect(w.lines('AUTH 1 up').length).toBeGreaterThanOrEqual(2); // the setup's first session, then the auto-connect's
      expect(p.errors.filter((e) => !e.startsWith('transport'))).toEqual([]);
    }));

  test('a label link opened with the phone’s own camera: the Pair screen warms the connection up, the tap pairs', () =>
    scenario({ bootId: BOOT, bonded: [] }, async (w) => {
      const p = await w.addPhone({ name: 'P', conn: 1, platform: 'android' });
      await p.secrets.writePendingCode({ at: w.now(), dashcamId: CAM, code: formatCode(LABEL_S, 'label', { dashes: false }) });
      const flow = p.setup();
      void flow.start({ fromLink: { dashcamId: CAM } });
      await setupTo(w, flow, ['confirm_link']);
      await w.until(() => w.log.some((l) => l.dir === 'in' && l.line === 'INFO 1'), 3000, 'pre-warm INFO');
      expect(w.log.some((l) => l.dir === 'in' && l.line.startsWith('AW 1'))).toBe(false); // nothing sent before the tap
      const tapAt = w.W;
      flow.confirm();
      expect(await setupTo(w, flow, END)).toMatchObject({ kind: 'done' });
      expect(w.W - tapAt).toBeLessThanOrEqual(1500);
      expect(await p.secrets.readPendingCode(w.now())).toBeNull();
    }));

  test('a stranger with another code: R_WRONG_CODE, its link ended 1 s later, no chime, the window still open; the owner then pairs at once', () =>
    scenario({ bootId: BOOT, bonded: [] }, async (w) => {
      const x = rawPhone(w, 5);
      await x.connect();
      const r = await x.pair(new Uint8Array(16).fill(0xee));
      expect(r.resp).toEqual({ kind: 'result', code: 5 });
      const at = w.W;
      await w.advance(1100);
      expect(w.lines('TERM 5 code').map((l) => l.at - at)).toEqual([expect.any(Number)]);
      expect(w.buzzer().filter((b) => b.line === 'PLAY once 6')).toEqual([]);
      expect(w.windowOpen).toBe(true);
      const p = await w.addPhone({ name: 'P', conn: 1 });
      expect((await pairByScan(w, p)).end.kind).toBe('done');
    }));

  test('a captured PAIR_REQ replayed on another connection is refused: its tag is over the old Nc', () =>
    scenario({ bootId: BOOT, bonded: [] }, async (w) => {
      const x = rawPhone(w, 5);
      await x.connect();
      const first = await x.pair(LABEL_S, { fin: false });
      expect(first.resp.kind).toBe('pair_resp');
      await x.disconnect();
      const y = rawPhone(w, 6);
      await y.connect();
      expect(await y.write(first.req.bytes)).toBe('00');
      expect(parseAuthRecord(await y.read())).toEqual({ kind: 'result', code: 5 });
    }));

  test('another phone holding the claim: the owner waits ("another phone is setting up"), the claim ends 15 s after its request (TERM claim), the owner pairs', () =>
    scenario({ bootId: BOOT, bonded: [] }, async (w) => {
      const x = rawPhone(w, 5);
      await x.connect();
      const held = await x.pair(LABEL_S, { fin: false });
      expect(held.resp.kind).toBe('pair_resp');
      const claimAt = w.W;
      // a fresh request by the holder never moves its end
      await w.advance(10_000);
      await x.pair(LABEL_S, { fin: false });
      const p = await w.addPhone({ name: 'P', conn: 1 });
      const flow = p.setup();
      void flow.start();
      await setupTo(w, flow, ['code']);
      flow.scanned(link());
      await setupTo(w, flow, ['waiting_busy']);
      expect(await setupTo(w, flow, END, 30_000)).toMatchObject({ kind: 'done' });
      const term = w.lines('TERM 5 claim')[0]!;
      expect(term.at - claimAt).toBeGreaterThanOrEqual(15_000);
      expect(term.at - claimAt).toBeLessThan(15_200);
    }));

  test('a code holder’s prev_id with no proof of its key is a new phone: A’s record and session stay, the count rises, and A shows the new-phone notice', () =>
    scenario({ bootId: BOOT, bonded: ['A'] }, async (w) => {
      const a = await linkedA(w);
      await w.until(() => a.rt.state().link.status?.bondCount === 1, 3000, 'count 1');
      await w.dashcam('PAIRWIN 1');
      const x = rawPhone(w, 5);
      await x.connect();
      const aId = Uint8Array.from(fromHex(phoneKey('A').id));
      const r = await x.pair(LABEL_S, { prev: { id: aId, kPair: randomBytes(32) } });
      expect(r.kPair).not.toBeNull();
      const phones = (await w.dashcam('PHONES')).find((l) => l.startsWith('PHONES'))!.split(' ');
      expect(phones.slice(1, 2)).toEqual(['2']);
      expect(phones).toContain(phoneKey('A').id);
      expect(a.rt.state().link.lifecycle).toBe('connected');
      await w.until(() => a.rt.state().newPhone, 5000, 'the new-phone notice');
    }));

  test('the same phone sets up again over its live, authenticated connection (an iPhone that kept the link layer): its session dropped, then paired with prev_id proven; the count unchanged', () =>
    scenario({ bootId: BOOT, bonded: ['A'] }, async (w) => {
      const k = phoneKey('A');
      const id = Uint8Array.from(fromHex(k.id));
      const kp = Uint8Array.from(fromHex(k.kPair));
      const x = rawPhone(w, 5);
      await x.connect();
      const s = await x.session(id, kp);
      expect(s.resp).toEqual({ kind: 'result', code: 0 });
      await w.dashcam('PAIRWIN 1');
      const r = await x.pair(LABEL_S, { prev: { id, kPair: kp } });
      expect(r.kPair).not.toBeNull();
      expect(w.lines('AUTH 5 dropped')).toHaveLength(1);
      expect(w.lines('PAIRED 5')).toHaveLength(1);
      const phones = (await w.dashcam('PHONES')).find((l) => l.startsWith('PHONES'))!;
      expect(phones).toBe(`PHONES 1 ${toHex(r.idP)}`);
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

  test('every phone forgotten at the dashcam (10 presses): a soft repair (needs pairing again), retried at 30 s and never halted; Set up again with the stored label code pairs', () =>
    scenario({ bootId: BOOT, bonded: ['A'] }, async (w) => {
      const a = await linkedA(w);
      await w.dashcam('WIPE');
      await w.until(() => a.rt.state().link.lifecycle === 'needs_repair', 3000, 'needs repair');
      expect(a.rt.state().link.repairCause).toBe('unknown_phone');
      const n = () => w.log.filter((l) => l.dir === 'in' && l.line === 'C 1').length;
      const before = n();
      await w.advance(31_000);
      expect(n()).toBe(before + 1);
      expect(a.rt.state().link.lifecycle).toBe('needs_repair');
      await w.dashcam('PAIRWIN 1'); // 10 presses open the window
      const r = await pairByScan(w, a, link(), { again: true });
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
      void MAC;
    }));

  test('a spoofed phone: an unknown blinded id is R_UNKNOWN_PHONE; the right id with a wrong proof ends its connection 1 s later', () =>
    scenario({ bootId: BOOT, bonded: ['A'] }, async (w) => {
      const x = rawPhone(w, 5);
      await x.connect();
      const unknown = await x.session(randomBytes(8), randomBytes(32));
      expect(unknown.resp).toEqual({ kind: 'result', code: 2 });
      const k = phoneKey('A');
      const bad = await x.session(Uint8Array.from(fromHex(k.id)), Uint8Array.from(fromHex(k.kPair)), { badFin: true });
      expect(bad.resp).toEqual({ kind: 'result', code: 4 });
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
      expect((await w.dashcam('PHONES')).find((l) => l.startsWith('PHONES'))).toBe('PHONES 0');
      expect(await a.secrets.readAuth()).toBeNull();
      const n = w.log.filter((l) => l.dir === 'in' && l.line.startsWith('C 1')).length;
      await w.advance(60_000);
      expect(w.log.filter((l) => l.dir === 'in' && l.line.startsWith('C 1')).length).toBe(n);
      expect(a.rt.state().link.lifecycle).toBe('unpaired');
    }));

  test('the dashcam failing to compute its answer (PAIRFAIL): one failure, then the retry with a new Nc pairs; three failures end the setup', () =>
    scenario({ bootId: BOOT, bonded: [] }, async (w) => {
      await w.dashcam('PAIRFAIL 1');
      const p = await w.addPhone({ name: 'P', conn: 1 });
      expect((await pairByScan(w, p)).end.kind).toBe('done');
      expect(w.log.filter((l) => l.dir === 'in' && l.line.startsWith('AW 1 1002'))).toHaveLength(2);
    }));

  test('three failures in a row (PAIRFAIL 3): the setup ends with "That didn’t work", nothing stored', () =>
    scenario({ bootId: BOOT, bonded: [] }, async (w) => {
      await w.dashcam('PAIRFAIL 3');
      const p = await w.addPhone({ name: 'P', conn: 1 });
      expect((await pairByScan(w, p)).end).toMatchObject({ kind: 'failed', reason: 'error' });
      expect((await w.dashcam('PHONES')).find((l) => l.startsWith('PHONES'))).toBe('PHONES 0');
      expect(await p.secrets.readAuth()).toBeNull();
      expect(await p.secrets.readPendingAuth()).toBeNull();
    }));

  test('pairing mode closed: "press the button 5 times", and pairing goes on by itself once it opens', () =>
    scenario({ bootId: BOOT, bonded: ['A'] }, async (w) => {
      const p = await w.addPhone({ name: 'P', conn: 2 });
      const flow = p.setup();
      void flow.start();
      await setupTo(w, flow, ['code']);
      flow.scanned(link());
      await setupTo(w, flow, ['press_button']);
      await w.advance(2000);
      await w.dashcam('PAIRWIN 1');
      expect(await setupTo(w, flow, END)).toMatchObject({ kind: 'done', phones: 2 });
    }));

  test('an unkeyed board: "no pairing code yet", nothing sent', () =>
    scenario({ bootId: BOOT, bonded: [], unkeyed: true }, async (w) => {
      const p = await w.addPhone({ name: 'P', conn: 1 });
      expect((await pairByScan(w, p)).end).toMatchObject({ kind: 'failed', reason: 'no_key' });
      expect(w.log.some((l) => l.dir === 'in' && l.line.startsWith('AW'))).toBe(false);
    }));

});

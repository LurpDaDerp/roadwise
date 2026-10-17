// The link v2 setup flow (pairing v2 §9, §14.4, §15.2) on the real transport over the fake BLE
// stack and fake dashcams, with a virtual clock: every path to "Connected", every failure, the
// typed path's candidate loop, the key's life (pending before PAIR_FIN, final only on success,
// orphaned when the outcome stays unknown), replacement, cancel, and the 10-s budget's rule that no
// wait on the happy path is longer than 100 ms.
import type { BluetoothAccess } from '@/core/permissions/adapters';

import { createFakeDashcam, type FakeDashcam } from '../__fixtures__/fakeDashcam';
import { R } from '../auth';
import { createFakeBle, type FakeBle } from '../fakeTransport';
import type { PairedDashcam } from '../keys';
import { dashpalLink, drawOnceCode, formatCode, type PairingCode } from '../label';
import { AUTH_CHAR, DASHPAL_SERVICE, INFO_CHAR, PAIRING_NEW, toHex } from '../protocol';
import { createDashpalSecrets, type DashpalSecrets } from '../secure';
import { BUSY_WAIT_MS, createSetupFlow, PRESS_WAIT_MS, type SetupFlow, type SetupPhase, type SetupStart } from '../setup';
import { createBleTransport, type DashcamTransport } from '../transport';

const flush = async () => {
  for (let i = 0; i < 60; i++) await new Promise<void>((resolve) => setImmediate(resolve));
};

const DOMAIN = 'pair.example.com';
const S = Uint8Array.from({ length: 16 }, (_, i) => i);
const LABEL: PairingCode = { S, kind: 'label' };
const macOf = (last: number) => [0xa4, 0xcf, 0x12, 0xb3, 0xc4, last];
const camOf = (last: number) => toHex(macOf(last));
const idOf = (platform: 'ios' | 'android', last: number) => (platform === 'android' ? macOf(last).map((b) => b.toString(16).padStart(2, '0').toUpperCase()).join(':') : `UUID-${last}`);

jest.mock('expo-constants', () => ({ __esModule: true, default: { expoConfig: { extra: { linkDomain: 'pair.example.com' } } } }));

interface CamSpec {
  last: number;
  S?: Uint8Array | null;
  windowOpen?: boolean;
  rssi?: number;
  protoMax?: number;
  noAuthChar?: boolean;
}

interface Rig {
  flow: SetupFlow;
  ble: FakeBle;
  t: DashcamTransport;
  cams: Map<number, FakeDashcam>;
  secrets: DashpalSecrets;
  store: Map<string, string>;
  phases: SetupPhase[];
  paired: PairedDashcam[];
  log: string[];
  clock: { t: number };
  sleeps: number[];
  /** the paired DashPal's auto-connect: its last session with this phone's key was refused (R_UNKNOWN_PHONE) */
  refused: { on: boolean };
  at(ms: number, fn: () => void): void;
  until(kind: SetupPhase['kind']): Promise<SetupPhase>;
  run(opts?: SetupStart): Promise<SetupPhase>;
  setBusy(v: boolean): void;
}

function rig(o: { platform?: 'ios' | 'android'; access?: BluetoothAccess; previous?: PairedDashcam | null; cams?: CamSpec[] } = {}): Rig {
  const platform = o.platform ?? 'android';
  const ble = createFakeBle();
  const t = createBleTransport(ble, { platform, setTimer: () => 0, clearTimer: () => {} });
  const cams = new Map<number, FakeDashcam>();
  const specs = o.cams ?? [{ last: 0xd5 }];
  for (const c of specs) {
    const cam = createFakeDashcam({ ble, id: idOf(platform, c.last), mac: macOf(c.last), S: c.S === undefined ? S : c.S, windowOpen: c.windowOpen ?? true, protoMax: c.protoMax });
    if (c.noAuthChar) ble.peripheral(idOf(platform, c.last))!.noAuthChar = true;
    cams.set(c.last, cam);
  }
  // Advertising: every DashPal answers each scan (its pairing service while its window is open).
  const scan = ble.scan.bind(ble);
  ble.scan = async (opts) => {
    await scan(opts);
    queueMicrotask(() => {
      for (const c of specs) {
        const cam = cams.get(c.last)!;
        ble.advertise({
          id: idOf(platform, c.last),
          rssi: c.rssi ?? -50,
          advertising: { serviceUUIDs: [cam.windowOpen ? PAIRING_NEW : DASHPAL_SERVICE], localName: `DashPal-${camOf(c.last).slice(-4).toUpperCase()}` },
        });
      }
    });
  };
  const store = new Map<string, string>();
  const secrets = createDashpalSecrets(() => ({
    getItemAsync: async (k) => store.get(k) ?? null,
    setItemAsync: async (k, v) => void store.set(k, v),
    deleteItemAsync: async (k) => void store.delete(k),
  }));
  const clock = { t: 1_000_000 };
  const sleeps: number[] = [];
  const due: { at: number; fn: () => void }[] = [];
  const phases: SetupPhase[] = [];
  const paired: PairedDashcam[] = [];
  const log: string[] = [];
  let busy = false;
  const driveFns = new Set<() => void>();
  const refused = { on: false };
  const flow = createSetupFlow({
    platform,
    transport: () => t,
    requestBluetooth: async () => o.access ?? 'granted',
    isBusy: () => busy,
    onDriveChange: (fn) => {
      driveFns.add(fn);
      return () => void driveFns.delete(fn);
    },
    optIn: async () => void log.push('optIn'),
    pair: async (r) => {
      paired.push(r);
      log.push(`pair:${r.dashcamId}`);
    },
    paired: () => o.previous ?? null,
    keyRefused: (d) => refused.on && o.previous?.dashcamId === d,
    stepAside: () => {
      log.push('stepAside');
      t.setTarget(null);
    },
    resumePaired: async () => void log.push('resumePaired'),
    secrets,
    notePhones: (d, n) => void log.push(`notePhones:${d}:${n}`),
    now: () => clock.t,
    sleep: async (ms) => {
      sleeps.push(ms);
      clock.t += ms;
      for (const d of due.splice(0).sort((a, b) => a.at - b.at)) {
        if (d.at <= clock.t) d.fn();
        else due.push(d);
      }
      await Promise.resolve();
    },
    onError: (e, ctx) => void log.push(`error:${ctx}:${e instanceof Error ? e.message : String(e)}`),
  });
  flow.subscribe((p) => phases.push(p));
  const r: Rig = {
    flow,
    ble,
    t,
    cams,
    secrets,
    store,
    phases,
    paired,
    log,
    clock,
    sleeps,
    refused,
    at: (ms, fn) => void due.push({ at: clock.t + ms, fn }),
    async until(kind) {
      for (let i = 0; i < 400; i++) {
        if (flow.phase().kind === kind) return flow.phase();
        await flush();
      }
      throw new Error(`never reached ${kind}; phases: ${phases.map((p) => p.kind).join(' > ')}; log: ${log.join(' | ')}`);
    },
    async run(opts) {
      await flow.start(opts);
      await flush();
      return flow.phase();
    },
    setBusy: (v) => {
      busy = v;
      for (const fn of [...driveFns]) fn();
    },
  };
  return r;
}

const link = (last: number, code: PairingCode = LABEL) => dashpalLink(camOf(last), code, DOMAIN);
const kinds = (r: Rig) => r.phases.map((p) => p.kind);

/** Start the flow, wait for the code step, then hand it `act`. */
async function withCode(r: Rig, act: (f: SetupFlow) => void, opts?: SetupStart): Promise<SetupPhase> {
  const done = r.flow.start(opts);
  await r.until('code');
  act(r.flow);
  await done;
  await flush();
  return r.flow.phase();
}

describe('the happy paths', () => {
  test('the in-app scanner: search, connect, pair, session, PAIRED; the key final with the label code; no wait on the path over 100 ms', async () => {
    const r = rig();
    const end = await withCode(r, (f) => f.scanned(link(0xd5)));
    expect(end).toMatchObject({ kind: 'done', phones: 1, notAllYours: false, paired: { dashcamId: camOf(0xd5), name: 'DashPal-C4D5', secure: true } });
    expect(kinds(r)).toEqual(['permission', 'code', 'searching', 'connecting', 'pairing', 'finishing', 'done']);
    expect(r.sleeps.every((ms) => ms <= 100)).toBe(true);
    const auth = (await r.secrets.readAuth())!;
    expect(auth.dashcamId).toBe(camOf(0xd5));
    expect(auth.code).toBe(formatCode(S, 'label', { dashes: false }));
    expect(await r.secrets.readPendingAuth()).toBeNull();
    // the dashcam holds this phone's key under its id
    const cam = r.cams.get(0xd5)!;
    expect(toHex(cam.phones.get(auth.phoneId)!)).toBe(auth.kPair);
    expect(r.log).toContain(`notePhones:${camOf(0xd5)}:1`);
    // the setup connection was released before the pairing went to the auto-connect
    expect(r.ble.calls.lastIndexOf(`disconnect:${idOf('android', 0xd5)}`)).toBeGreaterThan(-1);
    // INFO read again after PAIR_FIN (its Nc was redrawn) before the SESSION_REQ
    const ops = r.ble.calls.filter((c) => c.endsWith(':0002') || c.endsWith(':0006'));
    const fin = ops.findIndex((c, i) => c.startsWith('write') && c.endsWith(':0006') && i > 0 && ops.slice(0, i).filter((x) => x.startsWith('write') && x.endsWith(':0006')).length === 1);
    expect(ops.slice(fin + 1, fin + 3)).toEqual([`read:${idOf('android', 0xd5)}:0006`, `read:${idOf('android', 0xd5)}:0002`]);
  });

  test('a link from the phone’s own camera: the Pair screen warms up the connection (search, connect, INFO) before the tap; the tap pairs', async () => {
    const r = rig();
    await r.secrets.writePendingCode({ at: r.clock.t, dashcamId: camOf(0xd5), code: formatCode(S, 'label', { dashes: false }) });
    const done = r.flow.start({ fromLink: { dashcamId: camOf(0xd5) } });
    expect(await r.until('confirm_link')).toEqual({ kind: 'confirm_link', name: 'DashPal-C4D5' });
    await flush();
    const before = [...r.ble.calls];
    expect(before).toContain(`connect:${idOf('android', 0xd5)}`);
    expect(before).toContain(`read:${idOf('android', 0xd5)}:0002`);
    expect(before.some((c) => c.endsWith(':0006'))).toBe(false); // nothing sent before the tap
    r.flow.confirm();
    await done;
    await flush();
    expect(r.flow.phase()).toMatchObject({ kind: 'done' });
    expect(r.ble.calls.filter((c) => c.startsWith('connect'))).toHaveLength(1); // the warmed connection was used
    expect(await r.secrets.readPendingCode(r.clock.t)).toBeNull();
  });

  test('a held link code also opens its Pair screen when setup is opened from Settings or onboarding (a link held through sign-in)', async () => {
    const r = rig();
    await r.secrets.writePendingCode({ at: r.clock.t, dashcamId: camOf(0xd5), code: formatCode(S, 'label', { dashes: false }) });
    const done = r.flow.start();
    expect(await r.until('confirm_link')).toEqual({ kind: 'confirm_link', name: 'DashPal-C4D5' });
    await r.flow.cancel();
    await done;
    expect(await r.secrets.readPendingCode(r.clock.t)).toBeNull();
    // older than 12 h: the code step
    const old = rig();
    await old.secrets.writePendingCode({ at: old.clock.t - 12 * 60 * 60_000 - 1, dashcamId: camOf(0xd5), code: formatCode(S, 'label', { dashes: false }) });
    void old.flow.start();
    expect((await old.until('code')).kind).toBe('code');
    await old.flow.cancel();
  });

  test('a held code for another DashPal, or none: the code step, preferring the link’s DashPal', async () => {
    const r = rig();
    await r.secrets.writePendingCode({ at: r.clock.t, dashcamId: camOf(0x11), code: formatCode(S, 'label', { dashes: false }) });
    void r.flow.start({ fromLink: { dashcamId: camOf(0xd5) } });
    expect(await r.until('code')).toEqual({ kind: 'code', error: null, noStoredCode: false, preferred: 'DashPal-C4D5' });
    await r.flow.cancel();
  });

  test('Set up again with the stored label code skips the code step; without one it opens it, saying so', async () => {
    const previous: PairedDashcam = { dashcamId: camOf(0xd5), peripheralId: idOf('android', 0xd5), name: 'DashPal-C4D5', pairedAt: 1, secure: true };
    const r = rig({ previous });
    await r.secrets.writePendingAuth({ dashcamId: camOf(0xd5), phoneId: '0102030405060708', kPair: 'ab'.repeat(32), code: formatCode(S, 'label', { dashes: false }) });
    await r.secrets.finalizeAuth();
    r.cams.get(0xd5)!.phones.set('0102030405060708', Uint8Array.from({ length: 32 }, () => 0xab));
    const end = await r.run({ again: true });
    expect(end.kind).toBe('done');
    expect(kinds(r)).not.toContain('code');
    expect(r.phases.find((p) => p.kind === 'searching')).toMatchObject({ again: true });
    // the same phone replaced its own record by proving its old key: the count is unchanged
    expect(r.cams.get(0xd5)!.phones.size).toBe(1);
    expect(r.cams.get(0xd5)!.phones.has('0102030405060708')).toBe(false);

    const once = rig({ previous });
    await once.secrets.writePendingAuth({ dashcamId: camOf(0xd5), phoneId: '0102030405060708', kPair: 'ab'.repeat(32), code: null });
    await once.secrets.finalizeAuth();
    void once.flow.start({ again: true });
    expect(await once.until('code')).toMatchObject({ noStoredCode: true });
    await once.flow.cancel();
  });

  test('2 or more phones: notAllYours', async () => {
    const r = rig();
    r.cams.get(0xd5)!.phones.set('1111111111111111', new Uint8Array(32).fill(1));
    const end = await withCode(r, (f) => f.scanned(link(0xd5)));
    expect(end).toMatchObject({ kind: 'done', phones: 2, notAllYours: true });
  });

  test('a one-time code pairs and is never stored', async () => {
    const r = rig();
    const once = drawOnceCode();
    r.cams.get(0xd5)!.once = Uint8Array.from(once.S);
    const end = await withCode(r, (f) => f.scanned(link(0xd5, once)));
    expect(end.kind).toBe('done');
    expect((await r.secrets.readAuth())?.code).toBeNull();
  });

  test('a lingering key or orphan for that DashPal proves prev_id; another DashPal’s does not', async () => {
    const r = rig();
    await r.secrets.writeOrphan({ dashcamId: camOf(0xd5), phoneId: '0909090909090909', kPair: 'cd'.repeat(32) });
    r.cams.get(0xd5)!.phones.set('0909090909090909', new Uint8Array(32).fill(0xcd));
    const end = await withCode(r, (f) => f.scanned(link(0xd5)));
    expect(end.kind).toBe('done');
    const req = r.cams.get(0xd5)!.authWrites.find((w) => w[0] === 0x10)!;
    expect(toHex(req.slice(10, 18))).toBe('0909090909090909');
    expect(r.cams.get(0xd5)!.phones.size).toBe(1); // replaced, not added
    expect(await r.secrets.readOrphan()).toBeNull();
  });
});

describe('failures', () => {
  test('not a DashPal code (the camera keeps looking), a typed code with a mistake', async () => {
    const r = rig();
    void r.flow.start();
    await r.until('code');
    r.flow.scanned('roadwise://add/someone');
    expect(r.flow.phase()).toMatchObject({ kind: 'code', error: 'not_a_code' });
    r.flow.scanned(`https://${DOMAIN}/dashpal#d=${camOf(0xd5)}`); // a link with no code
    expect(r.flow.phase()).toMatchObject({ kind: 'code', error: 'not_a_code' });
    r.flow.submitCode('000G-40R4-0M30-E209-185G-R38E-1W6U');
    expect(r.flow.phase()).toMatchObject({ kind: 'code', error: 'bad_code' });
    r.flow.submitCode(formatCode(S, 'label'), 'ZZZZ');
    expect(r.flow.phase()).toMatchObject({ kind: 'code', error: 'bad_code' });
    expect(r.ble.calls.some((c) => c.startsWith('connect'))).toBe(false);
    await r.flow.cancel();
  });

  test('not found within 15 s', async () => {
    const r = rig();
    const end = await withCode(r, (f) => f.scanned(link(0x77)));
    expect(end).toEqual({ kind: 'failed', reason: 'not_found', name: 'DashPal-C477' });
  });

  test('a wrong code for the named DashPal: wrong_code (and the dashcam ends that link)', async () => {
    const r = rig();
    const end = await withCode(r, (f) => f.scanned(link(0xd5, { S: new Uint8Array(16).fill(9), kind: 'label' })));
    expect(end).toMatchObject({ kind: 'failed', reason: 'wrong_code' });
    expect(r.cams.get(0xd5)!.phones.size).toBe(0);
    expect(await r.secrets.readPendingAuth()).toBeNull();
  });

  test('a device that cannot prove the code: unverified, and nothing more is sent to it', async () => {
    const r = rig();
    r.cams.get(0xd5)!.badProof.pair = true;
    const end = await withCode(r, (f) => f.scanned(link(0xd5)));
    expect(end).toMatchObject({ kind: 'failed', reason: 'unverified' });
    expect(r.cams.get(0xd5)!.authWrites.map((w) => w[0])).toEqual([0x10]);
  });

  test.each([
    ['firmware below link v3', { protoMax: 2 }, 'update_firmware'],
  ] as const)('%s', async (_n, spec, reason) => {
    const r = rig({ cams: [{ last: 0xd5, ...spec }] });
    const end = await withCode(r, (f) => f.scanned(link(0xd5)));
    expect(end).toMatchObject({ kind: 'failed', reason });
  });

  test('R_MTU twice: mtu; once on Android: the MTU asked again and paired', async () => {
    const r = rig();
    r.cams.get(0xd5)!.mtu = 23;
    expect(await withCode(r, (f) => f.scanned(link(0xd5)))).toMatchObject({ kind: 'failed', reason: 'mtu' });
    const once = rig();
    once.cams.get(0xd5)!.force.pair_req = R.MTU;
    expect(await withCode(once, (f) => f.scanned(link(0xd5)))).toMatchObject({ kind: 'done' });
    expect(once.ble.calls.filter((c) => c.startsWith('requestMTU')).length).toBeGreaterThanOrEqual(2);
  });

  test('iOS with no AUTH characteristic (an old bond cached the old table): ios_forget_first', async () => {
    const r = rig({ platform: 'ios', cams: [{ last: 0xd5, noAuthChar: true }] });
    const end = await withCode(r, (f) => f.scanned(link(0xd5)));
    expect(end).toMatchObject({ kind: 'failed', reason: 'ios_forget_first' });
  });

  test('iOS with no AUTH characteristic on a link’s warmed connection: Pair says ios_forget_first at once (no request written, no second connect)', async () => {
    const r = rig({ platform: 'ios', cams: [{ last: 0xd5, noAuthChar: true }] });
    await r.secrets.writePendingCode({ at: r.clock.t, dashcamId: camOf(0xd5), code: formatCode(S, 'label', { dashes: false }) });
    const done = r.flow.start({ fromLink: { dashcamId: camOf(0xd5) } });
    await r.until('confirm_link');
    await flush();
    expect(r.ble.calls.filter((c) => c.startsWith('connect'))).toHaveLength(1);
    r.flow.confirm();
    await done;
    expect(r.flow.phase()).toMatchObject({ kind: 'failed', reason: 'ios_forget_first' });
    expect(r.ble.calls.filter((c) => c.startsWith('connect'))).toHaveLength(1);
    expect(r.ble.calls.some((c) => c.startsWith('write:') && c.endsWith(':0006'))).toBe(false);
  });

  test('the key cannot be stored before PAIR_FIN: error, and PAIR_FIN is never sent', async () => {
    const r = rig();
    const set = r.store.set.bind(r.store);
    r.store.set = (k, v) => {
      if (k === 'dashpal.authPending') throw new Error('keychain full');
      return set(k, v);
    };
    const end = await withCode(r, (f) => f.scanned(link(0xd5)));
    expect(end).toMatchObject({ kind: 'failed', reason: 'error' });
    expect(r.cams.get(0xd5)!.authWrites.map((w) => w[0])).toEqual([0x10]);
    expect(r.cams.get(0xd5)!.phones.size).toBe(0);
  });

  test.each([R.WRONG_PROOF, R.STORE_FAILED, R.NOT_NOW])('PAIR_FIN answered %i: error, the pending key deleted, the previous pairing untouched', async (code) => {
    const r = rig();
    await r.secrets.writePendingAuth({ dashcamId: camOf(0x01), phoneId: '0101010101010101', kPair: 'ee'.repeat(32), code: null });
    await r.secrets.finalizeAuth();
    r.cams.get(0xd5)!.force.pair_fin = code;
    const end = await withCode(r, (f) => f.scanned(link(0xd5)));
    expect(end).toMatchObject({ kind: 'failed', reason: 'error' });
    expect(await r.secrets.readPendingAuth()).toBeNull();
    expect((await r.secrets.readAuth())?.dashcamId).toBe(camOf(0x01));
    expect(r.paired).toEqual([]);
  });

  test('a drive opens during setup: busy, nothing sent', async () => {
    const r = rig();
    const done = r.flow.start();
    await r.until('code');
    r.setBusy(true);
    r.flow.scanned(link(0xd5));
    await done;
    expect(r.flow.phase()).toEqual({ kind: 'busy' });
    const before = rig();
    before.setBusy(true);
    expect(await before.run()).toEqual({ kind: 'busy' });
  });

  test.each([
    ['denied', 'denied'],
    ['off', 'off'],
    ['unavailable', 'unavailable'],
  ] as const)('Bluetooth %s', async (access, kind) => {
    const r = rig({ access });
    expect((await r.run()).kind).toBe(kind);
  });
});

describe('pairing mode, busy, retries', () => {
  test('pairing mode closed: "press the button", watched up to 60 s; it opens at 5 s and pairing goes on by itself', async () => {
    const r = rig({ cams: [{ last: 0xd5, windowOpen: false }] });
    const done = r.flow.start();
    await r.until('code');
    r.at(5000, () => {
      r.cams.get(0xd5)!.windowOpen = true;
      r.ble.advertise({ id: idOf('android', 0xd5), rssi: -50, advertising: { serviceUUIDs: [PAIRING_NEW] } });
    });
    r.flow.scanned(link(0xd5));
    await done;
    await flush();
    expect(r.flow.phase().kind).toBe('done');
    expect(kinds(r)).toContain('press_button');
  });

  test('pairing mode never opens: window_timeout after 60 s', async () => {
    const r = rig({ cams: [{ last: 0xd5, windowOpen: false }] });
    const t0 = r.clock.t;
    const end = await withCode(r, (f) => f.scanned(link(0xd5)));
    expect(end).toMatchObject({ kind: 'failed', reason: 'window_timeout' });
    expect(r.clock.t - t0).toBeGreaterThanOrEqual(PRESS_WAIT_MS);
  });

  test('another phone is setting it up: INFO every second; cleared at 6 s pairs; busy throughout fails at 16 s', async () => {
    const r = rig();
    r.cams.get(0xd5)!.busy = true;
    const done = r.flow.start();
    await r.until('code');
    r.at(6000, () => (r.cams.get(0xd5)!.busy = false));
    r.flow.scanned(link(0xd5));
    await done;
    await flush();
    expect(r.flow.phase().kind).toBe('done');
    expect(kinds(r)).toContain('waiting_busy');

    const stuck = rig();
    stuck.cams.get(0xd5)!.busy = true;
    const t0 = stuck.clock.t;
    expect(await withCode(stuck, (f) => f.scanned(link(0xd5)))).toMatchObject({ kind: 'failed', reason: 'setup_busy' });
    expect(stuck.clock.t - t0).toBeGreaterThanOrEqual(BUSY_WAIT_MS);
  });

  test('R_ID_IN_USE: a new id, sent again at once on the same Nc', async () => {
    const r = rig();
    r.cams.get(0xd5)!.force.pair_req = R.ID_IN_USE;
    const end = await withCode(r, (f) => f.scanned(link(0xd5)));
    expect(end.kind).toBe('done');
    const reqs = r.cams.get(0xd5)!.authWrites.filter((w) => w[0] === 0x10);
    expect(reqs).toHaveLength(2);
    expect(toHex(reqs[0]!.slice(2, 10))).not.toBe(toHex(reqs[1]!.slice(2, 10)));
  });

  test('R_NOT_NOW (the dashcam failed to compute its answer): INFO again, 300 ms, a new request, at most twice; then error', async () => {
    const r = rig();
    r.cams.get(0xd5)!.force.pair_req = R.NOT_NOW;
    const end = await withCode(r, (f) => f.scanned(link(0xd5)));
    expect(end.kind).toBe('done');
    expect(r.sleeps).toContain(300);

    const always = rig();
    const cam = always.cams.get(0xd5)!;
    const w = always.ble.onWrite!;
    always.ble.onWrite = (x) => {
      if (x.characteristic === AUTH_CHAR && x.bytes[0] === 0x10) cam.force.pair_req = R.NOT_NOW;
      return w(x);
    };
    expect(await withCode(always, (f) => f.scanned(link(0xd5)))).toMatchObject({ kind: 'failed', reason: 'error' });
    expect(cam.authWrites.filter((x) => x[0] === 0x10)).toHaveLength(3);
  });

  test('R_NOT_NOW after a pending answer, with the window timing out meanwhile: the claim is held, so the request goes again under it and pairs', async () => {
    const r = rig();
    const cam = r.cams.get(0xd5)!;
    const w = r.ble.onWrite!;
    let reqs = 0;
    r.ble.onWrite = (x) => {
      if (x.characteristic !== AUTH_CHAR || x.bytes[0] !== 0x10) return w(x);
      reqs += 1;
      if (reqs === 1) {
        // The code tag checks (pending), the dashcam fails to compute its answer, and the window
        // times out while the claim lives on.
        cam.force.pair_req = R.NOT_NOW;
        cam.pendingReads = 2;
        cam.windowOpen = false;
        return w(x);
      }
      // The fake has no claim: the live claim lets this request through with the window closed.
      cam.windowOpen = true;
      try {
        return w(x);
      } finally {
        cam.windowOpen = false;
      }
    };
    const end = await withCode(r, (f) => f.scanned(link(0xd5)));
    expect(end.kind).toBe('done');
    expect(reqs).toBe(2);
    expect(kinds(r)).not.toContain('press_button');
  });

  test('with a named DashPal, a disconnect before the verdict: one reconnect and the request again; twice: error, never wrong_code', async () => {
    const r = rig();
    const id = idOf('android', 0xd5);
    let drops = 1;
    const read = r.ble.onRead!;
    r.ble.onRead = (pid, ch) => {
      if (ch === AUTH_CHAR && drops > 0 && r.cams.get(0xd5)!.authWrites.length > 0) {
        drops -= 1;
        r.ble.drop(pid);
        throw { message: 'Device is not connected' };
      }
      return read(pid, ch);
    };
    expect((await withCode(r, (f) => f.scanned(link(0xd5)))).kind).toBe('done');
    expect(r.ble.calls.filter((c) => c === `connect:${id}`)).toHaveLength(2);

    const twice = rig();
    const read2 = twice.ble.onRead!;
    twice.ble.onRead = (pid, ch) => {
      if (ch === AUTH_CHAR && twice.cams.get(0xd5)!.authWrites.length > 0) {
        twice.ble.drop(pid);
        throw { message: 'Device is not connected' };
      }
      return read2(pid, ch);
    };
    expect(await withCode(twice, (f) => f.scanned(link(0xd5)))).toMatchObject({ kind: 'failed', reason: 'error' });
  });
});

describe('the typed code', () => {
  const typed = formatCode(S, 'label');

  test('without a name: every DashPal in pairing mode, strongest first; one with another code answers R_WRONG_CODE, the next pairs', async () => {
    const r = rig({ cams: [{ last: 0x01, S: new Uint8Array(16).fill(7), rssi: -40 }, { last: 0x02, rssi: -60 }, { last: 0x03, rssi: -90 }] });
    const end = await withCode(r, (f) => f.submitCode(typed));
    expect(end).toMatchObject({ kind: 'done', paired: { dashcamId: camOf(0x02) } });
    expect(r.cams.get(0x01)!.authWrites.map((w) => w[0])).toEqual([0x10]);
    expect(r.cams.get(0x03)!.authWrites).toEqual([]); // too weak (below −80 dBm)
  });

  test('without a name: a device that answers but cannot prove the code is skipped, the next pairs', async () => {
    const r = rig({ cams: [{ last: 0x01, rssi: -40 }, { last: 0x02, rssi: -60 }] });
    r.cams.get(0x01)!.badProof.pair = true;
    const end = await withCode(r, (f) => f.submitCode(typed));
    expect(end).toMatchObject({ kind: 'done', paired: { dashcamId: camOf(0x02) } });
  });

  test('without a name: none matches: no_match; only proofs failed: unverified_nearby', async () => {
    const r = rig({ cams: [{ last: 0x01, S: new Uint8Array(16).fill(7) }, { last: 0x02, S: new Uint8Array(16).fill(8) }] });
    expect(await withCode(r, (f) => f.submitCode(typed))).toEqual({ kind: 'failed', reason: 'no_match', name: null });
    const p = rig({ cams: [{ last: 0x01 }] });
    p.cams.get(0x01)!.badProof.pair = true;
    expect(await withCode(p, (f) => f.submitCode(typed))).toEqual({ kind: 'failed', reason: 'unverified_nearby', name: null });
  });

  test('with the name on the label: that DashPal only (iOS by its name, Android by its address)', async () => {
    for (const platform of ['ios', 'android'] as const) {
      const r = rig({ platform, cams: [{ last: 0x01, rssi: -40 }, { last: 0x02, rssi: -60 }] });
      const end = await withCode(r, (f) => f.submitCode(typed, 'c402'));
      expect(end).toMatchObject({ kind: 'done', paired: { dashcamId: camOf(0x02) } });
      expect(r.cams.get(0x01)!.authWrites).toEqual([]);
    }
  });
});

describe('the outcome of PAIR_FIN unknown', () => {
  function dropAfterFin(r: Rig): void {
    const read = r.ble.onRead!;
    let dropped = false;
    r.ble.onRead = (pid, ch) => {
      const cam = r.cams.get(0xd5)!;
      if (!dropped && ch === AUTH_CHAR && cam.authWrites.at(-1)?.[0] === 0x11) {
        dropped = true;
        r.ble.drop(pid);
        throw { message: 'Device is not connected' };
      }
      return read(pid, ch);
    };
  }

  test('the dashcam stored it: one reconnect and a session with the new key finish the setup', async () => {
    const r = rig();
    dropAfterFin(r);
    expect((await withCode(r, (f) => f.scanned(link(0xd5)))).kind).toBe('done');
    expect(await r.secrets.readAuth()).not.toBeNull();
  });

  test('the dashcam did not store it (R_UNKNOWN_PHONE): error, the key deleted', async () => {
    const r = rig();
    dropAfterFin(r);
    r.cams.get(0xd5)!.force.pair_fin = R.OK; // answered R_OK but stores nothing (the drop hides it)
    const end = await withCode(r, (f) => f.scanned(link(0xd5)));
    expect(end).toMatchObject({ kind: 'failed', reason: 'error' });
    expect(await r.secrets.readPendingAuth()).toBeNull();
    expect(await r.secrets.readOrphan()).toBeNull();
  });

  test('PAIR_FIN answered R_OK but the key cannot be made final: error, the key kept as the orphan; the next setup replaces that record (prev_id)', async () => {
    const r = rig();
    const finalize = r.secrets.finalizeAuth;
    r.secrets.finalizeAuth = async () => {
      throw new Error('errSecInteractionNotAllowed');
    };
    const end = await withCode(r, (f) => f.scanned(link(0xd5)));
    expect(end).toMatchObject({ kind: 'failed', reason: 'error' });
    const cam = r.cams.get(0xd5)!;
    const orphan = await r.secrets.readOrphan();
    expect(orphan?.dashcamId).toBe(camOf(0xd5));
    expect([...cam.phones.keys()]).toEqual([orphan!.phoneId]);
    expect(await r.secrets.readPendingAuth()).toBeNull();
    r.secrets.finalizeAuth = finalize;
    cam.windowOpen = true;
    expect((await withCode(r, (f) => f.scanned(link(0xd5)))).kind).toBe('done');
    expect(cam.phones.size).toBe(1);
    expect(await r.secrets.readOrphan()).toBeNull();
  });

  test('Cancel while finishing (PAIR_FIN sent, its RESULT not read): cancelled, the key kept as the orphan; the next setup replaces that record (prev_id)', async () => {
    const r = rig();
    const cam = r.cams.get(0xd5)!;
    const write = r.ble.onWrite!;
    r.ble.onWrite = (w) => {
      if (w.characteristic === AUTH_CHAR && w.bytes[0] === 0x11) {
        expect(r.flow.phase().kind).toBe('finishing');
        void r.flow.cancel();
      }
      return write(w);
    };
    const end = await withCode(r, (f) => f.scanned(link(0xd5)));
    expect(end.kind).toBe('cancelled');
    expect(cam.phones.size).toBe(1); // the dashcam stored it
    const orphan = await r.secrets.readOrphan();
    expect(orphan?.phoneId).toBe([...cam.phones.keys()][0]);
    expect(await r.secrets.readPendingAuth()).toBeNull();
    r.ble.onWrite = write;
    cam.windowOpen = true;
    expect((await withCode(r, (f) => f.scanned(link(0xd5)))).kind).toBe('done');
    expect(cam.phones.size).toBe(1);
  });

  test('no reconnect within 15 s: error, the key kept only as the orphan', async () => {
    const r = rig();
    dropAfterFin(r);
    const write = r.ble.onWrite!;
    r.ble.onWrite = (w) => {
      if (w.characteristic === AUTH_CHAR && w.bytes[0] === 0x11) r.ble.connectMode.set(idOf('android', 0xd5), 'reject');
      return write(w);
    };
    const end = await withCode(r, (f) => f.scanned(link(0xd5)));
    expect(end).toMatchObject({ kind: 'failed', reason: 'error' });
    expect(await r.secrets.readPendingAuth()).toBeNull();
    expect((await r.secrets.readOrphan())?.dashcamId).toBe(camOf(0xd5));
  });

  describe('Set up again of the paired DashPal with an orphan for it', () => {
    const same: PairedDashcam = { dashcamId: camOf(0xd5), peripheralId: idOf('android', 0xd5), name: 'DashPal-C4D5', pairedAt: 1, secure: true };
    const prevOf = (cam: FakeDashcam) => toHex(cam.authWrites.filter((w) => w[0] === 0x10).at(-1)!.slice(10, 18));

    test('its outcome stayed unknown and the old key is then refused (R_UNKNOWN_PHONE): the next Set up again proves the orphan, so its record is replaced, not added to', async () => {
      const r = rig({ previous: same });
      const cam = r.cams.get(0xd5)!;
      expect((await withCode(r, (f) => f.scanned(link(0xd5)))).kind).toBe('done');
      const old = (await r.secrets.readAuth())!;
      // Set up again: the dashcam stores it (prev_id proven: the old record goes), its RESULT is lost, no reconnect.
      cam.windowOpen = true;
      dropAfterFin(r);
      const write = r.ble.onWrite!;
      r.ble.onWrite = (w) => {
        if (w.characteristic === AUTH_CHAR && w.bytes[0] === 0x11) r.ble.connectMode.set(idOf('android', 0xd5), 'reject');
        return write(w);
      };
      expect(await withCode(r, (f) => f.scanned(link(0xd5)))).toMatchObject({ kind: 'failed', reason: 'error' });
      expect(prevOf(cam)).toBe(old.phoneId);
      const orphan = (await r.secrets.readOrphan())!;
      expect([...cam.phones.keys()]).toEqual([orphan.phoneId]);
      expect((await r.secrets.readAuth())?.phoneId).toBe(old.phoneId);
      // The auto-connect resumes with the old key: refused ("Needs pairing again").
      r.refused.on = true;
      r.ble.onWrite = write;
      r.ble.connectMode.delete(idOf('android', 0xd5));
      cam.windowOpen = true;
      expect((await withCode(r, (f) => f.scanned(link(0xd5)))).kind).toBe('done');
      expect(prevOf(cam)).toBe(orphan.phoneId);
      expect(cam.phones.size).toBe(1);
      expect([...cam.phones.keys()]).toEqual([(await r.secrets.readAuth())!.phoneId]);
      expect(await r.secrets.readOrphan()).toBeNull();
    });

    test('the old key still works (not refused): it proves prev_id, not the orphan', async () => {
      const r = rig({ previous: same });
      const cam = r.cams.get(0xd5)!;
      expect((await withCode(r, (f) => f.scanned(link(0xd5)))).kind).toBe('done');
      const old = (await r.secrets.readAuth())!;
      // An orphan the dashcam never stored.
      await r.secrets.writeOrphan({ dashcamId: camOf(0xd5), phoneId: '0909090909090909', kPair: 'cd'.repeat(32) });
      cam.windowOpen = true;
      expect((await withCode(r, (f) => f.scanned(link(0xd5)))).kind).toBe('done');
      expect(prevOf(cam)).toBe(old.phoneId);
      expect(cam.phones.size).toBe(1);
      expect(await r.secrets.readOrphan()).toBeNull();
    });
  });
});

describe('replacing, cancelling', () => {
  const previous: PairedDashcam = { dashcamId: camOf(0x01), peripheralId: idOf('android', 0x01), name: 'DashPal-C401', pairedAt: 1, secure: true };

  test('a different DashPal than the paired one: confirm_replace first; Replace pairs and replaces; Cancel keeps the previous pairing', async () => {
    const r = rig({ previous });
    const done = r.flow.start();
    await r.until('code');
    r.flow.scanned(link(0xd5));
    expect(await r.until('confirm_replace')).toEqual({ kind: 'confirm_replace', from: 'DashPal-C401', to: 'DashPal-C4D5' });
    expect(r.cams.get(0xd5)!.authWrites).toEqual([]);
    r.flow.confirmReplace();
    await done;
    expect(r.flow.phase().kind).toBe('done');
    expect(r.paired.map((p) => p.dashcamId)).toEqual([camOf(0xd5)]);

    const c = rig({ previous });
    const cdone = c.flow.start();
    await c.until('code');
    c.flow.scanned(link(0xd5));
    await c.until('confirm_replace');
    await c.flow.cancel();
    await cdone;
    expect(c.flow.phase().kind).toBe('cancelled');
    expect(c.paired).toEqual([]);
    expect(c.log).toContain('resumePaired');
    expect(c.cams.get(0xd5)!.authWrites).toEqual([]);
  });

  test('the same DashPal again: no confirm_replace', async () => {
    const r = rig({ previous: { ...previous, dashcamId: camOf(0xd5), peripheralId: idOf('android', 0xd5), name: 'DashPal-C4D5' } });
    expect((await withCode(r, (f) => f.scanned(link(0xd5)))).kind).toBe('done');
    expect(kinds(r)).not.toContain('confirm_replace');
  });

  test.each(['code', 'confirm_link', 'press_button', 'waiting_busy'] as const)('cancel at %s: no key kept, the held code deleted, the paired DashPal never stepped aside or resumed', async (at) => {
    const r = rig({ previous, cams: [{ last: 0xd5, windowOpen: at !== 'press_button' }] });
    if (at === 'waiting_busy') r.cams.get(0xd5)!.busy = true;
    if (at === 'confirm_link') await r.secrets.writePendingCode({ at: r.clock.t, dashcamId: camOf(0xd5), code: formatCode(S, 'label', { dashes: false }) });
    const done = r.flow.start(at === 'confirm_link' ? { fromLink: { dashcamId: camOf(0xd5) } } : {});
    if (at === 'code' || at === 'confirm_link') {
      await r.until(at);
      await r.flow.cancel();
    } else {
      await r.until('code');
      r.flow.scanned(link(0xd5));
      await r.until('confirm_replace');
      // cancelled 2 s into the wait (virtual time)
      r.at(2000, () => void r.flow.cancel());
      r.flow.confirmReplace();
    }
    await done;
    if (at === 'press_button' || at === 'waiting_busy') expect(kinds(r)).toContain(at);
    await flush();
    expect(r.flow.phase().kind).toBe('cancelled');
    expect(await r.secrets.readPendingAuth()).toBeNull();
    expect(await r.secrets.readPendingCode(r.clock.t)).toBeNull();
    if (at === 'code' || at === 'confirm_link') {
      // Waiting for the driver only: the paired DashPal's auto-connect was never touched.
      expect(r.log).not.toContain('stepAside');
      expect(r.log).not.toContain('resumePaired');
    } else {
      expect(r.log.filter((l) => l === 'stepAside' || l === 'resumePaired').at(-1)).toBe('resumePaired');
    }
    expect(r.paired).toEqual([]);
  });
});

describe('the paired DashPal while setup waits, and a drive opening', () => {
  const same: PairedDashcam = { dashcamId: camOf(0xd5), peripheralId: idOf('android', 0xd5), name: 'DashPal-C4D5', pairedAt: 1, secure: true };
  const other: PairedDashcam = { dashcamId: camOf(0x01), peripheralId: idOf('android', 0x01), name: 'DashPal-C401', pairedAt: 1, secure: true };
  const target = (p: PairedDashcam) => ({ peripheralId: p.peripheralId, dashcamId: p.dashcamId, auth: { phoneId: '0102030405060708', kPair: '11'.repeat(32) } });
  const aside = (r: Rig) => r.log.filter((l) => l === 'stepAside' || l === 'resumePaired');

  test('waiting at the code step keeps the auto-connect; a drive opening ends the setup at once (busy), the auto-connect never touched', async () => {
    const r = rig({ previous: same });
    r.t.setTarget(target(same));
    const done = r.flow.start();
    await r.until('code');
    expect(r.t.target()).not.toBeNull();
    r.setBusy(true);
    await done;
    expect(r.flow.phase()).toEqual({ kind: 'busy' });
    expect(r.t.target()?.dashcamId).toBe(same.dashcamId);
    expect(aside(r)).toEqual([]);
  });

  test('a link for the paired DashPal: no pre-warm (its auto-connect keeps that link) while Pair shows; a drive opening ends it', async () => {
    const r = rig({ previous: same });
    r.t.setTarget(target(same));
    await r.secrets.writePendingCode({ at: r.clock.t, dashcamId: same.dashcamId, code: formatCode(S, 'label', { dashes: false }) });
    const done = r.flow.start({ fromLink: { dashcamId: same.dashcamId } });
    await r.until('confirm_link');
    await flush();
    expect(r.t.target()).not.toBeNull();
    expect(r.ble.calls.filter((c) => c.startsWith('scan:'))).toEqual([]);
    r.setBusy(true);
    await done;
    expect(r.flow.phase()).toEqual({ kind: 'busy' });
    expect(aside(r)).toEqual([]);
  });

  test('Pair on that link: the auto-connect steps aside for the pairing step only, and the setup pairs', async () => {
    const r = rig({ previous: same });
    r.t.setTarget(target(same));
    await r.secrets.writePendingCode({ at: r.clock.t, dashcamId: same.dashcamId, code: formatCode(S, 'label', { dashes: false }) });
    const done = r.flow.start({ fromLink: { dashcamId: same.dashcamId } });
    await r.until('confirm_link');
    r.flow.confirm();
    await done;
    expect(r.flow.phase().kind).toBe('done');
    expect(aside(r)).toEqual(['stepAside']);
  });

  test('Replace asked: the auto-connect comes back while the driver decides; a drive opening ends the setup (busy)', async () => {
    const r = rig({ previous: other });
    const done = r.flow.start();
    await r.until('code');
    r.flow.scanned(link(0xd5));
    await r.until('confirm_replace');
    expect(aside(r)).toEqual(['stepAside', 'resumePaired']);
    r.setBusy(true);
    await done;
    expect(r.flow.phase()).toEqual({ kind: 'busy' });
    expect(aside(r)).toEqual(['stepAside', 'resumePaired']);
    expect(r.cams.get(0xd5)!.authWrites).toEqual([]);
  });

  test('a drive opening while "press the button" is watched ends the setup at once, not after 60 s, and gives the auto-connect back', async () => {
    const r = rig({ previous: same, cams: [{ last: 0xd5, windowOpen: false }] });
    const done = r.flow.start();
    let t0 = 0;
    r.flow.subscribe((p) => {
      if (p.kind !== 'press_button') return;
      t0 = r.clock.t;
      r.at(1000, () => r.setBusy(true));
    });
    await r.until('code');
    r.flow.scanned(link(0xd5));
    await done;
    expect(kinds(r)).toContain('press_button');
    expect(r.flow.phase()).toEqual({ kind: 'busy' });
    expect(r.clock.t - t0).toBeLessThan(5000);
    expect(aside(r)).toEqual(['stepAside', 'resumePaired']);
  });
});

void INFO_CHAR;

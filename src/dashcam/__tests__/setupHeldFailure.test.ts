// A setup failure that Try again resumes (R_STORE_FAILED, an unanswered commit) keeps the hold with
// no segment running: the speed watch stops until Try again, and a drive that opens meanwhile still
// stops the setup as it would during one (the hold undone, the paired DashPal given back). On the
// real transport over the fake BLE stack and a fake dashcam, with a virtual clock.
import { createFakeDashcam, type FakeDashcam } from '../__fixtures__/fakeDashcam';
import { R } from '../auth';
import { createFakeBle, type FakeBle } from '../fakeTransport';
import type { PairedDashcam } from '../keys';
import { toHex } from '../protocol';
import { createDashpalSecrets, type DashpalSecrets } from '../secure';
import { createSetupFlow, type SetupFlow, type SetupPhase } from '../setup';
import type { SetupSpeed } from '../setupSpeed';
import { createBleTransport } from '../transport';

const flush = async () => {
  for (let i = 0; i < 60; i++) await new Promise<void>((resolve) => setImmediate(resolve));
};

const macOf = (last: number) => [0xa4, 0xcf, 0x12, 0xb3, 0xc4, last];
const idOf = (last: number) => macOf(last).map((b) => b.toString(16).padStart(2, '0').toUpperCase()).join(':');
/** The Home card's DashPal (no search). */
const TARGET = { target: { peripheralId: idOf(0xd5), name: 'DashPal-C4D5', adv: 'new' as const } };

interface Rig {
  flow: SetupFlow;
  ble: FakeBle;
  cam: FakeDashcam;
  secrets: DashpalSecrets;
  log: string[];
  speed: { started: number; stopped: number };
  setBusy(v: boolean): void;
  until(kinds: SetupPhase['kind'][]): Promise<SetupPhase>;
}

function rig(): Rig {
  const ble = createFakeBle();
  const t = createBleTransport(ble, { platform: 'android', setTimer: () => 0, clearTimer: () => {} });
  const cam = createFakeDashcam({ ble, id: idOf(0xd5), mac: macOf(0xd5), windowOpen: true });
  const store = new Map<string, string>();
  const secrets = createDashpalSecrets(() => ({
    getItemAsync: async (k) => store.get(k) ?? null,
    setItemAsync: async (k, v) => void store.set(k, v),
    deleteItemAsync: async (k) => void store.delete(k),
  }));
  // Another DashPal is paired: this setup replaces it, so it steps aside from the Pair tap.
  const previous: PairedDashcam = { dashcamId: toHex(macOf(0x01)), peripheralId: idOf(0x01), name: 'DashPal-C401', pairedAt: 1, secure: true };
  const log: string[] = [];
  const speed = { started: 0, stopped: 0 };
  const clock = { t: 1_000_000 };
  let busy = false;
  const driveFns = new Set<() => void>();
  const fakeSpeed = (): SetupSpeed => ({
    start: async () => void (speed.started += 1),
    speedCms: () => null,
    stop: () => void (speed.stopped += 1),
  });
  const flow = createSetupFlow({
    platform: 'android',
    transport: () => t,
    requestBluetooth: async () => 'granted',
    isBusy: () => busy,
    onDriveChange: (fn) => {
      driveFns.add(fn);
      return () => void driveFns.delete(fn);
    },
    optIn: async () => {},
    pair: async (r) => void log.push(`pair:${r.dashcamId}`),
    paired: () => previous,
    keyRefused: () => false,
    stepAside: () => void log.push('stepAside'),
    resumePaired: async () => void log.push('resumePaired'),
    secrets,
    speed: fakeSpeed,
    localMinute: () => 600,
    onError: (e, ctx) => void log.push(`error:${ctx}:${e instanceof Error ? e.message : String(e)}`),
    now: () => clock.t,
    sleep: async (ms) => {
      clock.t += ms;
      await new Promise<void>((resolve) => setImmediate(resolve));
    },
  });
  return {
    flow,
    ble,
    cam,
    secrets,
    log,
    speed,
    setBusy(v) {
      busy = v;
      for (const fn of [...driveFns]) fn();
    },
    async until(kinds) {
      for (let i = 0; i < 4000; i++) {
        if (kinds.includes(flow.phase().kind)) return flow.phase();
        await flush();
      }
      throw new Error(`never reached ${kinds.join('/')}; now ${flow.phase().kind}`);
    },
  };
}

/** To screen 2, then Next with the commit answered R_STORE_FAILED: failed save_failed, the hold kept. */
async function storeFailed(r: Rig): Promise<void> {
  void r.flow.start(TARGET);
  await r.until(['confirm']);
  r.flow.pair();
  await r.until(['instructions']);
  r.cam.commit = R.STORE_FAILED;
  r.flow.next();
  expect(await r.until(['done', 'failed', 'cancelled', 'busy'])).toMatchObject({ kind: 'failed', reason: 'save_failed', retry: 'commit' });
}

describe('a setup failure Try again resumes', () => {
  test('keeps the hold and the paired DashPal aside, with the speed watch stopped until Try again', async () => {
    const r = rig();
    await storeFailed(r);
    expect(r.cam.prov).not.toBeNull();
    expect(await r.secrets.readPendingAuth()).not.toBeNull();
    expect(r.log).toEqual(['stepAside']);
    expect(r.speed).toEqual({ started: 1, stopped: 1 });
    await r.flow.retry();
    expect(await r.until(['done', 'failed'])).toMatchObject({ kind: 'done' });
    expect(r.speed.started).toBe(2);
    expect(r.log).toContain(`pair:${toHex(macOf(0xd5))}`);
  });

  test('a drive that opens meanwhile undoes the hold, gives the paired DashPal back and says busy', async () => {
    const r = rig();
    await storeFailed(r);
    r.setBusy(true);
    expect(await r.until(['busy', 'cancelled', 'done'])).toEqual({ kind: 'busy' });
    expect(r.cam.prov).toBeNull();
    expect(await r.secrets.readPendingAuth()).toBeNull();
    expect(r.log).toEqual(['stepAside', 'resumePaired']);
    // Try again is gone with the hold.
    await r.flow.retry();
    await flush();
    expect(r.flow.phase()).toEqual({ kind: 'busy' });
  });

  test('a drive that opened while the commit was answered stops it as the failure lands', async () => {
    const r = rig();
    void r.flow.start(TARGET);
    await r.until(['confirm']);
    r.flow.pair();
    await r.until(['instructions']);
    r.cam.commit = R.STORE_FAILED;
    // The drive opens just as COMMAND 8 reaches the DashPal: once it is out, a drive no longer
    // stops the running segment (its answer ends the setup); the failure it answers does.
    const write = r.ble.onWrite!;
    r.ble.onWrite = async (w) => {
      await write(w);
      const last = r.cam.received.at(-1);
      if (last?.type === 'COMMAND' && last.op === 8) r.setBusy(true);
    };
    r.flow.next();
    expect(await r.until(['busy', 'cancelled', 'done'])).toEqual({ kind: 'busy' });
    expect(r.cam.prov).toBeNull();
    expect(r.log).toEqual(['stepAside', 'resumePaired']);
  });

  test('Cancel on the failure ends the watch: a drive opening later changes nothing more', async () => {
    const r = rig();
    await storeFailed(r);
    await r.flow.cancel();
    expect(r.flow.phase()).toEqual({ kind: 'cancelled' });
    expect(r.log).toEqual(['stepAside', 'resumePaired']);
    r.setBusy(true);
    await flush();
    expect(r.flow.phase()).toEqual({ kind: 'cancelled' });
    expect(r.log).toEqual(['stepAside', 'resumePaired']);
  });
});

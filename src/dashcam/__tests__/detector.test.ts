import {
  classify,
  createDetector,
  DETECT_EVERY_MS,
  DETECT_MIN_GAP_MS,
  DETECT_PULL_EVERY_MS,
  DETECT_SCAN_SECONDS,
  SNOOZE_MS,
  snoozed,
  type DetectorDeps,
  type PairedView,
} from '../detector';
import { PAIRING_NEW, PAIRING_OPEN, type AdvState } from '../protocol';
import type { ScanHit } from '../transport';

function rig(over: Partial<DetectorDeps> = {}) {
  const clock = { t: 1_000_000 };
  const scans: { seconds: number; services: readonly string[] }[] = [];
  let onHit: ((h: ScanHit) => void) | null = null;
  let stopped = 0;
  const hits: ScanHit[] = [];
  const state = {
    optIn: true,
    busy: false,
    home: true,
    setup: false,
    connected: false,
    ready: true,
    mph: 0 as number | null,
    snoozes: {} as Record<string, number>,
    paired: null as PairedView | null,
  };
  const deps: DetectorDeps = {
    now: () => clock.t,
    btOptIn: () => state.optIn,
    bluetoothReady: async () => state.ready,
    isBusy: () => state.busy,
    onHome: () => state.home,
    speedMph: async () => state.mph,
    setupOpen: () => state.setup,
    paired: () => state.paired,
    pairedConnected: () => state.connected,
    snoozes: async () => state.snoozes,
    scan: async (o) => {
      scans.push({ seconds: o.seconds, services: o.services });
      onHit = o.onHit;
      for (const h of hits) o.onHit(h);
      return { stop: async () => void (stopped += 1) };
    },
    sleep: async (ms) => {
      clock.t += ms;
    },
    ...over,
  };
  return { d: createDetector(deps), clock, scans, state, hits, hit: (h: ScanHit) => onHit?.(h), stopped: () => stopped };
}

const hit = (id: string, rssi: number, adv: AdvState | null = 'new', name: string | null = `DashPal-${id}`): ScanHit => ({ id, name, rssi, adv });
const PAIRED_VIEW: PairedView = { peripheralId: 'OWN', name: 'DashPal-C4D5', unknownPhone: false };

test('an 8 s scan for the new and open pairing services finds the strongest DashPal with no phone paired (RSSI ≥ −80)', async () => {
  const r = rig();
  r.hits.push(hit('A', -70), hit('B', -50), hit('C', -90), hit('D', -40, 'closed'), hit('E', -30, 'open'), hit('F', -20, 'setup'), hit('G', -10, null));
  expect(await r.d.check()).toEqual({ kind: 'found', found: { id: 'B', name: 'DashPal-B', rssi: -50, kind: 'new', adv: 'new' } });
  expect(r.scans).toEqual([{ seconds: DETECT_SCAN_SECONDS, services: [PAIRING_NEW, PAIRING_OPEN] }]);
  expect(DETECT_SCAN_SECONDS).toBe(8);
  expect(r.stopped()).toBe(1);
});

test.each([
  ['not opted in', { optIn: false }],
  ['drive open', { busy: true }],
  ['not on Home', { home: false }],
  ['setup open', { setup: true }],
  ['paired dashcam connected', { connected: true, paired: PAIRED_VIEW }],
  ['bluetooth not ready', { ready: false }],
  ['moving or speed unknown', { mph: 3 }],
  ['moving or speed unknown', { mph: null }],
] as const)('never scans when %s', async (why, change) => {
  const r = rig();
  Object.assign(r.state, change);
  expect(await r.d.check()).toEqual({ kind: 'skipped', why });
  expect(r.scans).toEqual([]);
});

test('at most one scan a minute; pull to refresh may scan again 10 s after the last one', async () => {
  const r = rig();
  expect((await r.d.check()).kind).toBe('none');
  const scanTook = DETECT_SCAN_SECONDS * 1000;
  r.clock.t += DETECT_PULL_EVERY_MS - scanTook - 1;
  expect(await r.d.check({ pull: true })).toEqual({ kind: 'skipped', why: 'too soon' });
  r.clock.t += 1;
  expect((await r.d.check({ pull: true })).kind).toBe('none');
  r.clock.t += DETECT_EVERY_MS - scanTook - 1;
  expect(await r.d.check()).toEqual({ kind: 'skipped', why: 'too soon' });
  r.clock.t += 1;
  expect((await r.d.check()).kind).toBe('none');
  expect(r.scans).toHaveLength(3);
  expect(DETECT_EVERY_MS).toBe(60_000);
});

test('a snoozed DashPal is not offered; one whose snooze ran out is', async () => {
  const r = rig();
  r.state.snoozes = { A: r.clock.t + 1000, B: r.clock.t - 1 };
  r.hits.push(hit('A', -40), hit('B', -45));
  expect(await r.d.check()).toEqual({ kind: 'found', found: { id: 'B', name: 'DashPal-B', rssi: -45, kind: 'new', adv: 'new' } });
});

test('this phone’s own DashPal: again when it advertises no phone paired, or pairing open after it refused this phone’s key; never new', async () => {
  const r = rig();
  r.state.paired = PAIRED_VIEW;
  r.hits.push(hit('own', -60, 'new', null));
  expect(await r.d.check()).toEqual({ kind: 'found', found: { id: 'own', name: 'DashPal-C4D5', rssi: -60, kind: 'again', adv: 'new' } });

  expect(classify('open', 'OWN', PAIRED_VIEW, false)).toBeNull();
  expect(classify('open', 'OWN', { ...PAIRED_VIEW, unknownPhone: true }, false)).toBe('again');
  expect(classify('closed', 'OWN', { ...PAIRED_VIEW, unknownPhone: true }, false)).toBeNull();
  expect(classify('setup', 'OWN', { ...PAIRED_VIEW, unknownPhone: true }, false)).toBeNull();
});

test('another DashPal: new only with no phone paired, and nothing while the paired one is connected', () => {
  expect(classify('new', 'X', null, false)).toBe('new');
  expect(classify('open', 'X', null, false)).toBeNull();
  expect(classify('new', 'X', PAIRED_VIEW, false)).toBe('new');
  expect(classify('new', 'X', PAIRED_VIEW, true)).toBeNull();
});

test('a drive starting mid-scan drops it (no card)', async () => {
  const r = rig({
    sleep: async () => {
      r.clock.t += 250;
      r.state.busy = true;
    },
  });
  r.hits.push(hit('A', -40));
  expect(await r.d.check()).toEqual({ kind: 'skipped', why: 'interrupted' });
  expect(r.stopped()).toBe(1);
});

test('leaving Home mid-scan, or abort(), stops the scan', async () => {
  const r = rig({
    sleep: async () => {
      r.clock.t += 250;
      r.state.home = false;
    },
  });
  r.hits.push(hit('A', -40));
  expect(await r.d.check()).toEqual({ kind: 'skipped', why: 'interrupted' });

  const a = rig({
    sleep: async () => {
      a.clock.t += 250;
      await a.d.abort();
    },
  });
  a.hits.push(hit('A', -40));
  expect(await a.d.check()).toEqual({ kind: 'skipped', why: 'interrupted' });
  expect(a.stopped()).toBeGreaterThanOrEqual(1);
});

test('a scan cut short does not use up the minute: Home in view again 10 s after it started scans again (sooner is too soon)', async () => {
  let leave = true;
  const r = rig({
    sleep: async (ms) => {
      r.clock.t += ms;
      if (leave) r.state.home = false;
    },
  });
  r.hits.push(hit('A', -40));
  const startedAt = r.clock.t;
  expect(await r.d.check()).toEqual({ kind: 'skipped', why: 'interrupted' });
  leave = false;
  r.state.home = true;
  r.clock.t = startedAt + DETECT_MIN_GAP_MS - 1;
  expect(await r.d.check()).toEqual({ kind: 'skipped', why: 'too soon' });
  r.clock.t = startedAt + DETECT_MIN_GAP_MS;
  expect(await r.d.check()).toMatchObject({ kind: 'found', found: { id: 'A' } });
  expect(r.scans).toHaveLength(2);
  // A scan that ran to its end does count: the next one waits the minute.
  r.clock.t += DETECT_MIN_GAP_MS;
  expect(await r.d.check()).toEqual({ kind: 'skipped', why: 'too soon' });
  expect(DETECT_MIN_GAP_MS).toBe(10_000);
});

test('Home left and back while a check still waits for its reads: no scan opens for the left one, and the new one scans once it has ended', async () => {
  let ready: (v: boolean) => void = () => {};
  let asked = 0;
  const r = rig({
    bluetoothReady: () => {
      asked += 1;
      return asked === 1 ? new Promise<boolean>((resolve) => (ready = resolve)) : Promise.resolve(true);
    },
  });
  r.hits.push(hit('A', -40));
  const first = r.d.check();
  r.state.home = false;
  await r.d.abort();
  r.state.home = true;
  const second = r.d.check();
  ready(true);
  expect(await first).toEqual({ kind: 'skipped', why: 'interrupted' });
  expect(await second).toMatchObject({ kind: 'found', found: { id: 'A' } });
  expect(r.scans).toHaveLength(1);
});

test('a check while one scans (not cut short): already scanning', async () => {
  let release: () => void = () => {};
  const r = rig({ sleep: () => new Promise<void>((resolve) => (release = () => resolve())) });
  const first = r.d.check();
  await new Promise((resolve) => setImmediate(resolve));
  expect(await r.d.check()).toEqual({ kind: 'skipped', why: 'already scanning' });
  r.clock.t += DETECT_SCAN_SECONDS * 1000;
  release();
  expect((await first).kind).toBe('none');
});

test('snoozed(): 7 days for this one; expired entries are dropped', () => {
  expect(snoozed({ old: 5, keep: 2_000 }, 'X', 1_000)).toEqual({ keep: 2_000, X: 1_000 + SNOOZE_MS });
});

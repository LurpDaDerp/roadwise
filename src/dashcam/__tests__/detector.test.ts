import { createDetector, DETECT_EVERY_MS, SNOOZE_MS, snoozed, type DetectorDeps } from '../detector';
import type { ScanHit } from '../transport';

function rig(over: Partial<DetectorDeps> = {}) {
  const clock = { t: 1_000_000 };
  const scans: number[] = [];
  let onHit: ((h: ScanHit) => void) | null = null;
  let stopped = 0;
  const hits: ScanHit[] = [];
  const state = { optIn: true, busy: false, driveRoute: false, setup: false, connected: false, ready: true, mph: 0 as number | null, snoozes: {} as Record<string, number>, paired: null as string | null };
  const deps: DetectorDeps = {
    now: () => clock.t,
    btOptIn: () => state.optIn,
    bluetoothReady: async () => state.ready,
    isBusy: () => state.busy,
    onDriveRoute: () => state.driveRoute,
    speedMph: async () => state.mph,
    setupRunning: () => state.setup,
    pairedPeripheralId: () => state.paired,
    pairedConnected: () => state.connected,
    snoozes: async () => state.snoozes,
    scan: async (o) => {
      scans.push(o.seconds);
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

const hit = (id: string, rssi: number, pairing = true): ScanHit => ({ id, name: `DashPal-${id}`, rssi, pairing });

test('row 23: finds the strongest DashPal in pairing mode (RSSI ≥ −80) after a 10 s scan', async () => {
  const r = rig();
  r.hits.push(hit('A', -70), hit('B', -50), hit('C', -90), hit('D', -40, false));
  expect(await r.d.check()).toEqual({ kind: 'found', found: { id: 'B', name: 'DashPal-B', rssi: -50 } });
  expect(r.scans).toEqual([10]);
  expect(r.stopped()).toBe(1);
});

test.each([
  ['not opted in', { optIn: false }],
  ['drive open', { busy: true }],
  ['drive route', { driveRoute: true }],
  ['setup running', { setup: true }],
  ['paired dashcam connected', { connected: true }],
  ['bluetooth not ready', { ready: false }],
  ['moving or speed unknown', { mph: 3 }],
  ['moving or speed unknown', { mph: null }],
] as const)('row 23: never scans when %s', async (why, change) => {
  const r = rig();
  Object.assign(r.state, change);
  expect(await r.d.check()).toEqual({ kind: 'skipped', why });
  expect(r.scans).toEqual([]);
});

test('at most one scan per 2 minutes', async () => {
  const r = rig();
  expect((await r.d.check()).kind).toBe('none');
  r.clock.t += DETECT_EVERY_MS - 10_001; // the scan itself took 10 s
  expect(await r.d.check()).toEqual({ kind: 'skipped', why: 'too soon' });
  r.clock.t += 1;
  expect((await r.d.check()).kind).toBe('none');
  expect(r.scans).toHaveLength(2);
});

test('a snoozed dashcam and the paired one (in pairing mode for another phone) are not offered', async () => {
  const r = rig();
  r.state.snoozes = { A: r.clock.t + 1000 };
  r.state.paired = 'b';
  r.hits.push(hit('A', -40), hit('B', -45));
  expect(await r.d.check()).toEqual({ kind: 'none' });
});

test('row 23: a drive starting mid-scan drops it (no prompt)', async () => {
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

test('snoozed(): 7 days for this one; expired entries are dropped', () => {
  expect(snoozed({ old: 5, keep: 2_000 }, 'X', 1_000)).toEqual({ keep: 2_000, X: 1_000 + SNOOZE_MS });
});

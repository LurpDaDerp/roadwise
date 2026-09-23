// The diagnostics host's shadow comparator (plan Task 16 remainder; validation stage 3 and the R-gaze row):
// in an internal build both gaze sources run on the same frames, one shadow engine each, so the panel can
// show the would-be alerts per hour of each source and their agreement (the median |Δyaw| and |Δpitch| in
// TRACKING, and the zone agreement %). It only listens: it never calls native (the controller owns the
// camera), and it keeps counts and aggregates only.
import type { FeatureRow } from '@/core/engine/types';
import { createFakeDmsVision, type FakeDmsVision } from '../../../../../modules/dms-vision/src/fake';
import { recordFromFeatures } from '../../../../../modules/dms-vision/src/wire';
import { EPOCH0, onRoad, rel, synthDrive, type DriverFn } from '../../replay/synth';
import { featuresFromFrame } from '../__fixtures__/records';
import { createShadowComparator, type DmsShadowComparator } from '../shadow';

const POWER = { batteryLevel: 80, charging: false, localMinutes: 720 };

async function running(fake: FakeDmsVision) {
  await fake.start({ gateToken: 'test', fps: 15, gazeNet: true, gazeNetEvery: 1, delegate: 'cpu', rotationOffsetDegrees: 0 });
}

/** A synthetic drive through the fake: rows to the comparator, frames through native's `frames` event. */
function feed(fake: FakeDmsVision, cmp: DmsShadowComparator, driver: DriverFn, seconds: number, o: { net?: boolean; seed?: number; heartbeat?: boolean; netOffAfterS?: number } = {}) {
  const items = synthDrive({ fps: 15, seconds, seed: o.seed ?? 5, source: o.net === false ? 'geometric' : 'net', driver });
  for (const it of items) {
    if (it.row) {
      cmp.pushRow(it.row.row as FeatureRow, POWER);
      // The controller's heartbeat, which keeps native running (here the test plays the controller).
      if (o.heartbeat !== false) void fake.setPolicy({ gateToken: 'test', capture: 'run', fps: 15, gazeNet: true, gazeNetEvery: 1, setupMode: false, previewAllowed: false });
    }
    const t = it.frame.tMs;
    if (t > fake.now()) fake.advance(t - fake.now());
    const f = o.netOffAfterS !== undefined && t >= o.netOffAfterS * 1000 ? { ...it.frame, net: null } : it.frame;
    fake.pushRecords([recordFromFeatures(featuresFromFrame(f))]);
  }
}

const attentive: DriverFn = (t, r) => ({ gaze: onRoad(r), speedKmh: 80 });
/** Attentive, with a 3.4 s centre-stack glance every 60 s from 100 s. */
const glances: DriverFn = (t, r) => ({ gaze: t >= 100 && (t - 100) % 60 < 3.4 ? rel(20, -25) : onRoad(r), speedKmh: 60 });

describe('the shadow comparator', () => {
  test('it only listens: no native call or query, whatever it is fed', async () => {
    const fake = createFakeDmsVision({ gazeNetAvailable: true, epochAtZero: EPOCH0 });
    await running(fake);
    const calls = fake.calls.length;
    const cmp = createShadowComparator(fake);
    feed(fake, cmp, attentive, 8, { heartbeat: false });
    expect(cmp.stats().geometric.frames).toBeGreaterThan(100);
    cmp.endDrive();
    cmp.stats();
    cmp.dispose();
    expect(fake.calls.length).toBe(calls);
    expect(fake.queries).toEqual([]);
  });

  test('would-be alerts per hour, per source: the glances are counted by both', async () => {
    const fake = createFakeDmsVision({ gazeNetAvailable: true, epochAtZero: EPOCH0 });
    await running(fake);
    const cmp = createShadowComparator(fake);
    feed(fake, cmp, glances, 400);
    const s = cmp.stats();
    expect(s.geometric.frames).toBeGreaterThan(5000);
    expect(s.rows).toBe(400);
    expect(s.geometric.alerts).toBeGreaterThanOrEqual(3);
    expect(s.net).not.toBeNull();
    expect(s.net!.alerts).toBeGreaterThanOrEqual(3);
    for (const src of [s.geometric, s.net!]) {
      expect(src.observedS).toBeGreaterThan(390);
      expect(src.alertsPerHour).toBeCloseTo(src.alerts / (src.observedS / 3600), 6);
    }
  });

  test('agreement: the median |Δyaw| and |Δpitch| in TRACKING, and the zone agreement', async () => {
    const fake = createFakeDmsVision({ gazeNetAvailable: true, epochAtZero: EPOCH0 });
    await running(fake);
    const cmp = createShadowComparator(fake);
    feed(fake, cmp, glances, 400);
    const a = cmp.stats().agreement;
    expect(a.frames).toBeGreaterThan(3000);
    expect(a.medianAbsDyawDeg).not.toBeNull();
    expect(a.medianAbsDyawDeg!).toBeLessThan(5);
    // Two different paths (the geometric one has a per-drive gain error): they differ, a little.
    expect(a.medianAbsDyawDeg! + a.medianAbsDpitchDeg!).toBeGreaterThan(0);
    expect(a.medianAbsDpitchDeg!).toBeLessThan(6);
    expect(a.zoneFrames).toBeGreaterThan(3000);
    expect(a.zoneAgreement!).toBeGreaterThan(0.9);
    expect(a.zoneAgreement!).toBeLessThanOrEqual(1);
  });

  test('a build without the net: the net column is empty and there is nothing to agree on', async () => {
    const fake = createFakeDmsVision({ gazeNetAvailable: false, epochAtZero: EPOCH0 });
    await running(fake);
    const cmp = createShadowComparator(fake);
    feed(fake, cmp, glances, 200, { net: false });
    const s = cmp.stats();
    expect(s.geometric.frames).toBeGreaterThan(2000);
    expect(s.net).toBeNull();
    expect(s.agreement).toMatchObject({ frames: 0, medianAbsDyawDeg: null, zoneAgreement: null });
  });

  test('counts and aggregates only: the stats stay small and hold no per-frame value', async () => {
    const fake = createFakeDmsVision({ gazeNetAvailable: true, epochAtZero: EPOCH0 });
    await running(fake);
    const cmp = createShadowComparator(fake);
    feed(fake, cmp, glances, 600);
    const json = JSON.stringify(cmp.stats());
    expect(json.length).toBeLessThan(2000);
    const leaves: unknown[] = [];
    const walk = (v: unknown) => (typeof v === 'object' && v !== null ? Object.values(v).forEach(walk) : leaves.push(v));
    walk(JSON.parse(json));
    expect(leaves.every((v) => typeof v === 'number' || v === null)).toBe(true);
    expect(/\[/.test(json)).toBe(false); // no arrays at all
  });

  test('a drive end starts new shadow drives and keeps the session’s totals; dispose stops listening', async () => {
    const fake = createFakeDmsVision({ gazeNetAvailable: true, epochAtZero: EPOCH0 });
    await running(fake);
    const cmp = createShadowComparator(fake);
    feed(fake, cmp, glances, 200);
    const one = cmp.stats().geometric;
    cmp.endDrive();
    feed(fake, cmp, glances, 200, { seed: 6 });
    const two = cmp.stats().geometric;
    expect(two.frames).toBeGreaterThan(one.frames);
    expect(two.alerts).toBeGreaterThan(one.alerts);
    cmp.dispose();
    feed(fake, cmp, attentive, 10);
    expect(cmp.stats().geometric.frames).toBe(two.frames);
  });
});

describe('T16 r3', () => {
  test('seat m3: the net column is pure net: with the net off, the net shadow never counts the geometric path', async () => {
    const fake = createFakeDmsVision({ gazeNetAvailable: true, epochAtZero: EPOCH0 });
    await running(fake);
    const cmp = createShadowComparator(fake);
    feed(fake, cmp, glances, 400, { netOffAfterS: 200 });
    const s = cmp.stats();
    expect(s.net).not.toBeNull();
    expect(s.net!.fallbackFrames).toBe(0);
    expect(s.geometric.fallbackFrames).toBe(0);
  });
  test('security m-2: frames are dropped while the paired controller does not own the camera', async () => {
    const fake = createFakeDmsVision({ gazeNetAvailable: true, epochAtZero: EPOCH0 });
    await running(fake);
    let owns = false;
    const cmp = createShadowComparator(fake, { active: () => owns });
    feed(fake, cmp, attentive, 5);
    expect(cmp.stats().geometric.frames).toBe(0);
    owns = true;
    feed(fake, cmp, attentive, 5, { seed: 8 });
    expect(cmp.stats().geometric.frames).toBeGreaterThan(50);
  });
});

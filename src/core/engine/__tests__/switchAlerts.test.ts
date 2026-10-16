// The phone alerts with screen switches (design §3.4, §12.3 machine items): the pickup alert once
// per episode, "Back to RoadWise" while a switch counts, the handling alert on use time and at
// least 10 s after the pickup alert, and its repeat every 60 s while the driver stays away.
import { decisionFor, SWITCH_VOICE } from '@/core/alerts/policy';
import { createDetectors } from '@/core/detectors';
import { limit, mph, seq, T0 } from '@/core/detectors/__fixtures__/rows';
import type { AlertEvent, TripSession } from '@/core/engine/engine.types';
import { createEngine, HANDLING_AFTER_PICKUP_MS, HANDLING_ALERT_MS, SWITCH_REPEAT_ALERT_MS } from '@/core/engine/machine';
import type { DetectorContext, FeatureRow } from '@/core/engine/types';

type Ctx = Omit<DetectorContext, 'warmupEndsAt'>;
const ANDROID: Ctx = { callActive: false, switchSignal: 'reliable', lockDelayMs: null, platform: 'android' };
const IOS: Ctx = { callActive: false, switchSignal: 'lagged', lockDelayMs: null, platform: 'ios' };

const v35 = { speed: mph(35) };
const front = { ...v35, appForeground: true, screenOn: true, locked: false } as const;
const away = { ...v35, appForeground: false, screenOn: true, locked: false } as const;
const locked = { ...v35, appForeground: false, screenOn: false, locked: true } as const;
const tapped = { handlingScore: 0.9, gravityStability: 0.95, orientationDelta: 0.05 };

/** Row i of a drive started at T0 (with a moving first reading, so no warm-up beyond the first trusted row). */
const START = T0;
const rel = (a: AlertEvent): number => (a.at - START) / 1000;

async function runDrive(rows: FeatureRow[], ctx: Ctx) {
  let n = 0;
  const alerts: AlertEvent[] = [];
  const finalized: Readonly<TripSession>[] = [];
  const engine = createEngine({
    now: () => START,
    newId: () => `id${(n += 1)}`,
    limits: { lookup: () => limit(mph(35)), prefetch: () => {} },
    createDetectors: () => createDetectors(() => `e${(n += 1)}`),
    ctx: () => ctx,
    onAlert: (a) => alerts.push(a),
    onCheckpoint: async () => {},
    onFinalize: async (s) => {
      finalized.push(s);
    },
  });
  // A restart: no warm-up, so the rows count from the first one.
  await engine.dispatch({ type: 'start', ts: START, continues: true });
  for (const r of rows) await engine.dispatch({ type: 'row', row: r });
  await engine.dispatch({ type: 'end', ts: rows.at(-1)!.ts + 1000 });
  const phone = alerts.filter((a) => a.type === 'phone_pickup' || a.type === 'phone_handling');
  return { alerts: phone, session: finalized[0]! };
}

/** Rows from T0 at 1 Hz. */
const rowsOf = seq;
const voiceOf = (a: AlertEvent) => decisionFor(a, { voiceEnabled: true }).voice;

test('the constants', () => {
  expect([HANDLING_ALERT_MS, HANDLING_AFTER_PICKUP_MS, SWITCH_REPEAT_ALERT_MS]).toEqual([15_000, 10_000, 60_000]);
  expect(SWITCH_VOICE).toBe('Back to RoadWise');
});

test('1. a motion pickup: the pickup alert, the handling alert 15 s after it began, "Phone down", once each', async () => {
  const { alerts } = await runDrive(rowsOf([10, front], [40, { ...front, ...tapped }], [10, front]), ANDROID);
  expect(alerts.map((a) => [a.type, rel(a), voiceOf(a), a.words])).toEqual([
    ['phone_pickup', 12, 'Phone down', undefined],
    ['phone_handling', 25, 'Phone down', undefined],
  ]);
});

test('2. an Android switch of 200 s: pickup at +2 s, handling at +15 s, then every 60 s, all "Back to RoadWise"', async () => {
  const { alerts } = await runDrive(rowsOf([10, front], [200, away], [10, front]), ANDROID);
  expect(alerts.map((a) => [a.type, rel(a) - 10])).toEqual([
    ['phone_pickup', 2],
    ['phone_handling', 15],
    ['phone_handling', 75],
    ['phone_handling', 135],
    ['phone_handling', 195],
  ]);
  for (const a of alerts) {
    expect(a.words).toBe('switch');
    expect(voiceOf(a)).toBe('Back to RoadWise');
    expect(decisionFor(a, { voiceEnabled: false }).voice).toBeUndefined();
  }
  // one id for the whole episode; each repeat is a new `at`
  expect(new Set(alerts.map((a) => a.id)).size).toBe(1);
});

test('3. an iPhone switch: pickup at +25 s (it counts at 26 s), handling at +35 s (10 s after the pickup alert), repeat at +95 s', async () => {
  const { alerts } = await runDrive(rowsOf([10, front], [100, away], [10, front]), IOS);
  expect(alerts.map((a) => [a.type, rel(a) - 10])).toEqual([
    ['phone_pickup', 25],
    ['phone_handling', 35],
    ['phone_handling', 95],
  ]);
});

test('4. a motion pickup, then an iPhone lock with RoadWise in front: one pickup alert, no handling alert, safe miles as if the phone were left alone', async () => {
  const pickup = [[10, front], [3, { ...front, ...tapped }]] as const;
  const lockAfter = await runDrive(rowsOf(...pickup, [10, away], [40, locked]), IOS);
  const leftAlone = await runDrive(rowsOf(...pickup, [10, { ...front, locked: true, screenOn: false }], [40, locked]), IOS);
  expect(lockAfter.alerts.map((a) => a.type)).toEqual(['phone_pickup']);
  expect(lockAfter.session.safeDistanceM).toBeCloseTo(leftAlone.session.safeDistanceM, 6);
  expect(lockAfter.session.events.map((e) => [e.type, e.durationS])).toEqual([['phone_pickup', 3]]);
});

test('5. an iPhone lock reported 15 s or 25 s late from RoadWise in front: no alert, nothing stored', async () => {
  for (const late of [15, 25]) {
    const { alerts, session } = await runDrive(rowsOf([10, front], [late, away], [40, locked]), IOS);
    expect(alerts).toEqual([]);
    expect(session.events).toEqual([]);
  }
});

test('5b. an iPhone switch of 20 s that ends back in RoadWise: no alert while away, one pickup alert on the return, "Phone down"; a pickup of 20 s and 5 s of handling', async () => {
  const { alerts, session } = await runDrive(rowsOf([10, front], [20, away], [10, front]), IOS);
  expect(alerts.map((a) => [a.type, rel(a), voiceOf(a)])).toEqual([['phone_pickup', 30, 'Phone down']]);
  expect(session.events.map((e) => [e.type, e.durationS])).toEqual([
    ['phone_pickup', 20],
    ['phone_handling', 5],
  ]);
});

test('6. a burst: one pickup alert on the third return, "Phone down", no handling alert', async () => {
  const { alerts, session } = await runDrive(rowsOf([10, front], [2, away], [3, front], [2, away], [3, front], [2, away], [10, front]), ANDROID);
  expect(alerts.map((a) => [a.type, rel(a), voiceOf(a)])).toEqual([['phone_pickup', 22, 'Phone down']]);
  expect(session.events.map((e) => [e.type, e.durationS])).toEqual([['phone_pickup', 12]]);
});

test('7. a switch joining a motion pickup: the pickup alert at the motion confirmation; the handling alert once use has lasted 15 s and 10 s after it', async () => {
  const { alerts } = await runDrive(rowsOf([10, front], [3, { ...front, ...tapped }], [30, away], [10, front]), ANDROID);
  expect(alerts.map((a) => [a.type, rel(a) - 10, a.words])).toEqual([
    ['phone_pickup', 2, undefined],
    ['phone_handling', 15, 'switch'],
  ]);
  const [pickupAlert, handlingAlert] = alerts;
  expect(handlingAlert!.at - pickupAlert!.at).toBeGreaterThanOrEqual(HANDLING_AFTER_PICKUP_MS);
});

test('8. the repeat stops once RoadWise is back', async () => {
  const { alerts } = await runDrive(rowsOf([10, front], [100, away], [200, front]), ANDROID);
  expect(alerts.map((a) => rel(a) - 10)).toEqual([2, 15, 75]);
});

test('a motion pickup whose phone is then held still adds no repeat (repeats are for switches only)', async () => {
  const { alerts } = await runDrive(rowsOf([10, front], [100, { ...front, ...tapped }], [10, front]), ANDROID);
  expect(alerts.map((a) => a.type)).toEqual(['phone_pickup', 'phone_handling']);
});

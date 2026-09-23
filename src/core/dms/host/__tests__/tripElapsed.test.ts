// Final review I-4: the fatigue long-trip amplifier reads `tripElapsedS`, which the controller computes from
// the drive's first row. It must count from the drive start (the gate's driveActive false → true edge), for
// the first drive and for every later one, whenever the engine was created.
import type { FeatureRow } from '@/core/engine/types';
import { createFakeDmsVision } from '../../../../../modules/dms-vision/src/fake';
import { EPOCH0 } from '../../replay/synth';
import { createDmsController, type DmsGateInputs } from '../controller';

const mockElapsed: number[] = [];
jest.mock('../../engine/engine', () => {
  const actual = jest.requireActual<typeof import('../../engine/engine')>('../../engine/engine');
  return {
    ...actual,
    createDmsEngine: (...a: Parameters<typeof actual.createDmsEngine>) => {
      const e = actual.createDmsEngine(...a);
      const push = e.pushRow.bind(e);
      e.pushRow = (row, ex, t) => {
        mockElapsed.push(ex.tripElapsedS);
        push(row, ex, t);
      };
      return e;
    },
  };
});

const GATE: DmsGateInputs = { optedIn: true, cameraBeta: true, ageBand: '18_plus', driveActive: true, mode: 'mounted', role: 'driver', appActive: true, driverSide: 'left', sensitivity: 'normal', alerts: 'live' };
const POWER = { batteryLevel: 80, charging: false, localMinutes: 720 };
const row = (ts: number): FeatureRow => ({
  ts,
  lat: 51.5,
  lng: -0.1,
  hAcc: 5,
  speed: 60 / 3.6,
  speedAcc: 0.5,
  course: 90,
  alt: 0,
  gnssValid: true,
  aLonMax: 0.1,
  aLonMin: -0.1,
  aLatMax: 0.1,
  aLatMin: -0.1,
  yawRateMax: 0.01,
  jerkMax: 0.1,
  gravityStability: 0.98,
  orientationDelta: 0.01,
  handlingScore: 0.02,
  locked: true,
  screenOn: true,
  appForeground: true,
});

function controller() {
  const fake = createFakeDmsVision({ epochAtZero: EPOCH0 });
  const ctl = createDmsController({ native: fake, onAlert: () => {}, onStatus: () => {}, profileStore: { load: async () => null, save: async () => {}, clear: async () => {} }, random: () => 'n' });
  return { fake, ctl };
}
/** Rows at 1 Hz over [fromS, toS), with the fake's clock kept in step (the heartbeat). */
async function rows(h: ReturnType<typeof controller>, fromS: number, toS: number) {
  for (let s = fromS; s < toS; s++) {
    const t = s * 1000;
    if (t > h.fake.now()) h.fake.advance(t - h.fake.now());
    h.ctl.pushRow(row(EPOCH0 + t), POWER);
    await h.ctl.idle();
  }
}

beforeEach(() => {
  mockElapsed.length = 0;
});

test('the gate opens before the first row: 2 h 1 min later, tripElapsedS is about 7260', async () => {
  const h = controller();
  h.ctl.setGate(GATE);
  await rows(h, 0, 7261);
  expect(mockElapsed.at(-1)!).toBeGreaterThan(7255);
  expect(mockElapsed.at(-1)!).toBeLessThan(7265);
});

test('a later drive, 3 h after the first ended: its first rows are near 0, not the gap between drives', async () => {
  const h = controller();
  h.ctl.setGate(GATE);
  await rows(h, 0, 60);
  await h.ctl.endDrive();
  mockElapsed.length = 0;
  h.ctl.setGate(GATE);
  await rows(h, 60 + 3 * 3600, 60 + 3 * 3600 + 5);
  expect(mockElapsed[0]!).toBeLessThan(2);
});

test('the gate opens 30 min into the drive: tripElapsedS counts from the drive’s first row', async () => {
  const h = controller();
  h.ctl.setGate({ ...GATE, appActive: false }); // the drive has started; the camera may not run yet
  await rows(h, 0, 1800);
  h.ctl.setGate(GATE);
  await rows(h, 1800, 1805);
  expect(mockElapsed.at(-1)!).toBeGreaterThan(1800);
  expect(mockElapsed.at(-1)!).toBeLessThan(1806);
});

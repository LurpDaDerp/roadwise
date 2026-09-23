// The host-owned native binding (security T14 m-1): M7 builds its controller with createDefaultDmsController,
// which binds the real DmsVision module inside host/**, so no file outside the host ever holds the raw
// wrapper (whose start takes a plain string). Here the wrapper is the fake.
import type { FeatureRow } from '@/core/engine/types';
import type { FakeDmsVision } from '../../../../../modules/dms-vision/src/fake';
import { createDefaultDmsController } from '../default';
import { createDefaultDmsController as fromIndex } from '../../index';

jest.mock('../../../../../modules/dms-vision', () => {
  const { createFakeDmsVision } = jest.requireActual<typeof import('../../../../../modules/dms-vision/src/fake')>('../../../../../modules/dms-vision/src/fake');
  return { __esModule: true, default: createFakeDmsVision() };
});
// eslint-disable-next-line @typescript-eslint/no-require-imports -- the mocked module's instance
const wrapper = (require('../../../../../modules/dms-vision') as { default: FakeDmsVision }).default;

const GATE = { optedIn: true, cameraBeta: true, ageBand: '18_plus', driveActive: true, mode: 'mounted', role: 'driver', appActive: true, driverSide: 'left', sensitivity: 'normal', alerts: 'live' } as const;
const row = (ts: number): FeatureRow => ({
  ts,
  lat: 0,
  lng: 0,
  hAcc: 5,
  speed: 60 / 3.6,
  speedAcc: 0.5,
  course: 0,
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

test('the default controller drives the real module (here mocked), and index exports it', async () => {
  expect(fromIndex).toBe(createDefaultDmsController);
  const ctl = createDefaultDmsController({ onAlert: () => {}, onStatus: () => {}, profileStore: { load: async () => null, save: async () => {}, clear: async () => {} }, random: () => 'nonce' });
  ctl.setGate(GATE);
  ctl.pushRow(row(1_700_000_000_000), { batteryLevel: 80, charging: false, localMinutes: 600 });
  await ctl.idle();
  expect(wrapper.calls.map((c) => c.method)).toContain('start');
  await ctl.dispose();
  expect(wrapper.nativeState()).toBe('stopped');
});

test('its deps have no native: the caller cannot hand it one', () => {
  const deps = { onAlert: () => {}, onStatus: () => {}, profileStore: { load: async () => null, save: async () => {}, clear: async () => {} } };
  // @ts-expect-error -- `native` is not a dep of the default controller
  createDefaultDmsController({ ...deps, native: wrapper });
  expect(true).toBe(true);
});

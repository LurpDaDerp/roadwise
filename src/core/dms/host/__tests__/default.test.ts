// The host-owned native binding (security T14 m-1): M7 builds its controller with createDefaultDmsController,
// which binds the real DmsVision module inside host/**, so no file outside the host ever holds the raw
// wrapper (whose start takes a plain string). Here the wrapper is the fake.
import type { FeatureRow } from '@/core/engine/types';
import type { FakeDmsVision } from '../../../../../modules/dms-vision/src/fake';
import { createDefaultDmsController, createDefaultShadowComparator } from '../default';
import { createDefaultDmsController as fromIndex } from '../../index';

jest.mock('../../../../../modules/dms-vision', () => {
  const { createFakeDmsVision } = jest.requireActual<typeof import('../../../../../modules/dms-vision/src/fake')>('../../../../../modules/dms-vision/src/fake');
  return { __esModule: true, default: createFakeDmsVision() };
});
// The comparator's binding (T16 r3 security m-2): capture what it is handed.
const mockShadowArgs: unknown[] = [];
jest.mock('../shadow', () => ({ createShadowComparator: (native: unknown, opts: unknown) => (mockShadowArgs.push(native, opts), { dispose: () => {} }) }));
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

describe('T15 r2 m1: one native owner at a time (the default controllers share one slot)', () => {
  const deps = () => ({ onAlert: () => {}, onStatus: () => {}, profileStore: { load: async () => null, save: async () => {}, clear: async () => {} }, random: () => 'nonce' });
  const power = { batteryLevel: 80, charging: false, localMinutes: 600 };
  test('the first opens; the second stays closed (busy) with zero native calls, and opens once the first is disposed', async () => {
    const a = createDefaultDmsController(deps());
    const b = createDefaultDmsController(deps());
    a.setGate(GATE);
    a.pushRow(row(1_700_000_010_000), power);
    await a.idle();
    const calls = wrapper.calls.length;
    const queries = wrapper.queries.length;
    b.setGate(GATE);
    b.pushRow(row(1_700_000_011_000), power);
    await b.idle();
    expect(wrapper.calls.length).toBe(calls);
    expect(wrapper.queries.length).toBe(queries);
    expect(b.status()).toMatchObject({ camera: 'off', reason: 'busy' });
    await a.dispose();
    const before = wrapper.calls.filter((c) => c.method === 'start').length;
    b.pushRow(row(1_700_000_012_000), power);
    await b.idle();
    expect(wrapper.calls.filter((c) => c.method === 'start').length).toBe(before + 1);
    await b.dispose();
  });
  test('a drive end releases the slot too', async () => {
    const a = createDefaultDmsController(deps());
    const b = createDefaultDmsController(deps());
    a.setGate(GATE);
    a.pushRow(row(1_700_000_020_000), power);
    await a.idle();
    await a.endDrive();
    b.setGate(GATE);
    b.pushRow(row(1_700_000_021_000), power);
    await b.idle();
    expect(b.status().reason).not.toBe('busy');
    await a.dispose();
    await b.dispose();
  });
});

test('T16 r3 security m-2: the shadow comparator is handed addListener alone, never the module', () => {
  const active = () => true;
  createDefaultShadowComparator({ active });
  const [native, opts] = mockShadowArgs.slice(-2) as [Record<string, unknown>, { active: () => boolean }];
  expect(Object.keys(native)).toEqual(['addListener']);
  expect(native).not.toBe(wrapper);
  expect(opts.active).toBe(active);
});

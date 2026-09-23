// The DMS diagnostics panel (plan Task 16, R-2): the real controller and the real gate on the fake native
// module. The panel fakes only the drive (its state, speed, the mounted mode and the driver role) and, until
// M7 builds consent, the opt-in; the remote flag and the age band are the stored ones. It never shows, logs
// or persists the GateToken, and it keeps no frame or landmark: the live view is counts and aggregates.
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react-native';
import { AppState } from 'react-native';

import { createSettingsRepo, type Db } from '@/data/db';
import { APP_CONFIG_KEY } from '@/data/config/appConfig';
import { createTestDb } from '@/data/queries/__fixtures__/harness';
import { DataProvider } from '@/data/queries/context';
import { ThemeProvider } from '@/ui';

import { createFakeDmsVision, type FakeDmsVision } from '../../../../modules/dms-vision/src/fake';
import { recordFromFeatures } from '../../../../modules/dms-vision/src/wire';
import { frame } from '../../../core/dms/engine/__fixtures__/synth';
import { featuresFromFrame } from '../../../core/dms/host/__fixtures__/records';
import { createDmsController as createHostController } from '../../../core/dms/host/controller';
import { createShadowComparator } from '../../../core/dms/host/shadow';
import { createDmsController, DMS_PROFILE_KEY, type DmsDefaultControllerDeps } from '@/core/dms';
import { DmsDiagnosticsPanel, DmsDiagnosticsScreen, dmsDiagCopy as copy } from '../DmsDiagnosticsPanel';

const mockSession: { profile: { id: string; age_band: string } | null } = { profile: { id: 'u1', age_band: '18_plus' } };
jest.mock('@/data/supabase/session', () => ({ useSession: () => mockSession }));
// The controller's nonce source (expo-crypto has no native side under Jest): a recognisable token per start.
let mockNonces = 0;
// Focus (T15 r2 security m-3): the screen's controller lives only while it is focused.
const mockFocus = { focused: true, listeners: new Set<() => void>() };
jest.mock('expo-router', () => {
  const R = jest.requireActual<typeof import('react')>('react');
  return {
    useFocusEffect: (cb: () => void | (() => void)) => {
      const [f, setF] = R.useState(mockFocus.focused);
      R.useEffect(() => {
        const l = () => setF(mockFocus.focused);
        mockFocus.listeners.add(l);
        return () => void mockFocus.listeners.delete(l);
      }, []);
      R.useEffect(() => (f ? cb() : undefined), [f, cb]);
    },
  };
});
async function setFocused(v: boolean) {
  await act(async () => {
    mockFocus.focused = v;
    mockFocus.listeners.forEach((l) => l());
    await flush();
  });
}
jest.mock('expo-crypto', () => ({ randomUUID: () => `gate-token-${++mockNonces}-6b1f0c` }));

const T0 = Date.UTC(2026, 8, 23, 9, 0, 0);

let db: Db;
let fake: FakeDmsVision;
let consoleCalls: unknown[][];
const spies: jest.SpyInstance[] = [];
const realAppState = Object.getOwnPropertyDescriptor(AppState, 'currentState');

beforeEach(async () => {
  jest.useFakeTimers({ now: T0 });
  db = await createTestDb();
  fake = createFakeDmsVision({ epochAtZero: T0 });
  mockSession.profile = { id: 'u1', age_band: '18_plus' };
  mockFocus.focused = true;
  // The app in the foreground (the gate reads AppState; jest's is not 'active', which the panel treats as closed).
  Object.defineProperty(AppState, 'currentState', { value: 'active', configurable: true, writable: true });
  consoleCalls = [];
  for (const m of ['log', 'info', 'warn', 'error', 'debug'] as const) {
    spies.push(jest.spyOn(console, m).mockImplementation((...a: unknown[]) => void consoleCalls.push(a)));
  }
});
afterEach(() => {
  if (realAppState !== undefined) Object.defineProperty(AppState, 'currentState', realAppState);
  for (const s of spies.splice(0)) s.mockRestore();
  jest.useRealTimers();
});

function wrap(node: React.ReactNode) {
  return (
    <ThemeProvider>
      <DataProvider db={db}>{node}</DataProvider>
    </ThemeProvider>
  );
}

/** Let the controller's queued native calls (permission read, engine creation, start) settle. */
async function flush() {
  for (let i = 0; i < 50; i++) await Promise.resolve();
}

/** Advance the wall clock (and the panel's 1 Hz row tick) by `s` seconds, the fake native clock with it. */
async function seconds(s: number, frames = false) {
  for (let i = 0; i < s; i++) {
    await act(async () => {
      if (frames) {
        for (let k = 0; k < 15; k++) {
          fake.advance(1000 / 15);
          fake.pushRecords([recordFromFeatures(featuresFromFrame({ ...frame({ tMs: fake.now() }), tMs: fake.now() }))]);
        }
      } else fake.advance(1000);
      jest.advanceTimersByTime(1000);
      await flush();
    });
  }
}

async function startDrive() {
  await fireEvent.press(screen.getByText(copy.optIn(false)));
  await fireEvent.press(screen.getByText(copy.startDrive));
  await seconds(3);
}

const startToken = () => {
  const start = fake.calls.find((c) => c.method === 'start');
  return (start?.args[0] as { gateToken: string } | undefined)?.gateToken ?? null;
};
/** The panel's controller on the fake native module (the route's default binds the real one). */
const mk = (deps: DmsDefaultControllerDeps) => createDmsController({ ...deps, native: fake });
/** The shadow comparator on the same fake (the route's default binds the real module). */
const mkCmp = () => createShadowComparator(fake);
const text = (id: string) => String(screen.getByTestId(id).props.children);

describe('the gate is the real one', () => {
  test('the stored flag off: the camera stays off (flag_off), and native is never called', async () => {
    await render(wrap(<DmsDiagnosticsPanel createController={mk} createComparator={mkCmp} cameraBeta={false} ageBand="18_plus" />));
    await startDrive();
    expect(text('dms-camera')).toBe('off');
    expect(text('dms-reason')).toBe('flag_off');
    expect(fake.calls).toEqual([]);
    expect(fake.queries).toEqual([]);
  });

  test('not opted in: off (not_opted_in), even with a drive', async () => {
    await render(wrap(<DmsDiagnosticsPanel createController={mk} createComparator={mkCmp} cameraBeta ageBand="18_plus" />));
    await fireEvent.press(screen.getByText(copy.startDrive));
    await seconds(3);
    expect(text('dms-reason')).toBe('not_opted_in');
    expect(fake.calls).toEqual([]);
  });

  test('an age band other than 18_plus: off (age)', async () => {
    await render(wrap(<DmsDiagnosticsPanel createController={mk} createComparator={mkCmp} cameraBeta ageBand="other" />));
    await startDrive();
    expect(text('dms-reason')).toBe('age');
    expect(fake.calls).toEqual([]);
  });

  test('every input holding: native starts, and the live view counts frames', async () => {
    await render(wrap(<DmsDiagnosticsPanel createController={mk} createComparator={mkCmp} cameraBeta ageBand="18_plus" />));
    await startDrive();
    expect(fake.calls.map((c) => c.method)).toContain('start');
    await seconds(3, true);
    await waitFor(() => expect(Number(text('dms-frames'))).toBeGreaterThan(0));
    expect(text('dms-camera')).toBe('active');
  });

  test('no drive: nothing starts until the simulated drive does', async () => {
    await render(wrap(<DmsDiagnosticsPanel createController={mk} createComparator={mkCmp} cameraBeta ageBand="18_plus" />));
    await fireEvent.press(screen.getByText(copy.optIn(false)));
    await seconds(3);
    // Before any drive the remote flag has not been latched (it is read at drive start), so the first
    // closing input the gate reports is the flag, not the drive.
    expect(text('dms-reason')).toBe('flag_off');
    expect(fake.calls).toEqual([]);
    expect(fake.queries).toEqual([]);
    await fireEvent.press(screen.getByText(copy.startDrive));
    await seconds(2);
    expect(fake.calls.map((c) => c.method)).toContain('start');
  });
});

describe('the drive ends', () => {
  test('End drive stops native and shows the summary as counts', async () => {
    await render(wrap(<DmsDiagnosticsPanel createController={mk} createComparator={mkCmp} cameraBeta ageBand="18_plus" />));
    await startDrive();
    await seconds(3, true);
    await fireEvent.press(screen.getByText(copy.endDrive));
    await waitFor(() => expect(screen.getByTestId('dms-summary')).toBeTruthy());
    expect(fake.calls.map((c) => c.method)).toContain('stop');
    expect(fake.nativeState()).toBe('stopped');
  });

  test('leaving the screen disposes the controller: native stops', async () => {
    const view = await render(wrap(<DmsDiagnosticsPanel createController={mk} createComparator={mkCmp} cameraBeta ageBand="18_plus" />));
    await startDrive();
    await view.unmount();
    await waitFor(() => expect(fake.nativeState()).toBe('stopped'));
  });
});

describe('privacy: the GateToken, frames and landmarks', () => {
  test('the token is never shown, logged or persisted', async () => {
    const view = await render(wrap(<DmsDiagnosticsPanel createController={mk} createComparator={mkCmp} cameraBeta ageBand="18_plus" />));
    await startDrive();
    await seconds(3, true);
    const token = startToken();
    expect(token).not.toBeNull();
    expect(JSON.stringify(view.toJSON())).not.toContain(token!);
    expect(JSON.stringify(consoleCalls)).not.toContain(token!);
    await fireEvent.press(screen.getByText(copy.endDrive));
    const { rows } = await db.execute('SELECT * FROM settings');
    expect(JSON.stringify(rows)).not.toContain(token!);
  });

  test('nothing is logged at all, and nothing is persisted (not even the calibration profile)', async () => {
    await render(wrap(<DmsDiagnosticsPanel createController={mk} createComparator={mkCmp} cameraBeta ageBand="18_plus" />));
    await startDrive();
    await seconds(5, true);
    await fireEvent.press(screen.getByText(copy.endDrive));
    expect(consoleCalls).toEqual([]);
    expect(await createSettingsRepo(db).get(DMS_PROFILE_KEY)).toBeNull();
  });

  test('the live view is counts and states only: no coordinate, landmark or frame value is rendered', async () => {
    const view = await render(wrap(<DmsDiagnosticsPanel createController={mk} createComparator={mkCmp} cameraBeta ageBand="18_plus" />));
    await startDrive();
    await seconds(3, true);
    const shown = JSON.stringify(view.toJSON());
    // A frame's head angles and eye openness (featuresFromFrame of the synth frame) are never printed.
    for (const field of ['yaw', 'pitch', 'roll', 'ear', 'landmark', 'gazeX', 'gazeY']) expect(shown.toLowerCase()).not.toContain(`"${field}`);
    expect(screen.getAllByTestId(/^dms-/).map((n) => n.props.testID).sort()).toEqual([...copy.liveFields.map((f) => `dms-${f}`), ...copy.cmpFields.map((f) => `dms-cmp-${f}`)].sort());
  });
});

describe('the screen reads the real gate inputs', () => {
  test('the stored camera_beta flag and the signed-in age band', async () => {
    await createSettingsRepo(db).set(APP_CONFIG_KEY, { flags: { camera_beta: true } });
    await render(wrap(<DmsDiagnosticsScreen createController={mk} createComparator={mkCmp} />));
    await waitFor(() => expect(screen.getByText(copy.optIn(false))).toBeTruthy());
    await act(async () => {
      await Promise.resolve();
    });
    await startDrive();
    expect(fake.calls.map((c) => c.method)).toContain('start');
  });

  test('no stored flag: flag_off (the compiled default)', async () => {
    await render(wrap(<DmsDiagnosticsScreen createController={mk} createComparator={mkCmp} />));
    await startDrive();
    expect(text('dms-reason')).toBe('flag_off');
    expect(fake.calls).toEqual([]);
  });

  test('a u13 or unknown age band: age', async () => {
    await createSettingsRepo(db).set(APP_CONFIG_KEY, { flags: { camera_beta: true } });
    mockSession.profile = { id: 'u1', age_band: 'u13' };
    await render(wrap(<DmsDiagnosticsScreen createController={mk} createComparator={mkCmp} />));
    await startDrive();
    expect(text('dms-reason')).toBe('age');
    mockSession.profile = null;
    expect(fake.calls).toEqual([]);
  });
});

describe('T15 r2: the camera runs only while the screen is focused (security m-3), and one native owner (seat m1)', () => {
  test('blur ends the simulated drive and disposes the controller: native stops; focus again starts nothing by itself', async () => {
    await render(wrap(<DmsDiagnosticsPanel createController={mk} createComparator={mkCmp} cameraBeta ageBand="18_plus" />));
    await startDrive();
    expect(fake.nativeState()).toBe('running');
    await setFocused(false);
    expect(fake.nativeState()).toBe('stopped');
    const n = fake.calls.length;
    await seconds(3);
    expect(fake.calls.length).toBe(n); // no rows, no heartbeat, no restart while covered
    await setFocused(true);
    await seconds(3);
    expect(fake.calls.filter((c) => c.method === 'start')).toHaveLength(1);
    expect(screen.getByText(copy.startDrive)).toBeTruthy(); // the drive ended with the blur
  });
  test('another controller holds the native module: the panel says so and never calls native', async () => {
    const held = (deps: DmsDefaultControllerDeps) => createHostController({ ...deps, native: fake, owner: { acquire: () => false, release: () => {} } });
    await render(wrap(<DmsDiagnosticsPanel createController={held} createComparator={mkCmp} cameraBeta ageBand="18_plus" />));
    await startDrive();
    expect(text('dms-reason')).toBe('busy');
    expect(screen.getByText(copy.busy)).toBeTruthy();
    expect(fake.calls).toEqual([]);
    expect(fake.queries).toEqual([]);
  });
});

describe('T16: the geometric and net gaze side by side, and the shadow counts per source', () => {
  test('both columns and the agreement are shown as counts and aggregates only', async () => {
    fake = createFakeDmsVision({ epochAtZero: T0, gazeNetAvailable: true });
    await render(wrap(<DmsDiagnosticsPanel createController={mk} createComparator={mkCmp} cameraBeta ageBand="18_plus" />));
    await startDrive();
    await seconds(5, true);
    for (const f of copy.cmpFields) {
      // numbers, rates, percentages or a dash: never a name, an angle series or a frame value
      expect(text(`dms-cmp-${f}`)).toMatch(/^[\d.\s/%°h·()—-]*$/);
    }
    expect(Number(text('dms-cmp-geoFrames'))).toBeGreaterThan(0);
  });
  test('the comparator stops listening when the screen blurs', async () => {
    const made: ReturnType<typeof createShadowComparator>[] = [];
    const tracked = () => {
      const c = createShadowComparator(fake);
      made.push(c);
      return c;
    };
    await render(wrap(<DmsDiagnosticsPanel createController={mk} createComparator={tracked} cameraBeta ageBand="18_plus" />));
    await startDrive();
    await seconds(3, true);
    expect(made).toHaveLength(1);
    expect(made[0]!.stats().rows).toBeGreaterThanOrEqual(3); // the simulated drive's rows reach both shadow engines
    const before = made[0]!.stats().geometric.frames;
    expect(before).toBeGreaterThan(0);
    await setFocused(false);
    expect(fake.nativeState()).toBe('stopped');
    // Whatever runs native next (here the test itself), the blurred screen's comparator hears none of it.
    await act(async () => {
      await fake.start({ gateToken: 'other', fps: 15, gazeNet: false, gazeNetEvery: 1, delegate: 'cpu', rotationOffsetDegrees: 0 });
      for (let k = 0; k < 15; k++) {
        fake.advance(1000 / 15);
        fake.pushRecords([recordFromFeatures(featuresFromFrame({ ...frame({ tMs: fake.now() }), tMs: fake.now() }))]);
      }
    });
    expect(made[0]!.stats().geometric.frames).toBe(before);
  });
});

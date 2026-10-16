/**
 * The DashPal screens: Settings › DashPal (every status and its fix, the controls, Add another
 * phone with its one-time code, the new-phone notice, forget), the setup panel (busy refusal, the
 * code step, the Pair screen, replace, every outcome), the onboarding step (never asks for Bluetooth
 * or the camera until "Find my DashPal"), the prompt host and the label link's deferral.
 */
import { act, fireEvent, screen, waitFor } from '@testing-library/react-native';

import { appWorld, clearQueryClients, fakeAdapter, tap } from '@/features/permissions/__fixtures__/harness';
import { SETTINGS_HREFS } from '@/features/settings/routes';

import { createFakeDashcamRuntime, PAIRED } from '../__fixtures__/fakeRuntime';
import { dashpalCopy } from '../copy';
import { drawOnceCode, formatCode } from '../label';
import { setActiveDashcam } from '../registry';
import { createDashpalSecrets } from '../secure';
import type { SetupDeps, SetupFlow, SetupPhase } from '../setup';

jest.mock('expo-camera', () => {
  const { View } = jest.requireActual<typeof import('react-native')>('react-native');
  return {
    CameraView: (props: object) => <View {...props} />,
    useCameraPermissions: () => [mockCamera.permission, mockCamera.request],
  };
});
const mockCamera = {
  permission: { granted: true, canAskAgain: true, status: 'granted' } as { granted: boolean; canAskAgain: boolean; status: string } | null,
  request: jest.fn(async () => {}),
};
jest.mock('expo-constants', () => ({ __esModule: true, default: { expoConfig: { extra: { linkDomain: 'pair.example.com' } } } }));

function memSecrets() {
  const store = new Map<string, string>();
  return {
    store,
    secrets: createDashpalSecrets(() => ({
      getItemAsync: async (k: string) => store.get(k) ?? null,
      setItemAsync: async (k: string, v: string) => void store.set(k, v),
      deleteItemAsync: async (k: string) => void store.delete(k),
    })),
  };
}

const mockRouter = { push: jest.fn(), replace: jest.fn(), back: jest.fn(), canGoBack: () => true };
let mockPath = '/home';
jest.mock('expo-router', () => ({
  useRouter: () => mockRouter,
  usePathname: () => mockPath,
  useFocusEffect: () => {},
}));
const mockDrive = { busy: false, listeners: new Set<(s: { status: string }) => void>() };
const mockHost = {
  isBusy: () => mockDrive.busy,
  subscribe: (fn: (s: { status: string }) => void) => {
    mockDrive.listeners.add(fn);
    return () => void mockDrive.listeners.delete(fn);
  },
};
jest.mock('@/drive/useDrive', () => ({
  useDrive: (select: (s: { status: string }) => unknown) => select({ status: mockDrive.busy ? 'recording' : 'idle' }),
  useDriveHost: () => mockHost,
}));
jest.mock('@/data/supabase/client', () => ({ supabase: {} }));
jest.mock('@/data/supabase/session', () => ({ useSession: () => ({ session: null, profile: null }) }));

// Imported after the mocks.
/* eslint-disable import/first */
import { DashcamScreen } from '@/features/settings/DashcamScreen';
import { DashcamStep } from '@/features/onboarding/steps/DashcamStep';
import { SetupPanel } from '../ui/SetupScreen';
import { DashpalLink } from '../ui/DashpalLink';
import { PENDING_SETUP_KEY, setupHref } from '../ui/links';
/* eslint-enable import/first */

beforeEach(() => {
  mockRouter.push.mockClear();
  mockRouter.replace.mockClear();
  mockDrive.busy = false;
  mockPath = '/home';
  mockCamera.permission = { granted: true, canAskAgain: true, status: 'granted' };
  mockCamera.request.mockClear();
});
afterEach(async () => {
  await act(async () => setActiveDashcam(null));
  clearQueryClients();
});

/** A scripted setup flow: the test moves its phase and sees the answers. */
function scriptedFlow() {
  const listeners = new Set<(p: SetupPhase) => void>();
  let phase: SetupPhase = { kind: 'idle' };
  const answers: string[] = [];
  const starts: unknown[] = [];
  let started = 0;
  let cancelled = 0;
  const flow: SetupFlow = {
    phase: () => phase,
    subscribe: (fn) => {
      listeners.add(fn);
      return () => void listeners.delete(fn);
    },
    start: async (opts) => {
      started += 1;
      starts.push(opts ?? {});
    },
    scanned: (text) => void answers.push(`scanned:${text}`),
    submitCode: (text, name) => void answers.push(`typed:${text}:${name ?? ''}`),
    confirm: () => void answers.push('confirm'),
    confirmReplace: () => void answers.push('replace'),
    cancel: async () => void (cancelled += 1),
  };
  const bases: SetupDeps[] = [];
  return {
    // A new flow object per make, as the real factory does (a retry is a new flow).
    make: (base: SetupDeps) => {
      bases.push(base);
      return { ...flow };
    },
    bases,
    answers,
    starts,
    started: () => started,
    cancelled: () => cancelled,
    to: (p: SetupPhase) =>
      act(async () => {
        phase = p;
        for (const fn of [...listeners]) fn(p);
      }),
  };
}

describe('Settings › DashPal', () => {
  it('unpaired: what DashPal is, and Set up', async () => {
    setActiveDashcam(createFakeDashcamRuntime());
    const w = await appWorld();
    await w.render(<DashcamScreen deps={{ adapter: fakeAdapter() }} />);
    expect(await screen.findByTestId('dashcam-intro')).toHaveTextContent(dashpalCopy.screen.intro);
    await tap('dashcam-setup');
    expect(mockRouter.push).toHaveBeenCalledWith(SETTINGS_HREFS.dashcamSetup);
  });

  it.each([
    ['connected', { state: 3 }, 'Connected · Monitoring', null],
    ['connected', { state: 2 }, 'Connected · Calibrating', null],
    ['connecting', null, 'Not in range', dashpalCopy.screen.fix.notInRange],
    ['bluetooth_off', null, 'Bluetooth is off', dashpalCopy.screen.fix.bluetoothOff],
    ['unauthorized', null, 'Bluetooth not allowed', dashpalCopy.screen.fix.notAllowed],
    ['needs_repair', null, 'Needs pairing again', dashpalCopy.screen.fix.needsRepair],
    ['unverified', null, 'Can’t verify DashPal', dashpalCopy.screen.fix.unverified],
  ] as const)('%s → "%s" with its fix', async (lifecycle, status, label, fix) => {
    setActiveDashcam(
      createFakeDashcamRuntime({
        link: { lifecycle, paired: PAIRED, repairCause: lifecycle === 'needs_repair' ? 'unknown_phone' : null, status: status ? { state: status.state, flags: 0, fpsX10: 200, tempC: 40, bondCount: 1, at: 1 } : null },
      })
    );
    const w = await appWorld();
    await w.render(<DashcamScreen deps={{ adapter: fakeAdapter() }} />);
    expect(await screen.findByTestId('dashcam-status')).toHaveTextContent(label);
    if (fix) expect(screen.getByTestId('dashcam-fix')).toHaveTextContent(fix);
    else expect(screen.queryByTestId('dashcam-fix')).toBeNull();
  });

  it('an older firmware answering: "Update DashPal" with its fix', async () => {
    setActiveDashcam(createFakeDashcamRuntime({ link: { lifecycle: 'needs_repair', repairCause: 'downgrade', paired: PAIRED } }));
    const w = await appWorld();
    await w.render(<DashcamScreen deps={{ adapter: fakeAdapter() }} />);
    expect(await screen.findByTestId('dashcam-status')).toHaveTextContent('Update DashPal');
    expect(screen.getByTestId('dashcam-fix')).toHaveTextContent(dashpalCopy.screen.fix.downgrade);
    expect(screen.queryByTestId('dashcam-repair')).toBeNull();
  });

  it('not allowed opens Settings; needs pairing again and can’t verify set up again (with the stored code)', async () => {
    const adapter = fakeAdapter();
    const rt = createFakeDashcamRuntime({ link: { lifecycle: 'unauthorized', paired: PAIRED } });
    setActiveDashcam(rt);
    const w = await appWorld();
    await w.render(<DashcamScreen deps={{ adapter }} />);
    await tap('dashcam-open-settings');
    expect(adapter.log).toContain('openAppSettings');
    await act(async () => rt.set({ link: { lifecycle: 'needs_repair', repairCause: 'unknown_phone' } }));
    expect(screen.getByTestId('dashcam-fix')).toHaveTextContent(dashpalCopy.screen.fix.needsRepair);
    await tap('dashcam-repair');
    expect(mockRouter.push).toHaveBeenLastCalledWith(setupHref({ again: true }));
    await act(async () => rt.set({ link: { lifecycle: 'unverified', repairCause: null } }));
    await tap('dashcam-repair');
    expect(mockRouter.push).toHaveBeenLastCalledWith('/settings/dashcam-setup?again=1');
  });

  it('connected: also beep, test sound, recalibrate, forget (no OS step to finish, on either phone)', async () => {
    const rt = createFakeDashcamRuntime({ link: { lifecycle: 'connected', paired: PAIRED, status: { state: 3, flags: 0, fpsX10: 200, tempC: 40, bondCount: 1, at: 1 } } });
    setActiveDashcam(rt);
    const w = await appWorld();
    await w.render(<DashcamScreen deps={{ adapter: fakeAdapter() }} />);
    await act(async () => {
      fireEvent(await screen.findByTestId('dashcam-buzzer-too'), 'valueChange', true);
    });
    await tap('dashcam-test');
    await tap('dashcam-recalibrate');
    await tap('dashcam-forget');
    await tap('dashcam-forget-confirm');
    expect(rt.log).toEqual(['buzzerToo:true', 'command:6:1', 'command:2:0', 'forget']);
    expect(screen.queryByTestId('dashcam-notice')).toBeNull();
  });

  it('Add another phone: a sheet with the one-time code’s QR code, the 2:00 countdown and Show code; never the label code; closing it wipes the code', async () => {
    const rt = createFakeDashcamRuntime({ link: { lifecycle: 'connected', paired: PAIRED, status: { state: 3, flags: 0, fpsX10: 200, tempC: 40, bondCount: 1, at: 1 } } });
    const code = drawOnceCode();
    const text = formatCode(code.S, 'once');
    rt.addPhoneResult = code;
    setActiveDashcam(rt);
    let t = 50_000;
    const w = await appWorld();
    await w.render(<DashcamScreen deps={{ adapter: fakeAdapter(), now: () => t }} />);
    await tap('dashcam-add-phone');
    expect(rt.log).toEqual(['addPhone']);
    expect(await screen.findByTestId('add-phone-qr')).toBeOnTheScreen();
    expect(screen.getByTestId('add-phone-left')).toHaveTextContent(dashpalCopy.screen.addPhoneSheet.left('2:00'));
    expect(screen.queryByTestId('add-phone-code')).toBeNull();
    await tap('add-phone-show-code');
    expect(screen.getByTestId('add-phone-code')).toHaveTextContent(text);
    t += 1000;
    await tap('add-phone-done');
    expect(code.S.every((b) => b === 0)).toBe(true);
    expect(screen.queryByTestId('add-phone-qr')).toBeNull();
  });

  it('Add another phone needs the link: disabled and saying so while not connected; a refused send says it did not reach', async () => {
    const rt = createFakeDashcamRuntime({ link: { lifecycle: 'connecting', paired: PAIRED } });
    setActiveDashcam(rt);
    const w = await appWorld();
    await w.render(<DashcamScreen deps={{ adapter: fakeAdapter() }} />);
    expect(await screen.findByTestId('dashcam-add-phone-needs-link')).toHaveTextContent(dashpalCopy.screen.addPhoneNeedsLink);
    await tap('dashcam-add-phone');
    expect(rt.log).toEqual([]);
    await act(async () => rt.set({ link: { lifecycle: 'connected' } }));
    expect(screen.queryByTestId('dashcam-add-phone-needs-link')).toBeNull();
    await tap('dashcam-add-phone');
    expect(rt.log).toEqual(['addPhone']);
    expect(screen.getByTestId('dashcam-notice')).toHaveTextContent(dashpalCopy.screen.commandFailed, { exact: false });
  });

  it('a phone this phone did not add: the one-time notice under the count until OK', async () => {
    const rt = createFakeDashcamRuntime({ newPhone: true, link: { lifecycle: 'connected', paired: PAIRED, status: { state: 3, flags: 0, fpsX10: 200, tempC: 40, bondCount: 2, at: 1 } } });
    setActiveDashcam(rt);
    const w = await appWorld();
    await w.render(<DashcamScreen deps={{ adapter: fakeAdapter() }} />);
    expect(await screen.findByTestId('dashcam-new-phone')).toHaveTextContent(dashpalCopy.screen.newPhone, { exact: false });
    await tap('dashcam-new-phone-ok');
    expect(rt.log).toContain('dismissNewPhone');
    expect(screen.queryByTestId('dashcam-new-phone')).toBeNull();
  });

  it('connected: "Phones paired: N" from STATUS; from 2 phones, how to remove one; nothing while not connected or before STATUS', async () => {
    const status = (bondCount: number) => ({ state: 3, flags: 0, fpsX10: 200, tempC: 40, bondCount, at: 1 });
    const rt = createFakeDashcamRuntime({ link: { lifecycle: 'connected', paired: PAIRED, status: status(1) } });
    setActiveDashcam(rt);
    const w = await appWorld();
    await w.render(<DashcamScreen deps={{ adapter: fakeAdapter() }} />);
    expect(await screen.findByTestId('dashcam-phones')).toHaveTextContent('Phones paired: 1');
    expect(screen.queryByTestId('dashcam-phones-help')).toBeNull();
    await act(async () => rt.set({ link: { lifecycle: 'connected', status: status(2) } }));
    expect(screen.getByTestId('dashcam-phones')).toHaveTextContent('Phones paired: 2');
    expect(screen.getByTestId('dashcam-phones-help')).toHaveTextContent(dashpalCopy.screen.phonesPairedHelp);
    await act(async () => rt.set({ link: { lifecycle: 'connecting', status: status(2) } }));
    expect(screen.queryByTestId('dashcam-phones')).toBeNull();
    await act(async () => rt.set({ link: { lifecycle: 'connected', status: null } }));
    expect(screen.queryByTestId('dashcam-phones')).toBeNull();
  });

  it('commands while not connected say so and send nothing; a failed one says it did not reach', async () => {
    const rt = createFakeDashcamRuntime({ link: { lifecycle: 'connecting', paired: PAIRED } });
    setActiveDashcam(rt);
    const w = await appWorld();
    await w.render(<DashcamScreen deps={{ adapter: fakeAdapter() }} />);
    await tap('dashcam-test');
    expect(screen.getByTestId('dashcam-notice')).toHaveTextContent(dashpalCopy.screen.notConnected, { exact: false });
    expect(rt.log).toEqual([]);
    await act(async () => rt.set({ link: { lifecycle: 'connected' } }));
    rt.commandResult = false;
    await tap('dashcam-recalibrate');
    expect(screen.getByTestId('dashcam-notice')).toHaveTextContent(dashpalCopy.screen.commandFailed, { exact: false });
  });
});

describe('Home: the new-phone card', () => {
  it('shows while the notice waits (a DashPal paired), OK dismisses it; hidden during a drive or without the notice', async () => {
    // eslint-disable-next-line @typescript-eslint/no-require-imports -- after the mocks above
    const { NewPhoneCard } = require('../ui/NewPhoneCard') as typeof import('../ui/NewPhoneCard');
    const rt = createFakeDashcamRuntime({ newPhone: true, link: { lifecycle: 'connected', paired: PAIRED } });
    setActiveDashcam(rt);
    const w = await appWorld();
    await w.render(<NewPhoneCard />);
    expect(await screen.findByTestId('home-dashpal-new-phone')).toHaveTextContent(dashpalCopy.screen.newPhone, { exact: false });
    await tap('home-dashpal-new-phone-ok');
    expect(rt.log).toContain('dismissNewPhone');
    expect(screen.queryByTestId('home-dashpal-new-phone')).toBeNull();
  });

  it.each([
    ['during a drive', { newPhone: true, link: { lifecycle: 'connected' as const, paired: PAIRED } }, true],
    ['with no DashPal paired', { newPhone: true, link: { lifecycle: 'unpaired' as const, paired: null } }, false],
    ['with no notice waiting', { newPhone: false, link: { lifecycle: 'connected' as const, paired: PAIRED } }, false],
  ])('nothing %s', async (_name, state, hidden) => {
    // eslint-disable-next-line @typescript-eslint/no-require-imports -- after the mocks above
    const { NewPhoneCard } = require('../ui/NewPhoneCard') as typeof import('../ui/NewPhoneCard');
    setActiveDashcam(createFakeDashcamRuntime(state));
    const w = await appWorld();
    await w.render(<NewPhoneCard hidden={hidden} />);
    expect(screen.queryByTestId('home-dashpal-new-phone')).toBeNull();
  });
});

describe('the setup panel', () => {
  const panel = (s: ReturnType<typeof scriptedFlow>, target: object = {}, platform: 'ios' | 'android' = 'ios') => (
    <SetupPanel target={target} deps={{ adapter: fakeAdapter(), platform, flow: s.make, secrets: memSecrets().secrets }} onClose={() => {}} />
  );

  it('a drive open → "Finish your drive first" (the flow refuses; the panel shows it)', async () => {
    setActiveDashcam(createFakeDashcamRuntime());
    const s = scriptedFlow();
    const w = await appWorld();
    await w.render(panel(s));
    await s.to({ kind: 'busy' });
    expect(screen.getByTestId('setup-phase-busy')).toHaveTextContent(dashpalCopy.setup.busy);
  });

  it('the flow gets the live busy read, the runtime, the target (found, link, again); cancel on unmount', async () => {
    const rt = createFakeDashcamRuntime();
    setActiveDashcam(rt);
    const s = scriptedFlow();
    const w = await appWorld();
    const view = await w.render(panel(s, { found: 'PERIPH-9', link: 'a4cf12b3c4d5', again: true }, 'android'));
    expect(s.started()).toBe(1);
    expect(s.starts[0]).toEqual({ preferId: 'PERIPH-9', fromLink: { dashcamId: 'a4cf12b3c4d5' }, again: true });
    const base = s.bases[0]!;
    mockDrive.busy = true;
    expect(base.isBusy()).toBe(false); // the setup screens read the drive context, not the mocked hooks
    base.notePhones?.('a4cf12b3c4d5', 2);
    expect(rt.log).toContain('notePhones:a4cf12b3c4d5:2');
    await act(async () => view.unmount());
    expect(s.cancelled()).toBe(1);
  });

  it('the code step: the camera (QR only) hands every code to the flow; a refused one says so; Type the code instead; the lost-phone line', async () => {
    setActiveDashcam(createFakeDashcamRuntime());
    const s = scriptedFlow();
    const w = await appWorld();
    await w.render(panel(s));
    await s.to({ kind: 'code', error: null, noStoredCode: false, preferred: null });
    const camera = screen.getByTestId('setup-camera');
    expect(camera.props.barcodeScannerSettings).toEqual({ barcodeTypes: ['qr'] });
    await act(async () => camera.props.onBarcodeScanned({ data: 'roadwise://add/someone' }));
    expect(s.answers).toEqual(['scanned:roadwise://add/someone']);
    await s.to({ kind: 'code', error: 'not_a_code', noStoredCode: false, preferred: null });
    expect(screen.getByTestId('setup-rejected-not_a_code')).toHaveTextContent(dashpalCopy.setup.notACode, { exact: false });
    expect(screen.getByTestId('setup-lost-phone')).toHaveTextContent(dashpalCopy.setup.lostPhone);
    await tap('setup-type-instead');
    await act(async () => {
      screen.getByTestId('setup-code-input').props.onChangeText('000G-40R4-0M30-E209-185G-R38E-1W60');
      screen.getByTestId('setup-name-input').props.onChangeText('c4d5');
    });
    await tap('setup-code-submit');
    expect(s.answers.at(-1)).toBe('typed:000G-40R4-0M30-E209-185G-R38E-1W60:c4d5');
    await s.to({ kind: 'code', error: 'bad_code', noStoredCode: false, preferred: null });
    expect(screen.getByTestId('setup-rejected-bad_code')).toHaveTextContent(dashpalCopy.setup.badCode, { exact: false });
    await tap('setup-scan-instead');
    expect(screen.getByTestId('setup-camera')).toBeOnTheScreen();
  });

  it('the camera not allowed: the line to allow it, Open Settings when the phone cannot ask again; typing still works', async () => {
    setActiveDashcam(createFakeDashcamRuntime());
    mockCamera.permission = { granted: false, canAskAgain: false, status: 'denied' };
    const adapter = fakeAdapter();
    const s = scriptedFlow();
    const w = await appWorld();
    await w.render(<SetupPanel deps={{ adapter, platform: 'ios', flow: s.make, secrets: memSecrets().secrets }} onClose={() => {}} />);
    await s.to({ kind: 'code', error: null, noStoredCode: false, preferred: null });
    expect(screen.getByTestId('setup-camera-denied')).toHaveTextContent(dashpalCopy.setup.cameraDenied, { exact: false });
    await tap('setup-camera-settings');
    expect(adapter.log).toContain('openAppSettings');
    expect(mockCamera.request).not.toHaveBeenCalled();
    await tap('setup-type-instead');
    expect(screen.getByTestId('setup-code-input')).toBeOnTheScreen();
  });

  it('the camera never asked yet: asked once when the scanner opens', async () => {
    setActiveDashcam(createFakeDashcamRuntime());
    mockCamera.permission = { granted: false, canAskAgain: true, status: 'undetermined' };
    const s = scriptedFlow();
    const w = await appWorld();
    await w.render(panel(s));
    await s.to({ kind: 'code', error: null, noStoredCode: false, preferred: null });
    expect(mockCamera.request).toHaveBeenCalledTimes(1);
  });

  it('Set up again with no stored code says to scan the label or use Add another phone', async () => {
    setActiveDashcam(createFakeDashcamRuntime());
    const s = scriptedFlow();
    const w = await appWorld();
    await w.render(panel(s));
    await s.to({ kind: 'code', error: null, noStoredCode: true, preferred: null });
    expect(screen.getByTestId('setup-no-stored-code')).toHaveTextContent(dashpalCopy.setup.noStoredCode, { exact: false });
  });

  it('a link: "Set up DashPal-XXXX" with Pair; a different DashPal: Replace … with …?', async () => {
    setActiveDashcam(createFakeDashcamRuntime());
    const s = scriptedFlow();
    const w = await appWorld();
    await w.render(panel(s));
    await s.to({ kind: 'confirm_link', name: 'DashPal-C4D5' });
    expect(screen.getByTestId('setup-phase-confirm_link')).toHaveTextContent('Set up DashPal-C4D5');
    await tap('setup-pair');
    await s.to({ kind: 'confirm_replace', from: 'DashPal-AAAA', to: 'DashPal-C4D5' });
    expect(screen.getByTestId('setup-phase-confirm_replace')).toHaveTextContent('Replace DashPal-AAAA with DashPal-C4D5?');
    expect(screen.getByTestId('setup-extra')).toHaveTextContent('Your phone stops connecting to DashPal-AAAA.');
    await tap('setup-replace');
    expect(s.answers).toEqual(['confirm', 'replace']);
  });

  it.each([
    [{ kind: 'searching', name: 'DashPal-C4D5', again: false }, 'Looking for DashPal-C4D5…'],
    [{ kind: 'searching', name: null, again: false }, 'Looking for your DashPal…'],
    [{ kind: 'connecting', name: 'DashPal-C4D5', again: false }, 'Connecting to DashPal-C4D5…'],
    [{ kind: 'connecting', name: 'DashPal-C4D5', again: true }, 'Setting up DashPal-C4D5 again…'],
    [{ kind: 'pairing', name: 'DashPal-C4D5', again: false }, 'Pairing…'],
    [{ kind: 'press_button', name: 'DashPal-C4D5', until: 1 }, 'Press the DashPal’s button 5 times.'],
    [{ kind: 'waiting_busy', name: 'DashPal-C4D5', until: 1 }, 'Another phone is setting up this DashPal. Waiting…'],
  ] as const)('%o says "%s", with Cancel', async (phase, text) => {
    setActiveDashcam(createFakeDashcamRuntime());
    const s = scriptedFlow();
    const w = await appWorld();
    await w.render(panel(s));
    await s.to(phase as SetupPhase);
    expect(screen.getByTestId(`setup-phase-${phase.kind}`)).toHaveTextContent(text);
    expect(screen.getByTestId('setup-cancel')).toBeOnTheScreen();
  });

  it('done: one phone says nothing more; 2 or more says how many and "Not all yours?"', async () => {
    setActiveDashcam(createFakeDashcamRuntime());
    const s = scriptedFlow();
    const w = await appWorld();
    await w.render(panel(s));
    await s.to({ kind: 'done', paired: PAIRED, phones: 1, notAllYours: false });
    expect(screen.getByTestId('setup-phase-done')).toHaveTextContent('Connected to DashPal-C4D5.');
    expect(screen.queryByTestId('setup-phones')).toBeNull();
    expect(screen.queryByTestId('setup-not-all-yours')).toBeNull();
    await s.to({ kind: 'done', paired: PAIRED, phones: null, notAllYours: false });
    expect(screen.queryByTestId('setup-phones')).toBeNull();
    await s.to({ kind: 'done', paired: PAIRED, phones: 3, notAllYours: true });
    expect(screen.getByTestId('setup-phones')).toHaveTextContent('3 phones are paired with this DashPal.');
    expect(screen.getByTestId('setup-not-all-yours')).toHaveTextContent(dashpalCopy.setup.notAllYours, { exact: false });
  });

  it.each([
    ['not_found', 'DashPal-C4D5', 'Couldn’t find DashPal-C4D5. Make sure it’s on and nearby.'],
    ['window_timeout', null, dashpalCopy.setup.windowTimeout],
    ['setup_busy', null, dashpalCopy.setup.busyElsewhere],
    ['wrong_code', null, dashpalCopy.setup.wrongCode],
    ['no_match', null, dashpalCopy.setup.noMatch],
    ['unverified', null, dashpalCopy.setup.unverified],
    ['unverified_nearby', null, dashpalCopy.setup.unverifiedNearby],
    ['no_key', null, dashpalCopy.setup.noKey],
    ['update_firmware', null, dashpalCopy.setup.updateFirmware],
    ['mtu', null, dashpalCopy.setup.mtu],
    ['ios_forget_first', null, dashpalCopy.setup.iosForgetFirst],
    ['error', null, dashpalCopy.setup.failed],
  ] as const)('failed %s says so, and Try again restarts the flow', async (reason, name, text) => {
    setActiveDashcam(createFakeDashcamRuntime());
    const s = scriptedFlow();
    const w = await appWorld();
    await w.render(panel(s));
    await s.to({ kind: 'failed', reason, name });
    expect(screen.getByTestId('setup-phase-failed')).toHaveTextContent(text);
    if (reason === 'not_found') expect(screen.getByTestId('setup-extra')).toHaveTextContent(dashpalCopy.setup.notFoundTwoPhones);
    await tap('setup-retry');
    await waitFor(() => expect(s.started()).toBe(2));
  });

  it('no screen ever renders a label code (the setup copy carries none)', () => {
    const text = JSON.stringify(dashpalCopy).split(dashpalCopy.setup.codePlaceholder).join('');
    expect(text).not.toMatch(/[0-9A-HJKMNP-TV-Z]{4}-[0-9A-HJKMNP-TV-Z]{4}-[0-9A-HJKMNP-TV-Z]{4}/);
  });
});

describe('the onboarding step', () => {
  it('asks nothing until "Find my DashPal"; Not now moves on', async () => {
    setActiveDashcam(createFakeDashcamRuntime());
    const adapter = fakeAdapter();
    const onNext = jest.fn();
    const w = await appWorld();
    await w.render(<DashcamStep ctx={{ platform: 'ios', hasUsername: true }} onNext={onNext} deps={{ adapter }} secrets={memSecrets().secrets} />);
    expect(await screen.findByText(dashpalCopy.onboarding.title)).toBeOnTheScreen();
    expect(screen.getByTestId('dashcam-find')).toHaveTextContent(dashpalCopy.onboarding.find);
    expect(mockCamera.request).not.toHaveBeenCalled();
    await tap('dashcam-not-now');
    expect(onNext).toHaveBeenCalledTimes(1);
    expect(adapter.log).toEqual([]);
  });

  it.each([
    ['ios', null, 'Setting it up asks for the camera, to scan its code, and Bluetooth.'],
    ['android', 31, 'Setting it up asks for the camera, to scan its code, and Nearby devices (Bluetooth).'],
    ['android', 34, 'Setting it up asks for the camera, to scan its code, and Nearby devices (Bluetooth).'],
    ['android', 30, 'Setting it up asks for the camera, to scan its code, and uses Location to find it.'],
  ] as const)('the step says what setting it up asks for (%s, API %s)', async (platform, api, line) => {
    const w = await appWorld();
    await w.render(<DashcamStep ctx={{ platform, hasUsername: true }} onNext={jest.fn()} deps={{ adapter: fakeAdapter() }} api={api} secrets={memSecrets().secrets} />);
    expect(await screen.findByText(`${dashpalCopy.onboarding.body} ${line}`)).toBeOnTheScreen();
    expect(dashpalCopy.onboarding.asks(platform, api)).toBe(line);
  });

  it('"Find my DashPal" opens the setup inline (it opts in and asks there); Continue moves on whatever happened', async () => {
    setActiveDashcam(createFakeDashcamRuntime());
    const s = scriptedFlow();
    const onNext = jest.fn();
    const w = await appWorld();
    await w.render(<DashcamStep ctx={{ platform: 'android', hasUsername: true }} onNext={onNext} deps={{ adapter: fakeAdapter(), flow: s.make }} secrets={memSecrets().secrets} />);
    await tap('dashcam-find');
    expect(s.started()).toBe(1);
    expect(await screen.findByTestId('dashcam-setup-panel')).toBeOnTheScreen();
    await s.to({ kind: 'denied' });
    await tap('dashcam-continue');
    expect(onNext).toHaveBeenCalledTimes(1);
  });
});

describe('a DashPal link (/dashpal?d=…)', () => {
  it('opens the setup on that DashPal’s Pair screen when no drive is open; a bad id opens the code step', async () => {
    const w = await appWorld();
    await w.render(<DashpalLink d="A4CF12B3C4D5" now={() => 5} />);
    await waitFor(() => expect(mockRouter.replace).toHaveBeenCalledWith(setupHref({ link: 'a4cf12b3c4d5' })));
    expect(mockRouter.replace).toHaveBeenCalledWith('/settings/dashcam-setup?link=a4cf12b3c4d5');
    expect(await w.settings.get(PENDING_SETUP_KEY)).toBeNull();
    mockRouter.replace.mockClear();
    const w2 = await appWorld();
    await w2.render(<DashpalLink d="nope" now={() => 5} />);
    await waitFor(() => expect(mockRouter.replace).toHaveBeenCalledWith('/settings/dashcam-setup?link=1'));
  });

  it('during a drive it is held (the dashcam id, never the code) and the app goes Home', async () => {
    mockDrive.busy = true;
    const w = await appWorld();
    await w.render(<DashpalLink d="a4cf12b3c4d5" now={() => 5} />);
    await waitFor(() => expect(mockRouter.replace).toHaveBeenCalledWith('/'));
    expect(await w.settings.get(PENDING_SETUP_KEY)).toEqual({ at: 5, dashcamId: 'a4cf12b3c4d5' });
  });
});

describe('the prompt host', () => {
  // eslint-disable-next-line @typescript-eslint/no-require-imports -- after the mocks above
  const { DashpalPromptHost } = require('../ui/PromptHost') as typeof import('../ui/PromptHost');
  // eslint-disable-next-line @typescript-eslint/no-require-imports -- ditto
  const { SNOOZES_KEY } = require('../keys') as typeof import('../keys');

  function scanningRuntime(hits: { id: string; rssi: number }[]) {
    const rt = createFakeDashcamRuntime({ btOptIn: true });
    rt.transportValue = {
      scan: async (o: { onHit(h: { id: string; name: string | null; rssi: number; pairing: boolean }): void }) => {
        for (const h of hits) o.onHit({ id: h.id, name: `DashPal-${h.id}`, rssi: h.rssi, pairing: true });
        return { stop: async () => {} };
      },
    } as never;
    return rt;
  }

  const fastDeps = (adapter = fakeAdapter(undefined, { bluetoothNow: 'granted' })) => {
    let t = 0;
    return {
      adapter,
      speedMph: async () => 0,
      now: () => t,
      sleep: async (ms: number) => {
        t += ms;
      },
      appState: { addEventListener: () => ({ remove: () => {} }) },
    };
  };

  it('row 23: offers a nearby DashPal on a tab; Connect opens the setup for it', async () => {
    setActiveDashcam(scanningRuntime([{ id: 'X1', rssi: -50 }]));
    const w = await appWorld();
    await w.render(<DashpalPromptHost deps={fastDeps()} />);
    expect(await screen.findByTestId('dashpal-offer')).toBeOnTheScreen();
    expect(screen.getByText(dashpalCopy.prompt.found('DashPal-X1'))).toBeOnTheScreen();
    await tap('dashpal-offer-connect');
    expect(mockRouter.push).toHaveBeenCalledWith(setupHref({ found: 'X1' }));
    expect(screen.queryByTestId('dashpal-offer')).toBeNull();
  });

  it('row 23: a drive starting drops the offer', async () => {
    setActiveDashcam(scanningRuntime([{ id: 'X5', rssi: -50 }]));
    const w = await appWorld();
    await w.render(<DashpalPromptHost deps={fastDeps()} />);
    expect(await screen.findByTestId('dashpal-offer')).toBeOnTheScreen();
    await act(async () => {
      mockDrive.busy = true;
      for (const fn of [...mockDrive.listeners]) fn({ status: 'recording' });
    });
    expect(screen.queryByTestId('dashpal-offer')).toBeNull();
  });

  it('Not now writes the snooze', async () => {
    setActiveDashcam(scanningRuntime([{ id: 'X2', rssi: -50 }]));
    const w = await appWorld();
    await w.render(<DashpalPromptHost deps={fastDeps()} />);
    await tap('dashpal-offer-not-now');
    await waitFor(async () => expect(Object.keys((await w.settings.get<Record<string, number>>(SNOOZES_KEY)) ?? {})).toEqual(['X2']));
    expect(screen.queryByTestId('dashpal-offer')).toBeNull();
  });

  it('row 23: never on the drive route, never with Bluetooth not yet allowed (no prompt is made)', async () => {
    mockPath = '/drive';
    setActiveDashcam(scanningRuntime([{ id: 'X3', rssi: -50 }]));
    const w = await appWorld();
    await w.render(<DashpalPromptHost deps={fastDeps()} />);
    await act(async () => {});
    expect(screen.queryByTestId('dashpal-offer')).toBeNull();

    mockPath = '/home';
    const adapter = fakeAdapter(undefined, { bluetoothNow: 'undetermined' });
    await act(async () => setActiveDashcam(scanningRuntime([{ id: 'X4', rssi: -50 }])));
    const w2 = await appWorld();
    await w2.render(<DashpalPromptHost deps={fastDeps(adapter)} />);
    await act(async () => {});
    expect(screen.queryByTestId('dashpal-offer')).toBeNull();
    expect(adapter.log).toEqual(['bluetooth']);
  });

  it('a DashPal link held during a drive is replayed once the drive is over: its Pair screen', async () => {
    setActiveDashcam(createFakeDashcamRuntime());
    const w = await appWorld({ settings: { [PENDING_SETUP_KEY]: { at: 0, dashcamId: 'a4cf12b3c4d5' } } });
    await w.render(<DashpalPromptHost deps={fastDeps()} />);
    await waitFor(() => expect(mockRouter.push).toHaveBeenCalledWith(setupHref({ link: 'a4cf12b3c4d5' })));
    expect(await w.settings.get(PENDING_SETUP_KEY)).toBeNull();
  });

  it('a held link older than 12 h is dropped', async () => {
    setActiveDashcam(createFakeDashcamRuntime());
    const w = await appWorld({ settings: { [PENDING_SETUP_KEY]: { at: -12 * 60 * 60_000 - 1, dashcamId: 'a4cf12b3c4d5' } } });
    await w.render(<DashpalPromptHost deps={fastDeps()} />);
    await waitFor(async () => expect(await w.settings.get(PENDING_SETUP_KEY)).toBeNull());
    expect(mockRouter.push).not.toHaveBeenCalled();
  });

  it('shows a DashPal alert off the HUD for 1.5 s per start or level change', async () => {
    jest.useFakeTimers();
    try {
      const rt = createFakeDashcamRuntime();
      setActiveDashcam(rt);
      const w = await appWorld();
      let t = 0;
      await w.render(<DashpalPromptHost deps={{ ...fastDeps(), now: () => t }} />);
      await act(async () => rt.set({ link: { visual: { key: '7:0', alertId: 7, sound: 3, tier: 3, level: 0, onPhone: true, at: 0, resend: false } } }));
      expect(screen.getByTestId('dashpal-alert-banner')).toHaveTextContent('DashPal: Wake up', { exact: false });
      t = 1500;
      await act(async () => {
        jest.advanceTimersByTime(1500);
      });
      expect(screen.queryByTestId('dashpal-alert-banner')).toBeNull();
    } finally {
      jest.useRealTimers();
    }
  });
});

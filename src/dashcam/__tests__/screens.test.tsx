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
let mockSegments: string[] = ['(tabs)', 'home'];
jest.mock('expo-router', () => ({
  useRouter: () => mockRouter,
  usePathname: () => mockPath,
  useSegments: () => mockSegments,
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
const mockSession: { status: string; session: null; profile: unknown } = { status: 'signedIn', session: null, profile: { onboarded_at: '2026-01-01', username: 'maya' } };
jest.mock('@/data/supabase/session', () => ({ useSession: () => mockSession }));

// Imported after the mocks.
/* eslint-disable import/first */
import { DashcamScreen } from '@/features/settings/DashcamScreen';
import { DashcamStep } from '@/features/onboarding/steps/DashcamStep';
import { SetupPanel } from '../ui/SetupScreen';
/* eslint-enable import/first */

beforeEach(() => {
  mockRouter.push.mockClear();
  mockRouter.replace.mockClear();
  mockDrive.busy = false;
  mockPath = '/home';
  mockSegments = ['(tabs)', 'home'];
  mockSession.status = 'signedIn';
  mockSession.profile = { onboarded_at: '2026-01-01', username: 'maya' };
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
    pick: (id) => void answers.push(`pick:${id}`),
    pair: () => void answers.push('pair'),
    next: () => void answers.push('next'),
    retry: async () => void answers.push('retry'),
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
    expect(mockRouter.push).toHaveBeenLastCalledWith('/settings/dashcam-setup?again=1');
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

  it('Add another phone: a sheet with the 2:00 countdown and where to set it up on the other phone; no QR code and no code', async () => {
    const rt = createFakeDashcamRuntime({ link: { lifecycle: 'connected', paired: PAIRED, status: { state: 3, flags: 0, fpsX10: 200, tempC: 40, bondCount: 1, at: 1 } } });
    const t = 50_000;
    rt.addPhoneResult = { openedAt: t };
    setActiveDashcam(rt);
    const w = await appWorld();
    await w.render(<DashcamScreen deps={{ adapter: fakeAdapter(), now: () => t }} />);
    await tap('dashcam-add-phone');
    expect(rt.log).toEqual(['addPhone']);
    expect(await screen.findByTestId('add-phone-left')).toHaveTextContent(dashpalCopy.screen.addPhoneSheet.left('2:00'));
    expect(screen.getByTestId('add-phone-body')).toHaveTextContent('On the other phone, open RoadWise › Settings › DashPal › Set up DashPal.');
    expect(screen.queryByTestId('add-phone-qr')).toBeNull();
    expect(screen.queryByTestId('add-phone-code')).toBeNull();
    await tap('add-phone-done');
    expect(screen.queryByTestId('add-phone-left')).toBeNull();
  });

  it('Add another phone after its 2 minutes: “Pairing has closed. Open it again to add a phone.”', async () => {
    const rt = createFakeDashcamRuntime({ link: { lifecycle: 'connected', paired: PAIRED, status: { state: 3, flags: 0, fpsX10: 200, tempC: 40, bondCount: 1, at: 1 } } });
    rt.addPhoneResult = { openedAt: 1000 };
    setActiveDashcam(rt);
    const w = await appWorld();
    await w.render(<DashcamScreen deps={{ adapter: fakeAdapter(), now: () => 1000 + 120_000 }} />);
    await tap('dashcam-add-phone');
    expect(await screen.findByTestId('add-phone-ended')).toHaveTextContent(dashpalCopy.screen.addPhoneSheet.ended);
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

  it('the flow gets the live busy read, the runtime, the target (found, again); cancel on unmount', async () => {
    const rt = createFakeDashcamRuntime();
    setActiveDashcam(rt);
    const s = scriptedFlow();
    const w = await appWorld();
    const view = await w.render(panel(s, { found: 'PERIPH-9', again: true }, 'android'));
    expect(s.started()).toBe(1);
    expect(s.starts[0]).toEqual({ target: { peripheralId: 'PERIPH-9', name: null, adv: 'new' }, again: true });
    const base = s.bases[0]!;
    mockDrive.busy = true;
    expect(base.isBusy()).toBe(false); // the setup screens read the drive context, not the mocked hooks
    base.notePhones?.('a4cf12b3c4d5', 2);
    expect(rt.log).toContain('notePhones:a4cf12b3c4d5:2');
    // The key refused: R_UNKNOWN_PHONE at the paired DashPal's auto-connect, read live.
    expect(base.keyRefused(PAIRED.dashcamId)).toBe(false);
    rt.set({ link: { paired: PAIRED, lifecycle: 'needs_repair', repairCause: 'unknown_phone' } });
    expect(base.keyRefused(PAIRED.dashcamId)).toBe(true);
    expect(base.keyRefused('a4cf12b3c401')).toBe(false);
    rt.set({ link: { repairCause: 'downgrade' } });
    expect(base.keyRefused(PAIRED.dashcamId)).toBe(false);
    await act(async () => view.unmount());
    expect(s.cancelled()).toBe(1);
  });

  it('screen 1: “Pair DashPal-XXXX?” with Pair (no code anywhere); a different DashPal says it replaces the paired one; a choice of two', async () => {
    setActiveDashcam(createFakeDashcamRuntime());
    const s = scriptedFlow();
    const w = await appWorld();
    await w.render(panel(s));
    await s.to({ kind: 'confirm', name: 'DashPal-C4D5', mode: 'new', replaces: null });
    expect(screen.getByTestId('setup-phase-confirm')).toHaveTextContent('Pair DashPal-C4D5?');
    await tap('setup-pair');
    await s.to({ kind: 'confirm', name: 'DashPal-C4D5', mode: 'new', replaces: 'DashPal-AAAA' });
    expect(screen.getByTestId('setup-extra')).toHaveTextContent('This replaces DashPal-AAAA on this phone.', { exact: false });
    await s.to({ kind: 'confirm', name: 'DashPal-C4D5', mode: 'again', replaces: null });
    expect(screen.getByTestId('setup-phase-confirm')).toHaveTextContent('Set up DashPal-C4D5 again');
    await s.to({
      kind: 'choose',
      candidates: [
        { id: 'P1', name: 'DashPal-0001', rssi: -40, adv: 'new' },
        { id: 'P2', name: 'DashPal-0002', rssi: -60, adv: 'open' },
      ],
    });
    expect(screen.getByTestId('setup-phase-choose')).toHaveTextContent('Which DashPal is yours?');
    await tap('setup-pick-P2');
    expect(s.answers).toEqual(['pair', 'pick:P2']);
  });

  it.each([
    [{ kind: 'search', until: 1 }, 'Looking for your DashPal…'],
    [{ kind: 'connecting', name: 'DashPal-C4D5', reconnecting: false }, 'Connecting to DashPal-C4D5…'],
    [{ kind: 'connecting', name: 'DashPal-C4D5', reconnecting: true }, 'Reconnecting…'],
    [{ kind: 'connected', name: 'DashPal-C4D5' }, 'Connected'],
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

  it('after the pairing: Next finishes; the hold’s last minute says how long is left; Cancel stops the setup', async () => {
    setActiveDashcam(createFakeDashcamRuntime());
    const s = scriptedFlow();
    const w = await appWorld();
    await w.render(panel(s));
    await s.to({ kind: 'instructions', aimAllowed: true, holdLeftS: 42, reconnecting: false });
    expect(screen.getByTestId('setup-extra')).toHaveTextContent('Finish setup within 0:42');
    await tap('setup-next');
    expect(s.answers).toEqual(['next']);
    await tap('setup-cancel');
    expect(s.cancelled()).toBe(1);
  });

  it('done: one phone says nothing more; 2 or more says how many and "Not all yours?"; Add another phone says the other phone aimed it', async () => {
    setActiveDashcam(createFakeDashcamRuntime());
    const s = scriptedFlow();
    const w = await appWorld();
    await w.render(panel(s));
    await s.to({ kind: 'done', paired: PAIRED, phones: 1, notAllYours: false, aimedElsewhere: false });
    expect(screen.getByTestId('setup-phase-done')).toHaveTextContent('DashPal is ready');
    expect(screen.getByTestId('setup-extra')).toHaveTextContent('DashPal-C4D5 connects by itself whenever it’s on and nearby.');
    expect(screen.queryByTestId('setup-phones')).toBeNull();
    expect(screen.queryByTestId('setup-not-all-yours')).toBeNull();
    await s.to({ kind: 'done', paired: PAIRED, phones: 3, notAllYours: true, aimedElsewhere: true });
    expect(screen.getByTestId('setup-phones')).toHaveTextContent('3 phones are paired with this DashPal.');
    expect(screen.getByTestId('setup-not-all-yours')).toHaveTextContent(dashpalCopy.wizard.done.notAllYours, { exact: false });
    expect(screen.getByTestId('setup-aimed-elsewhere')).toHaveTextContent('Your other phone already aimed it.');
  });

  it.each([
    ['not_found', 'DashPal-C4D5', 'restart', 'Couldn’t reach DashPal-C4D5. Make sure it’s on and nearby.'],
    ['none_nearby', null, 'restart', dashpalCopy.wizard.failed.none_nearby],
    ['window_closed', 'DashPal-C4D5', 'restart', 'DashPal-C4D5 isn’t ready to pair anymore. Press its button 5 times, then try again.'],
    ['setup_busy', null, 'restart', dashpalCopy.wizard.failed.setup_busy],
    ['unverified', null, 'restart', dashpalCopy.wizard.failed.unverified],
    ['update_firmware', null, 'none', dashpalCopy.wizard.failed.update_firmware],
    ['update_app', null, 'none', dashpalCopy.wizard.failed.update_app],
    ['mtu', null, 'restart', dashpalCopy.wizard.failed.mtu],
    ['ios_forget_first', null, 'none', dashpalCopy.wizard.failed.ios_forget_first],
    ['lost', 'DashPal-C4D5', 'resume', 'Lost the connection to DashPal-C4D5. Try again.'],
    ['expired', null, 'restart', 'Setup took too long. Try again.'],
    ['save_failed', null, 'commit', 'DashPal couldn’t save the pairing. Try again.'],
    ['error', null, 'restart', dashpalCopy.wizard.failed.error],
  ] as const)('failed %s says so; Try again does what the failure says', async (reason, name, retry, text) => {
    setActiveDashcam(createFakeDashcamRuntime());
    const s = scriptedFlow();
    const w = await appWorld();
    await w.render(panel(s));
    await s.to({ kind: 'failed', reason, name, retry });
    expect(screen.getByTestId('setup-phase-failed')).toHaveTextContent(text);
    if (retry === 'none') {
      expect(screen.queryByTestId('setup-retry')).toBeNull();
      return;
    }
    await tap('setup-retry');
    if (retry === 'restart') await waitFor(() => expect(s.started()).toBe(2));
    else expect(s.answers).toEqual(['retry']);
  });

  it('no screen ever renders a pairing code (the setup copy carries none)', () => {
    const text = JSON.stringify(dashpalCopy.wizard);
    expect(text).not.toMatch(/[0-9A-HJKMNP-TV-Z]{4}-[0-9A-HJKMNP-TV-Z]{4}-[0-9A-HJKMNP-TV-Z]{4}/);
    expect(text).not.toMatch(/\bcode\b/i);
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
    ['ios', null, 'Setting it up asks for Bluetooth.'],
    ['android', 31, 'Setting it up asks for Nearby devices (Bluetooth).'],
    ['android', 34, 'Setting it up asks for Nearby devices (Bluetooth).'],
    ['android', 30, 'Setting it up uses Location to find it.'],
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

describe('the prompt host', () => {
  // eslint-disable-next-line @typescript-eslint/no-require-imports -- after the mocks above
  const { DashpalPromptHost } = require('../ui/PromptHost') as typeof import('../ui/PromptHost');

  const fastDeps = () => ({ appState: { addEventListener: () => ({ remove: () => {} }) } });

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

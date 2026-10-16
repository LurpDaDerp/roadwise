/**
 * The DashPal screens: Settings › DashPal (every status and its fix, the controls, forget), the
 * setup panel (busy refusal, the confirm question, done), the onboarding step (never asks for
 * Bluetooth until "Find my DashPal"), the prompt host and the box link's deferral.
 */
import { act, fireEvent, screen, waitFor } from '@testing-library/react-native';

import { appWorld, clearQueryClients, fakeAdapter, tap } from '@/features/permissions/__fixtures__/harness';
import { SETTINGS_HREFS } from '@/features/settings/routes';

import { createFakeDashcamRuntime, PAIRED } from '../__fixtures__/fakeRuntime';
import { dashpalCopy } from '../copy';
import { setActiveDashcam } from '../registry';
import type { SetupDeps, SetupFlow, SetupPhase } from '../setup';

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
});
afterEach(async () => {
  await act(async () => setActiveDashcam(null));
  clearQueryClients();
});

/** A scripted setup flow: the test moves its phase and sees the answers. */
function scriptedFlow() {
  const listeners = new Set<(p: SetupPhase) => void>();
  let phase: SetupPhase = { kind: 'idle' };
  const answers: boolean[] = [];
  let started = 0;
  let cancelled = 0;
  const flow: SetupFlow = {
    phase: () => phase,
    subscribe: (fn) => {
      listeners.add(fn);
      return () => void listeners.delete(fn);
    },
    start: async () => void (started += 1),
    answer: (yes) => void answers.push(yes),
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
    await w.render(<DashcamScreen deps={{ adapter: fakeAdapter(), platform: 'ios' }} />);
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
    ['needs_repair', null, 'Needs pairing again', dashpalCopy.screen.fix.needsRepair.ios],
  ] as const)('row 21/22: %s → "%s" with its fix', async (lifecycle, status, label, fix) => {
    setActiveDashcam(
      createFakeDashcamRuntime({
        link: { lifecycle, paired: PAIRED, status: status ? { state: status.state, flags: 0, fpsX10: 200, tempC: 40, bondCount: 1, at: 1 } : null },
      })
    );
    const w = await appWorld();
    await w.render(<DashcamScreen deps={{ adapter: fakeAdapter(), platform: 'ios' }} />);
    expect(await screen.findByTestId('dashcam-status')).toHaveTextContent(label);
    if (fix) expect(screen.getByTestId('dashcam-fix')).toHaveTextContent(fix);
    else expect(screen.queryByTestId('dashcam-fix')).toBeNull();
  });

  it('not allowed opens Settings; needs pairing again sets up again', async () => {
    const adapter = fakeAdapter();
    const rt = createFakeDashcamRuntime({ link: { lifecycle: 'unauthorized', paired: PAIRED } });
    setActiveDashcam(rt);
    const w = await appWorld();
    await w.render(<DashcamScreen deps={{ adapter, platform: 'android' }} />);
    await tap('dashcam-open-settings');
    expect(adapter.log).toContain('openAppSettings');
    await act(async () => rt.set({ link: { lifecycle: 'needs_repair' } }));
    expect(screen.getByTestId('dashcam-fix')).toHaveTextContent(dashpalCopy.screen.fix.needsRepair.android);
    await tap('dashcam-repair');
    expect(mockRouter.push).toHaveBeenLastCalledWith(SETTINGS_HREFS.dashcamSetup);
  });

  it('connected: also beep, test sound, recalibrate, add another phone, forget (iOS says how to finish)', async () => {
    const rt = createFakeDashcamRuntime({ link: { lifecycle: 'connected', paired: PAIRED, status: { state: 3, flags: 0, fpsX10: 200, tempC: 40, bondCount: 1, at: 1 } } });
    setActiveDashcam(rt);
    const w = await appWorld();
    await w.render(<DashcamScreen deps={{ adapter: fakeAdapter(), platform: 'ios' }} />);
    await act(async () => {
      fireEvent(await screen.findByTestId('dashcam-buzzer-too'), 'valueChange', true);
    });
    await tap('dashcam-test');
    await tap('dashcam-recalibrate');
    await tap('dashcam-add-phone');
    expect(screen.getByTestId('dashcam-notice')).toHaveTextContent(dashpalCopy.screen.addPhoneDone, { exact: false });
    expect(dashpalCopy.screen.addPhoneDone).toBe('Pairing is open for 2 minutes, for one phone: set up DashPal on the other phone now.');
    await tap('dashcam-forget');
    await tap('dashcam-forget-confirm');
    expect(rt.log).toEqual(['buzzerToo:true', 'command:6:1', 'command:2:0', 'command:3:0', 'forget']);
    expect(screen.getByTestId('dashcam-notice')).toHaveTextContent(dashpalCopy.screen.forgetIos, { exact: false });
  });

  it('connected: "Phones paired: N" from STATUS; from 2 phones, how to remove one; nothing while not connected or before STATUS', async () => {
    const status = (bondCount: number) => ({ state: 3, flags: 0, fpsX10: 200, tempC: 40, bondCount, at: 1 });
    const rt = createFakeDashcamRuntime({ link: { lifecycle: 'connected', paired: PAIRED, status: status(1) } });
    setActiveDashcam(rt);
    const w = await appWorld();
    await w.render(<DashcamScreen deps={{ adapter: fakeAdapter(), platform: 'android' }} />);
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
    await w.render(<DashcamScreen deps={{ adapter: fakeAdapter(), platform: 'android' }} />);
    await tap('dashcam-test');
    expect(screen.getByTestId('dashcam-notice')).toHaveTextContent(dashpalCopy.screen.notConnected, { exact: false });
    expect(rt.log).toEqual([]);
    await act(async () => rt.set({ link: { lifecycle: 'connected' } }));
    rt.commandResult = false;
    await tap('dashcam-recalibrate');
    expect(screen.getByTestId('dashcam-notice')).toHaveTextContent(dashpalCopy.screen.commandFailed, { exact: false });
  });
});

describe('the setup panel', () => {
  it('row 43: a drive open → "Finish your drive first" (the flow refuses; the panel shows it)', async () => {
    setActiveDashcam(createFakeDashcamRuntime());
    const s = scriptedFlow();
    const w = await appWorld();
    await w.render(<SetupPanel deps={{ adapter: fakeAdapter(), platform: 'ios', flow: s.make }} onClose={() => {}} />);
    await s.to({ kind: 'busy' });
    expect(screen.getByTestId('setup-phase-busy')).toHaveTextContent(dashpalCopy.setup.busy);
  });

  it('the flow gets the live busy read, the runtime and the found dashcam; Yes/No answer it; cancel on unmount', async () => {
    const rt = createFakeDashcamRuntime();
    setActiveDashcam(rt);
    const s = scriptedFlow();
    const w = await appWorld();
    const view = await w.render(<SetupPanel found="PERIPH-9" deps={{ adapter: fakeAdapter(), platform: 'android', flow: s.make }} onClose={() => {}} />);
    expect(s.started()).toBe(1);
    const base = s.bases[0]!;
    expect(base.preferId).toBe('PERIPH-9');
    mockDrive.busy = true;
    expect(base.isBusy()).toBe(false); // the setup screens read the drive context, not the mocked hooks
    await s.to({ kind: 'confirm', candidate: { id: 'X', name: 'DashPal-C4D5', rssi: -50 }, info: {} as never });
    expect(screen.getByTestId('setup-phase-confirm')).toHaveTextContent(dashpalCopy.setup.identify);
    await tap('setup-no');
    await tap('setup-yes');
    expect(s.answers).toEqual([false, true]);
    await s.to({ kind: 'done', paired: PAIRED, phones: 1, unexpected: false });
    expect(screen.getByTestId('setup-phase-done')).toHaveTextContent('Connected to DashPal-C4D5.');
    await act(async () => view.unmount());
    expect(s.cancelled()).toBe(1);
  });

  it('done: one phone says nothing more; 2 or more says how many; more than expected warns how to remove the others', async () => {
    setActiveDashcam(createFakeDashcamRuntime());
    const s = scriptedFlow();
    const w = await appWorld();
    await w.render(<SetupPanel deps={{ adapter: fakeAdapter(), platform: 'ios', flow: s.make }} onClose={() => {}} />);
    await s.to({ kind: 'done', paired: PAIRED, phones: 1, unexpected: false });
    expect(screen.queryByTestId('setup-phones')).toBeNull();
    expect(screen.queryByTestId('setup-unexpected')).toBeNull();
    await s.to({ kind: 'done', paired: PAIRED, phones: null, unexpected: false });
    expect(screen.queryByTestId('setup-phones')).toBeNull();
    await s.to({ kind: 'done', paired: PAIRED, phones: 2, unexpected: false });
    expect(screen.getByTestId('setup-phones')).toHaveTextContent('2 phones are paired with this DashPal.');
    expect(screen.queryByTestId('setup-unexpected')).toBeNull();
    await s.to({ kind: 'done', paired: PAIRED, phones: 3, unexpected: true });
    expect(screen.getByTestId('setup-phones')).toHaveTextContent('3 phones are paired with this DashPal.');
    expect(screen.getByTestId('setup-unexpected')).toHaveTextContent(dashpalCopy.setup.doneUnexpected, { exact: false });
  });

  it('another phone is setting it up: says so, and Try again restarts the flow', async () => {
    setActiveDashcam(createFakeDashcamRuntime());
    const s = scriptedFlow();
    const w = await appWorld();
    await w.render(<SetupPanel deps={{ adapter: fakeAdapter(), platform: 'android', flow: s.make }} onClose={() => {}} />);
    await s.to({ kind: 'failed', reason: 'setup_busy' });
    expect(screen.getByTestId('setup-phase-failed')).toHaveTextContent(dashpalCopy.setup.busyElsewhere);
    await tap('setup-retry');
    await waitFor(() => expect(s.started()).toBe(2));
  });

  it('none found tells how to open pairing, and Try again restarts the flow', async () => {
    setActiveDashcam(createFakeDashcamRuntime());
    const s = scriptedFlow();
    const w = await appWorld();
    await w.render(<SetupPanel deps={{ adapter: fakeAdapter(), platform: 'ios', flow: s.make }} onClose={() => {}} />);
    await s.to({ kind: 'none_found' });
    expect(screen.getByTestId('setup-phase-none_found')).toHaveTextContent(dashpalCopy.setup.noneFound);
    await tap('setup-retry');
    await waitFor(() => expect(s.started()).toBe(2));
  });
});

describe('the onboarding step', () => {
  it('asks nothing until "Find my DashPal"; Not now moves on', async () => {
    setActiveDashcam(createFakeDashcamRuntime());
    const adapter = fakeAdapter();
    const onNext = jest.fn();
    const w = await appWorld();
    await w.render(<DashcamStep ctx={{ platform: 'ios', hasUsername: true }} onNext={onNext} deps={{ adapter }} />);
    expect(await screen.findByText(dashpalCopy.onboarding.title)).toBeOnTheScreen();
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
    await w.render(<DashcamStep ctx={{ platform, hasUsername: true }} onNext={jest.fn()} deps={{ adapter: fakeAdapter() }} api={api} />);
    expect(await screen.findByText(`${dashpalCopy.onboarding.body} ${line}`)).toBeOnTheScreen();
    expect(dashpalCopy.onboarding.asks(platform, api)).toBe(line);
  });

  it('"Find my DashPal" opens the setup inline (it opts in and asks there); Continue moves on whatever happened', async () => {
    setActiveDashcam(createFakeDashcamRuntime());
    const s = scriptedFlow();
    const onNext = jest.fn();
    const w = await appWorld();
    await w.render(<DashcamStep ctx={{ platform: 'android', hasUsername: true }} onNext={onNext} deps={{ adapter: fakeAdapter(), flow: s.make }} />);
    await tap('dashcam-find');
    expect(s.started()).toBe(1);
    expect(await screen.findByTestId('dashcam-setup-panel')).toBeOnTheScreen();
    await s.to({ kind: 'denied' });
    await tap('dashcam-continue');
    expect(onNext).toHaveBeenCalledTimes(1);
  });
});

describe('the box link (roadwise://dashpal)', () => {
  it('opens the setup when no drive is open', async () => {
    const w = await appWorld();
    await w.render(<DashpalLink now={() => 5} />);
    await waitFor(() => expect(mockRouter.replace).toHaveBeenCalledWith(setupHref()));
    expect(await w.settings.get(PENDING_SETUP_KEY)).toBeNull();
  });

  it('row 43: during a drive it is held and the app goes Home', async () => {
    mockDrive.busy = true;
    const w = await appWorld();
    await w.render(<DashpalLink now={() => 5} />);
    await waitFor(() => expect(mockRouter.replace).toHaveBeenCalledWith('/'));
    expect(await w.settings.get(PENDING_SETUP_KEY)).toEqual({ at: 5 });
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
    expect(mockRouter.push).toHaveBeenCalledWith(setupHref('X1'));
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

  it('a box link held during a drive is replayed once the drive is over', async () => {
    setActiveDashcam(createFakeDashcamRuntime());
    const w = await appWorld({ settings: { [PENDING_SETUP_KEY]: { at: 0 } } });
    await w.render(<DashpalPromptHost deps={fastDeps()} />);
    await waitFor(() => expect(mockRouter.push).toHaveBeenCalledWith(setupHref()));
    expect(await w.settings.get(PENDING_SETUP_KEY)).toBeNull();
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

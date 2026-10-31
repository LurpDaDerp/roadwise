/**
 * The DashPal screens: Settings › DashPal (every status and its fix, the controls, Add another
 * phone, the new-phone notice, forget, Set up and Set up again opening the setup sheet), Home's
 * DashPal cards, the onboarding step (never asks for Bluetooth or the camera until "Find my
 * DashPal", which opens the setup sheet) and the prompt host. The sheet's own steps: wizard.test.tsx.
 */
import { act, fireEvent, screen, waitFor } from '@testing-library/react-native';
import { Profiler, useState } from 'react';
import { Pressable } from 'react-native';

import type { AppStateLike } from '@/data/foreground';
import { appWorld, clearQueryClients, fakeAdapter, tap } from '@/features/permissions/__fixtures__/harness';

import { createFakeDashcamRuntime, PAIRED } from '../__fixtures__/fakeRuntime';
import { dashpalCopy } from '../copy';
import { SNOOZE_MS, DETECT_EVERY_MS, DETECT_PULL_EVERY_MS } from '../detector';
import { SNOOZES_KEY } from '../keys';
import { PAIRING_NEW, PAIRING_OPEN } from '../protocol';
import { setActiveDashcam } from '../registry';
import { createDashpalSecrets } from '../secure';
import type { SetupDeps, SetupFlow, SetupPhase } from '../setup';
import type { DashcamTransport, ScanHit } from '../transport';

jest.mock('expo-haptics', () => ({
  notificationAsync: jest.fn(async () => {}),
  NotificationFeedbackType: { Success: 'success', Warning: 'warning', Error: 'error' },
}));
jest.mock('expo-screen-capture', () => ({ usePreventScreenCapture: jest.fn() }));
// expo-image as a plain view (the re-aim sheet's picture)
jest.mock('expo-image', () => {
  // eslint-disable-next-line @typescript-eslint/no-require-imports -- inside the mock factory
  const { View } = require('react-native') as typeof import('react-native');
  return { Image: (p: Record<string, unknown>) => <View {...p} /> };
});
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
// Focus runs its effect on mount, as on a real focus.
jest.mock('expo-router', () => {
  const { useEffect } = jest.requireActual<typeof import('react')>('react');
  return {
    useRouter: () => mockRouter,
    usePathname: () => mockPath,
    useSegments: () => mockSegments,
    useFocusEffect: (fn: () => void | (() => void)) => useEffect(fn, [fn]),
  };
});
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
    startAim: () => void answers.push('startAim'),
    next: () => void answers.push('next'),
    onViewFrame: () => () => {},
    onAim: () => () => {},
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
  it('unpaired: what DashPal is, and Set up opening the setup sheet', async () => {
    setActiveDashcam(createFakeDashcamRuntime());
    const w = await appWorld();
    const s = scriptedFlow();
    await w.render(<DashcamScreen deps={{ adapter: fakeAdapter(), setup: { flow: s.make, secrets: memSecrets().secrets } }} />);
    expect(await screen.findByTestId('dashcam-intro')).toHaveTextContent(dashpalCopy.screen.intro);
    expect(screen.queryByTestId('wizard-sheet')).toBeNull();
    await tap('dashcam-setup');
    // The setup sheet, looking for a DashPal in pairing mode.
    expect(screen.getByTestId('wizard-sheet')).toBeOnTheScreen();
    expect(s.starts).toEqual([{}]);
    expect(mockRouter.push).not.toHaveBeenCalled();
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

  it('a newer firmware answering: "Update RoadWise" with its fix, never the firmware one', async () => {
    setActiveDashcam(createFakeDashcamRuntime({ link: { lifecycle: 'needs_repair', repairCause: 'update_app', paired: PAIRED } }));
    const w = await appWorld();
    await w.render(<DashcamScreen deps={{ adapter: fakeAdapter() }} />);
    expect(await screen.findByTestId('dashcam-status')).toHaveTextContent('Update RoadWise');
    expect(screen.getByTestId('dashcam-fix')).toHaveTextContent(dashpalCopy.screen.fix.updateApp);
    expect(screen.getByTestId('dashcam-fix')).not.toHaveTextContent(dashpalCopy.screen.fix.downgrade);
    expect(screen.queryByTestId('dashcam-repair')).toBeNull();
  });

  it('not allowed opens Settings; needs pairing again and can’t verify open the setup sheet on the paired DashPal', async () => {
    const adapter = fakeAdapter();
    const rt = createFakeDashcamRuntime({ link: { lifecycle: 'unauthorized', paired: PAIRED } });
    setActiveDashcam(rt);
    const w = await appWorld();
    const s = scriptedFlow();
    await w.render(<DashcamScreen deps={{ adapter, setup: { flow: s.make, secrets: memSecrets().secrets } }} />);
    await tap('dashcam-open-settings');
    expect(adapter.log).toContain('openAppSettings');
    await act(async () => rt.set({ link: { lifecycle: 'needs_repair', repairCause: 'unknown_phone' } }));
    expect(screen.getByTestId('dashcam-fix')).toHaveTextContent(dashpalCopy.screen.fix.needsRepair);
    await tap('dashcam-repair');
    expect(screen.getByTestId('wizard-sheet')).toBeOnTheScreen();
    expect(s.starts).toEqual([{ again: true }]);
    await s.to({ kind: 'done', paired: PAIRED, phones: 1, notAllYours: false, aimedElsewhere: false });
    await tap('wizard-done');
    expect(screen.queryByTestId('wizard-sheet')).toBeNull();
    await act(async () => rt.set({ link: { lifecycle: 'unverified', repairCause: null } }));
    await tap('dashcam-repair');
    expect(s.starts).toEqual([{ again: true }, { again: true }]);
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
    await tap('dashcam-forget');
    await tap('dashcam-forget-confirm');
    expect(rt.log).toEqual(['buzzerToo:true', 'command:6:1', 'forget']);
    expect(screen.queryByTestId('dashcam-notice')).toBeNull();
  });

  it('Recalibrate opens the camera view (the re-aim sheet): the picture is asked for; Done with no picture recalibrates and closes it', async () => {
    const rt = createFakeDashcamRuntime({ link: { lifecycle: 'connected', paired: PAIRED, firmware: 'dms-core 3.6', status: { state: 3, flags: 0, fpsX10: 200, tempC: 40, bondCount: 1, at: 1 } } });
    const view = rt.withPairedView();
    setActiveDashcam(rt);
    const w = await appWorld();
    await w.render(<DashcamScreen deps={{ adapter: fakeAdapter() }} />);
    expect(screen.queryByTestId('dashcam-reaim-needed')).toBeNull();
    await tap('dashcam-recalibrate');
    expect(await screen.findByTestId('reaim-sheet')).toBeTruthy();
    await waitFor(() => expect(rt.log).toEqual(['subscribePairedView', 'command:10:1']));
    expect(view.subscribed()).toBe(true);
    await act(async () => rt.viewFrame({ type: 'VIEW_STATE', on: 0, reason: 3, leftS: 600 }));
    expect(await screen.findByTestId('reaim-refused')).toHaveTextContent(dashpalCopy.screen.reaim.refused.drive);
    await tap('reaim-done');
    await waitFor(() => expect(rt.log.at(-1)).toBe('command:2:0'));
    await waitFor(() => expect(screen.queryByTestId('reaim-sheet')).toBeNull());
  });

  it('the camera needs adjusting: the Recalibrate row says so', async () => {
    const rt = createFakeDashcamRuntime({ reaim: true, link: { lifecycle: 'idle', paired: PAIRED } });
    setActiveDashcam(rt);
    const w = await appWorld();
    await w.render(<DashcamScreen deps={{ adapter: fakeAdapter() }} />);
    expect(await screen.findByTestId('dashcam-reaim-needed')).toHaveTextContent(dashpalCopy.screen.reaim.needs);
  });

  it('reached from the Home reminder (aim=1): the camera view opens by itself; not connected, it says so and Done sends nothing', async () => {
    const rt = createFakeDashcamRuntime({ reaim: true, link: { lifecycle: 'idle', paired: PAIRED } });
    setActiveDashcam(rt);
    const w = await appWorld();
    await w.render(<DashcamScreen openAim deps={{ adapter: fakeAdapter() }} />);
    expect(await screen.findByTestId('reaim-sheet')).toBeTruthy();
    expect(await screen.findByTestId('reaim-status')).toHaveTextContent(dashpalCopy.screen.reaim.offline);
    await tap('reaim-done');
    await waitFor(() => expect(screen.queryByTestId('reaim-sheet')).toBeNull());
    expect(rt.log).toEqual([]);
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

  it('a STATUS that changes nothing it shows (receipt time, frame rate, temperature) does not draw it again', async () => {
    const status = (o: { at: number; fpsX10: number; tempC: number }) => ({ state: 3, flags: 0, bondCount: 1, ...o });
    const rt = createFakeDashcamRuntime({ link: { lifecycle: 'connected', paired: PAIRED, status: status({ at: 1, fpsX10: 200, tempC: 40 }) } });
    setActiveDashcam(rt);
    let renders = 0;
    const w = await appWorld();
    await w.render(
      <Profiler id="dashcam" onRender={() => void (renders += 1)}>
        <DashcamScreen deps={{ adapter: fakeAdapter() }} />
      </Profiler>
    );
    expect(await screen.findByTestId('dashcam-phones')).toHaveTextContent('Phones paired: 1');
    const before = renders;
    for (let i = 2; i < 6; i++) await act(async () => rt.set({ link: { lifecycle: 'connected', status: status({ at: i * 2000, fpsX10: 190 + i, tempC: 40 + i }) } }));
    expect(renders).toBe(before);
    // A change it shows draws it.
    await act(async () => rt.set({ link: { lifecycle: 'connected', status: { ...status({ at: 20_000, fpsX10: 200, tempC: 40 }), bondCount: 2 } } }));
    expect(renders).toBeGreaterThan(before);
    expect(screen.getByTestId('dashcam-phones')).toHaveTextContent('Phones paired: 2');
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
    await tap('dashcam-test');
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

describe('Home: the camera needs adjusting', () => {
  it('a reminder while the paired DashPal says so; a tap opens Settings › DashPal with its camera view', async () => {
    // eslint-disable-next-line @typescript-eslint/no-require-imports -- after the mocks above
    const { ReaimCard } = require('../ui/ReaimCard') as typeof import('../ui/ReaimCard');
    mockRouter.push.mockClear();
    setActiveDashcam(createFakeDashcamRuntime({ reaim: true, link: { lifecycle: 'idle', paired: PAIRED } }));
    const w = await appWorld();
    await w.render(<ReaimCard />);
    expect(await screen.findByTestId('home-dashpal-reaim')).toHaveTextContent(dashpalCopy.screen.reaim.homeTitle, { exact: false });
    await tap('home-dashpal-reaim');
    expect(mockRouter.push).toHaveBeenCalledWith({ pathname: '/settings/dashcam', params: { aim: '1' } });
  });

  it.each([
    ['during a drive', { reaim: true, link: { lifecycle: 'connected' as const, paired: PAIRED } }, true],
    ['with no DashPal paired', { reaim: true, link: { lifecycle: 'unpaired' as const, paired: null } }, false],
    ['while the camera is fine', { reaim: false, link: { lifecycle: 'connected' as const, paired: PAIRED } }, false],
  ])('nothing %s', async (_name, state, hidden) => {
    // eslint-disable-next-line @typescript-eslint/no-require-imports -- after the mocks above
    const { ReaimCard } = require('../ui/ReaimCard') as typeof import('../ui/ReaimCard');
    setActiveDashcam(createFakeDashcamRuntime(state));
    const w = await appWorld();
    await w.render(<ReaimCard hidden={hidden} />);
    expect(screen.queryByTestId('home-dashpal-reaim')).toBeNull();
  });
});

describe('Home: the card of a DashPal ready to pair', () => {
  // eslint-disable-next-line @typescript-eslint/no-require-imports -- after the mocks above
  const { HomeDashpal } = require('../ui/HomeDashpal') as typeof import('../ui/HomeDashpal');

  /** A runtime whose transport hears `hits` on every scan; a clock the scan's waits move. */
  function nearby(hits: ScanHit[], state: Parameters<typeof createFakeDashcamRuntime>[0] = {}) {
    const rt = createFakeDashcamRuntime({ btOptIn: true, ...state });
    const scans: string[][] = [];
    const stops = { n: 0 };
    rt.transportValue = {
      scan: async (o: { services: string[]; onHit(h: ScanHit): void }) => {
        scans.push(o.services);
        for (const h of hits) o.onHit(h);
        return { stop: async () => void (stops.n += 1) };
      },
    } as unknown as DashcamTransport;
    setActiveDashcam(rt);
    const clock = { t: 5_000_000 };
    const flow = scriptedFlow();
    const deps = {
      setup: { adapter: fakeAdapter(), platform: 'ios' as const, flow: flow.make, secrets: memSecrets().secrets },
      adapter: fakeAdapter(undefined, { bluetoothNow: 'granted' }),
      speedMph: async () => 0,
      now: () => clock.t,
      sleep: (async (ms: number) => void (clock.t += ms)) as (ms: number) => Promise<void>,
      appState: { currentState: 'active', addEventListener: () => ({ remove: () => {} }) } as AppStateLike,
    };
    return { rt, scans, stops, clock, deps, flow };
  }
  const NEW: ScanHit = { id: 'P-1A2B', name: 'DashPal-1A2B', rssi: -50, adv: 'new' };

  /** RoadWise's AppState, moved by the test. */
  function movingAppState() {
    const fns = new Set<(s: string) => void>();
    return {
      currentState: 'active',
      addEventListener: (_type: 'change', fn: (s: string) => void) => {
        fns.add(fn);
        return { remove: () => void fns.delete(fn) };
      },
      to: (s: string) =>
        act(async () => {
          for (const fn of [...fns]) fn(s);
        }),
    };
  }

  it('a DashPal with no phone paired nearby: “Pair DashPal-1A2B?” · “A new DashPal is nearby.”, one button that opens the setup sheet on it', async () => {
    const n = nearby([NEW, { id: 'P-FAR', name: 'DashPal-FFFF', rssi: -90, adv: 'new' }]);
    const w = await appWorld();
    await w.render(<HomeDashpal deps={n.deps} />);
    expect(await screen.findByTestId('home-dashpal-pair-title')).toHaveTextContent('Pair DashPal-1A2B?');
    expect(screen.getByTestId('home-dashpal-pair-subtitle')).toHaveTextContent('A new DashPal is nearby.');
    expect(n.scans).toEqual([[PAIRING_NEW, PAIRING_OPEN]]);
    const button = screen.getByTestId('home-dashpal-pair-open');
    expect(button.props.accessibilityLabel).toBe('Pair DashPal-1A2B?');
    expect(button.props.accessibilityHint).toBe('Opens setup');
    expect(button.props.accessibilityActions).toEqual([{ name: 'notNow', label: 'Not now' }]);
    await tap('home-dashpal-pair-open');
    expect(n.flow.starts).toEqual([{ target: { peripheralId: 'P-1A2B', name: 'DashPal-1A2B', adv: 'new' } }]);
    expect(screen.getByTestId('wizard-sheet')).toBeOnTheScreen();
    expect(screen.queryByTestId('home-dashpal-pair')).toBeNull();
    expect(mockRouter.push).not.toHaveBeenCalled();
  });

  it('a drive starting while the sheet is open: the cards go, the sheet stays and its flow is not torn down (it says “Finish your drive first.”)', async () => {
    const n = nearby([NEW]);
    const w = await appWorld();
    function Driving() {
      const [hidden, setHidden] = useState(false);
      return (
        <>
          <HomeDashpal deps={n.deps} hidden={hidden} />
          <Pressable testID="drive" onPress={() => setHidden(true)} />
        </>
      );
    }
    await w.render(<Driving />);
    await tap('home-dashpal-pair-open');
    await n.flow.to({ kind: 'instructions', aimAllowed: true, holdLeftS: null, reconnecting: false });
    await tap('drive');
    expect(screen.queryByTestId('home-dashpal-pair')).toBeNull();
    expect(screen.getByTestId('wizard-sheet')).toBeOnTheScreen();
    expect(n.flow.cancelled()).toBe(0);
    await n.flow.to({ kind: 'busy' });
    expect(screen.getByTestId('wizard-sheet')).toHaveTextContent(dashpalCopy.wizard.failed.busy, { exact: false });
  });

  it('Not now (the ✕ or the screen reader’s action) hides it and snoozes that DashPal for 7 days', async () => {
    const n = nearby([NEW]);
    const w = await appWorld();
    await w.render(<HomeDashpal deps={n.deps} />);
    await tap('home-dashpal-pair-not-now');
    expect(screen.queryByTestId('home-dashpal-pair')).toBeNull();
    await waitFor(async () => expect(await w.settings.get(SNOOZES_KEY)).toEqual({ 'P-1A2B': n.clock.t + SNOOZE_MS }));

    const m = nearby([NEW]);
    const v = await appWorld();
    await v.render(<HomeDashpal deps={m.deps} />);
    await act(async () => {
      fireEvent(await screen.findByTestId('home-dashpal-pair-open'), 'accessibilityAction', { nativeEvent: { actionName: 'notNow' } });
    });
    expect(screen.queryByTestId('home-dashpal-pair')).toBeNull();
  });

  it('this phone’s DashPal that no longer knows it: “Set up DashPal-C4D5 again?” · “It doesn’t recognize this phone anymore.”, opening the setup sheet’s Set up again', async () => {
    const n = nearby([{ id: PAIRED.peripheralId, name: null, rssi: -60, adv: 'open' }], { link: { lifecycle: 'needs_repair', paired: PAIRED, repairCause: 'unknown_phone' } });
    const w = await appWorld();
    await w.render(<HomeDashpal deps={n.deps} />);
    expect(await screen.findByTestId('home-dashpal-pair-title')).toHaveTextContent('Set up DashPal-C4D5 again?');
    expect(screen.getByTestId('home-dashpal-pair-subtitle')).toHaveTextContent('It doesn’t recognize this phone anymore.');
    await tap('home-dashpal-pair-open');
    expect(n.flow.starts).toEqual([{ again: true }]);
    expect(screen.getByTestId('wizard-sheet')).toBeOnTheScreen();
  });

  it.each([
    ['during a drive', { hidden: true }, {}],
    ['before the driver asked for DashPal', {}, { btOptIn: false }],
    ['while the paired DashPal is connected', {}, { link: { lifecycle: 'connected' as const, paired: PAIRED } }],
  ])('no card and no scan %s', async (_name, props, state) => {
    const n = nearby([NEW], state);
    const w = await appWorld();
    await w.render(<HomeDashpal deps={n.deps} {...props} />);
    await act(async () => {});
    expect(screen.queryByTestId('home-dashpal-pair')).toBeNull();
    expect(n.scans).toEqual([]);
  });

  it('Bluetooth not yet allowed: no scan and no prompt', async () => {
    const n = nearby([NEW]);
    n.deps.adapter = fakeAdapter();
    const w = await appWorld();
    await w.render(<HomeDashpal deps={n.deps} />);
    await act(async () => {});
    expect(n.scans).toEqual([]);
    expect(n.deps.adapter.log).toEqual(['bluetooth']);
  });

  it('RoadWise back in front with Home showing looks again (a minute after the last scan); sooner it does not', async () => {
    const hits: ScanHit[] = [NEW];
    const n = nearby(hits);
    const app = movingAppState();
    n.deps.appState = app;
    const w = await appWorld();
    await w.render(<HomeDashpal deps={n.deps} />);
    expect(await screen.findByTestId('home-dashpal-pair')).toBeOnTheScreen();
    expect(n.scans).toHaveLength(1);
    hits.length = 0;
    await app.to('background');
    await app.to('active');
    expect(n.scans).toHaveLength(1);
    expect(screen.getByTestId('home-dashpal-pair')).toBeOnTheScreen();
    n.clock.t += DETECT_EVERY_MS;
    await app.to('background');
    await app.to('active');
    await waitFor(() => expect(screen.queryByTestId('home-dashpal-pair')).toBeNull());
    expect(n.scans).toHaveLength(2);
  });

  it('RoadWise leaving the front stops a scan in progress, and what it heard offers no card', async () => {
    const n = nearby([NEW]);
    const app = movingAppState();
    n.deps.appState = app;
    let waiting: (() => void) | null = null;
    n.deps.sleep = (ms: number) =>
      new Promise<void>((resolve) => {
        waiting = () => {
          n.clock.t += ms;
          resolve();
        };
      });
    const w = await appWorld();
    await w.render(<HomeDashpal deps={n.deps} />);
    await waitFor(() => expect(waiting).not.toBeNull());
    expect(n.scans).toHaveLength(1);
    expect(n.stops.n).toBe(0);
    await app.to('background');
    expect(n.stops.n).toBe(1);
    await act(async () => waiting?.());
    await act(async () => {});
    expect(screen.queryByTestId('home-dashpal-pair')).toBeNull();
  });

  it('pull to refresh looks again (10 s after the last scan); a scan that no longer hears it takes the card down', async () => {
    const hits: ScanHit[] = [NEW];
    const n = nearby(hits);
    const w = await appWorld();
    function Pulling() {
      const [pulls, setPulls] = useState(0);
      return (
        <>
          <HomeDashpal deps={n.deps} pull={pulls} />
          <Pressable testID="pull" onPress={() => setPulls((k) => k + 1)} />
        </>
      );
    }
    await w.render(<Pulling />);
    expect(await screen.findByTestId('home-dashpal-pair')).toBeOnTheScreen();
    hits.length = 0;
    n.clock.t += DETECT_PULL_EVERY_MS;
    await tap('pull');
    await waitFor(() => expect(screen.queryByTestId('home-dashpal-pair')).toBeNull());
    expect(n.scans).toHaveLength(2);
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

  it('"Find my DashPal" opens the setup sheet in search mode (it opts in and asks there); a finished setup moves on, one closed before stays', async () => {
    setActiveDashcam(createFakeDashcamRuntime());
    const s = scriptedFlow();
    const onNext = jest.fn();
    const w = await appWorld();
    await w.render(<DashcamStep ctx={{ platform: 'android', hasUsername: true }} onNext={onNext} deps={{ adapter: fakeAdapter(), flow: s.make }} secrets={memSecrets().secrets} />);
    expect(screen.queryByTestId('wizard-sheet')).toBeNull();
    await tap('dashcam-find');
    expect(screen.getByTestId('wizard-sheet')).toBeOnTheScreen();
    expect(s.starts).toEqual([{}]);
    await s.to({ kind: 'unavailable' });
    await tap('wizard-close');
    expect(screen.queryByTestId('wizard-sheet')).toBeNull();
    expect(onNext).not.toHaveBeenCalled();
    await tap('dashcam-find');
    await s.to({ kind: 'done', paired: PAIRED, phones: 1, notAllYours: false, aimedElsewhere: false });
    await tap('wizard-done');
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

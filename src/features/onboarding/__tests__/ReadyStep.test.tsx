import { act, cleanup, fireEvent, screen, waitFor, within } from '@testing-library/react-native';

import { AUTO_RECORD_INTENT_KEY, type Readiness } from '@/core/permissions';
import { T0 } from '@/data/queries/__fixtures__/rows';
import {
  fakeAdapter,
  fakeAppState,
  fakeHost,
  permissionsWorld,
  snap,
  type FakeAdapter,
  type Seed,
} from '@/features/permissions/__fixtures__/harness';
import { clearQueryClients } from '@/features/trips/__fixtures__/render';

import type { GuardianLink } from '../api';
import { onboardingCopy } from '../copy';
import type { FlowContext } from '../flow';
import { AutoDetectStep } from '../steps/AutoDetectStep';
import { LocationStep } from '../steps/LocationStep';
import { MotionStep } from '../steps/MotionStep';
import { NotificationsStep } from '../steps/NotificationsStep';
import { readyRows, readyTip, ReadyStep } from '../steps/ReadyStep';
import { STEP_REGISTRY } from '../stepRegistry';

const mockRouter = { replace: jest.fn(), push: jest.fn() };
jest.mock('expo-router', () => ({ useRouter: () => mockRouter }));
const mockSession = {
  session: { user: { id: 'u1' } },
  profile: { driving_stage: 'new' },
  refreshProfile: jest.fn(async () => {}),
};
jest.mock('@/data/supabase/session', () => ({ useSession: () => mockSession }));
jest.mock('@/data/supabase/profile', () => ({ recordConsent: jest.fn(async () => ({})) }));
jest.mock('@/data/supabase/client', () => ({ supabase: {} }));

const copy = onboardingCopy.ready;

const ctx = (over: Partial<FlowContext> = {}): FlowContext => ({
  platform: 'android',
  ageBand: '18_plus',
  drivingStage: 'new',
  termsCurrent: true,
  termsPublished: false,
  minorConsentMode: 'guardian_link_optional',
  features: { autoDetect: true, guardianInvites: false },
  ...over,
});

const press = (el: Parameters<typeof fireEvent.press>[0]) =>
  act(async () => {
    fireEvent.press(el);
  });

afterEach(() => {
  clearQueryClients();
  mockRouter.replace.mockClear();
  mockRouter.push.mockClear();
});

async function renderStep(
  c: FlowContext,
  adapter: FakeAdapter,
  opts: {
    seed?: Seed;
    intent?: boolean;
    guardian?: () => Promise<GuardianLink>;
    finish?: jest.Mock;
  } = {}
) {
  const w = await permissionsWorld(opts.seed ?? {});
  const fh = fakeHost({ intent: opts.intent });
  const finish = opts.finish ?? jest.fn(async () => {});
  const readGuardianLink = jest.fn(opts.guardian ?? (async () => ({ status: 'none', expiresAt: null }) as GuardianLink));
  await w.render(
    <ReadyStep
      ctx={c}
      onNext={jest.fn()}
      deps={{ adapter, appState: fakeAppState(), now: () => T0, readGuardianLink, finish }}
    />,
    fh.host
  );
  return { ...w, finish, readGuardianLink };
}

const status = (id: string) => within(screen.getByTestId(`ready-row-${id}`));

describe('the tip follows readiness().armed', () => {
  test.each<[Readiness, string]>([
    [{ allowed: true, armed: true }, copy.tipArmed],
    [{ allowed: true, armed: false }, copy.tipManual],
    [{ allowed: false, armed: null }, copy.tipManual],
  ])('%j', async (readiness, tip) => {
    expect(readyTip(true, readiness)).toBe(tip);
    await renderStep(ctx(), fakeAdapter(snap(), { readiness }), { intent: true });
    expect(await screen.findByText(tip)).toBeOnTheScreen();
    const other = tip === copy.tipArmed ? copy.tipManual : copy.tipArmed;
    expect(screen.queryByText(other)).toBeNull();
  });

  test('the tips say the briefed words', () => {
    expect(copy.tipArmed).toBe("Next time you drive, just drive. We'll have a summary ready when you park.");
    expect(copy.tipManual).toBe("Tap Drive before you set off — we'll have a summary ready when you park.");
  });
});

test('rows come from the fresh snapshot: status in words, no Camera or Family rows', async () => {
  const adapter = fakeAdapter(
    snap({ location: 'foreground', motion: 'denied', notifications: 'provisional' }),
    { readiness: { allowed: false, armed: false } }
  );
  await renderStep(ctx(), adapter);
  await screen.findByTestId('ready-row-location');
  expect(status('location').getByText(copy.status.locationWhileUsing)).toBeOnTheScreen();
  expect(status('motion').getByText(copy.status.off)).toBeOnTheScreen();
  expect(status('notifications').getByText(copy.status.quiet)).toBeOnTheScreen();
  expect(status('autoRecord').getByText(copy.status.off)).toBeOnTheScreen();
  expect(screen.queryByTestId('ready-row-camera')).toBeNull();
  expect(screen.queryByTestId('ready-row-family')).toBeNull();
  expect(screen.queryByTestId('ready-row-guardian')).toBeNull();
  expect(adapter.log).toEqual(expect.arrayContaining(['snapshot', 'readiness']));
});

test('auto-record reads "On" only when armed', () => {
  const base = {
    drives: true,
    platform: 'android' as 'ios' | 'android',
    snapshot: snap(),
    autoDetectAvailable: true,
    autoDetectOn: true,
    intent: false,
    firstDriveDone: false,
    guardian: null,
  };
  const auto = (over: Partial<typeof base> & { readiness: Readiness }) =>
    readyRows({ ...base, ...over }).find((r) => r.id === 'autoRecord')!;
  expect(auto({ readiness: { allowed: true, armed: true } }).status).toBe(copy.status.armed);
  expect(auto({ readiness: { allowed: true, armed: false } }).status).toBe(copy.status.notArmed);
  expect(auto({ readiness: { allowed: false, armed: null } }).status).toBe(copy.status.cantCheck);
  expect(auto({ autoDetectOn: false, readiness: { allowed: true, armed: false } }).status).toBe(copy.status.off);
  expect(auto({ autoDetectAvailable: false, readiness: { allowed: true, armed: true } }).status).toBe(
    copy.status.notAvailable
  );
  expect(
    auto({
      platform: 'ios',
      snapshot: snap({ platform: 'ios', location: 'foreground' }),
      autoDetectOn: false,
      intent: true,
      readiness: { allowed: false, armed: false },
    }).status
  ).toBe(copy.status.afterFirstDrive);
});

test('an iPhone that asked for auto-record before its first drive is told when it turns on, and gets the tap tip', async () => {
  const adapter = fakeAdapter(snap({ platform: 'ios', location: 'foreground' }), {
    readiness: { allowed: false, armed: false },
  });
  await renderStep(ctx({ platform: 'ios' }), adapter, { seed: { settings: { [AUTO_RECORD_INTENT_KEY]: true } } });
  expect(await screen.findByText(copy.status.afterFirstDrive)).toBeOnTheScreen();
  expect(screen.getByText(copy.tipManual)).toBeOnTheScreen();
});

test('Go to Home finishes onboarding; Start a drive now finishes into the drive start', async () => {
  const { finish } = await renderStep(ctx(), fakeAdapter(snap()));
  await press(await screen.findByTestId('ready-home'));
  await waitFor(() => expect(finish).toHaveBeenCalledTimes(1));
  expect(finish.mock.calls[0][0]).toMatchObject({ userId: 'u1', router: mockRouter });
  expect(finish.mock.calls[0][1]).toEqual({ startDrive: false });

  // Unmount the first tree before its client is cleared: a mounted observer would re-arm a gc
  // timer on a client no longer tracked, and keep Jest from exiting (T14 review m3).
  await cleanup();
  clearQueryClients();
  const again = await renderStep(ctx(), fakeAdapter(snap()));
  await press(await screen.findByTestId('ready-start-drive'));
  await waitFor(() => expect(again.finish).toHaveBeenCalledWith(expect.anything(), { startDrive: true }));
});

test('a non-driver: no driving rows, no tip, no Start a drive — and Go to Home', async () => {
  const { finish } = await renderStep(ctx({ drivingStage: 'non_driver' }), fakeAdapter(snap()));
  expect(await screen.findByTestId('ready-row-notifications')).toBeOnTheScreen();
  expect(screen.queryByTestId('ready-row-location')).toBeNull();
  expect(screen.queryByTestId('ready-row-autoRecord')).toBeNull();
  expect(screen.queryByText(copy.tipArmed)).toBeNull();
  expect(screen.queryByText(copy.tipManual)).toBeNull();
  expect(screen.queryByTestId('ready-start-drive')).toBeNull();
  await press(screen.getByTestId('ready-home'));
  await waitFor(() => expect(finish).toHaveBeenCalledWith(expect.anything(), { startDrive: false }));
});

test('the guardian row only when that step ran', async () => {
  const guardian = async (): Promise<GuardianLink> => ({ status: 'pending', expiresAt: null });
  const off = await renderStep(ctx({ ageBand: '13_17' }), fakeAdapter(snap()), { guardian });
  await screen.findByTestId('ready-row-location');
  expect(screen.queryByTestId('ready-row-guardian')).toBeNull();
  expect(off.readGuardianLink).not.toHaveBeenCalled();

  // Unmount the first tree before its client is cleared: a mounted observer would re-arm a gc
  // timer on a client no longer tracked, and keep Jest from exiting (T14 review m3).
  await cleanup();
  clearQueryClients();
  const on = await renderStep(
    ctx({ ageBand: '13_17', features: { autoDetect: true, guardianInvites: true } }),
    fakeAdapter(snap()),
    { guardian }
  );
  expect(await screen.findByText(copy.status.guardianPending)).toBeOnTheScreen();
  expect(on.readGuardianLink).toHaveBeenCalledTimes(1);
});

test('a snapshot that cannot be read: an inline error with a retry, no made-up rows, and Home still works', async () => {
  const adapter = fakeAdapter(snap());
  adapter.failReads = true;
  const { finish } = await renderStep(ctx(), adapter);
  expect(await screen.findByTestId('ready-read-error')).toBeOnTheScreen();
  expect(screen.queryByTestId('ready-row-location')).toBeNull();
  adapter.failReads = false;
  await press(screen.getByText(copy.retry));
  expect(await screen.findByTestId('ready-row-location')).toBeOnTheScreen();
  await press(screen.getByTestId('ready-home'));
  await waitFor(() => expect(finish).toHaveBeenCalled());
});

test('a finish that fails says so and can be tried again', async () => {
  const finish = jest.fn(async () => {
    throw new Error('offline');
  });
  await renderStep(ctx(), fakeAdapter(snap()), { finish });
  await press(await screen.findByTestId('ready-home'));
  expect(await screen.findByText(copy.finishFailed)).toBeOnTheScreen();
  await press(screen.getByTestId('ready-home'));
  expect(finish).toHaveBeenCalledTimes(2);
});

test('the registry maps A6–A9 and A12 to these steps', () => {
  expect(STEP_REGISTRY.location).toBe(LocationStep);
  expect(STEP_REGISTRY.motion).toBe(MotionStep);
  expect(STEP_REGISTRY.notifications).toBe(NotificationsStep);
  expect(STEP_REGISTRY['auto-detect']).toBe(AutoDetectStep);
  expect(STEP_REGISTRY.ready).toBe(ReadyStep);
});

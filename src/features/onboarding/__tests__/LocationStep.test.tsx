import { act, cleanup, fireEvent, screen, waitFor } from '@testing-library/react-native';

import { DISCLOSURE_AFFIRMED_KEY, MANUAL_BY_CHOICE_KEY, PROMPTS_KEY } from '@/core/permissions';
import { T0 } from '@/data/queries/__fixtures__/rows';
import { DISCLOSURE_TEXT } from '@/features/drive/detectionCopy';
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

import { onboardingCopy } from '../copy';
import type { FlowContext } from '../flow';
import { PENDING_PERMISSION_CONSENTS_KEY, PERMISSION_CONSENT_VERSION } from '../state';
import { LocationStep } from '../steps/LocationStep';

const mockSession = { session: { user: { id: 'u1' } } as { user: { id: string } } | null, profile: { driving_stage: 'new' } };
const mockRecordConsent = jest.fn(async (_uid: string, _c: { type: string; version: string }) => ({}));
jest.mock('@/data/supabase/session', () => ({ useSession: () => mockSession }));
jest.mock('@/data/supabase/profile', () => ({
  recordConsent: (uid: string, c: { type: string; version: string }) => mockRecordConsent(uid, c),
}));

const copy = onboardingCopy.location;

const ctx = (platform: 'ios' | 'android', autoDetect = true): FlowContext => ({
  platform,
  ageBand: '18_plus',
  drivingStage: 'new',
  termsCurrent: true,
  termsPublished: false,
  minorConsentMode: 'guardian_link_optional',
  features: { autoDetect, guardianInvites: false },
});

const press = (el: Parameters<typeof fireEvent.press>[0]) =>
  act(async () => {
    fireEvent.press(el);
  });

/** Every OS request, in order (reads left out). */
const requests = (a: FakeAdapter) => a.log.filter((c) => c !== 'snapshot' && c !== 'readiness');

afterEach(() => {
  clearQueryClients();
  mockRecordConsent.mockReset();
  mockRecordConsent.mockImplementation(async () => ({}));
});

async function renderStep(platform: 'ios' | 'android', adapter: FakeAdapter, seed: Seed = {}, autoDetect = true) {
  const w = await permissionsWorld(seed);
  const onNext = jest.fn();
  const appState = fakeAppState();
  await w.render(
    <LocationStep ctx={ctx(platform, autoDetect)} onNext={onNext} deps={{ adapter, appState, now: () => T0 }} />,
    fakeHost().host
  );
  return { ...w, onNext, appState };
}

const consents = (type: string) => mockRecordConsent.mock.calls.filter(([, c]) => c.type === type);

test('the primer says the briefed words, and nothing is asked before the tap', async () => {
  const adapter = fakeAdapter(snap({ platform: 'ios', location: 'undetermined', precise: null }));
  await renderStep('ios', adapter);
  expect(await screen.findByText(copy.body)).toBeOnTheScreen();
  expect(screen.getByText("Only records while you're on a drive · Never sold")).toBeOnTheScreen();
  expect(copy.body).toBe('We use location to measure speed and distance during drives.');
  expect(requests(adapter)).toEqual([]);
});

describe('iOS', () => {
  test('one While Using request, consent on the grant, then on — never an Always request', async () => {
    const adapter = fakeAdapter(snap({ platform: 'ios', location: 'undetermined', precise: null }), {
      foreground: 'foreground',
    });
    const { onNext, settings } = await renderStep('ios', adapter);
    expect(await screen.findByText(copy.iosLater)).toBeOnTheScreen();
    adapter.current = { ...adapter.current, precise: null };
    await press(screen.getByTestId('location-allow'));
    await waitFor(() => expect(onNext).toHaveBeenCalledTimes(1));
    expect(requests(adapter)).toEqual(['requestLocationForeground']);
    expect(adapter.requestLocationAlways).not.toHaveBeenCalled();
    expect(screen.queryByText(DISCLOSURE_TEXT.heading)).toBeNull();
    expect(consents('location')).toEqual([['u1', { type: 'location', version: PERMISSION_CONSENT_VERSION }]]);
    // The driver's own tap: stamped so the app's own offers wait.
    expect(await settings.get(PROMPTS_KEY)).toEqual({ location: T0 });
  });

  test('with auto-record withdrawn, nothing is promised about after the first drive', async () => {
    const adapter = fakeAdapter(snap({ platform: 'ios', location: 'undetermined', precise: null }));
    await renderStep('ios', adapter, {}, false);
    expect(await screen.findByTestId('location-allow')).toBeOnTheScreen();
    expect(screen.queryByTestId('location-ios-later')).toBeNull();
    expect(screen.queryByText(copy.iosLater)).toBeNull();
  });

  test('the iOS line announces the Always question for after the first drive', () => {
    expect(copy.iosLater).toBe("After your first drive, we'll ask whether drives can start on their own.");
  });
});

describe('Android', () => {
  test('the disclosure follows the foreground grant at once, and Always is asked only after its Continue', async () => {
    const adapter = fakeAdapter(snap({ platform: 'android', location: 'undetermined', precise: null }), {
      foreground: 'foreground',
      always: 'always',
    });
    const { onNext } = await renderStep('android', adapter);
    await press(await screen.findByTestId('location-allow'));
    expect(await screen.findByText(DISCLOSURE_TEXT.heading)).toBeOnTheScreen();
    expect(screen.getByTestId('background-disclosure-onboarding')).toBeOnTheScreen();
    // The disclosure is showing: nothing more has been asked yet.
    expect(requests(adapter)).toEqual(['requestLocationForeground']);
    expect(onNext).not.toHaveBeenCalled();
    // No auto-record promise here: A9 is where auto-record is chosen.
    expect(screen.queryByTestId('disclosure-auto-record-note')).toBeNull();

    await press(await screen.findByTestId('disclosure-continue'));
    await waitFor(() => expect(onNext).toHaveBeenCalledTimes(1));
    expect(requests(adapter)).toEqual(['requestLocationForeground', 'requestLocationAlways:firstDriveDone=false']);
    expect(consents('location')).toHaveLength(1);
    expect(consents('background_location')).toHaveLength(1);
  });

  test('Not now on the disclosure moves on, asks nothing more and marks manual by choice', async () => {
    const adapter = fakeAdapter(snap({ platform: 'android', location: 'undetermined', precise: null }));
    const { onNext, settings } = await renderStep('android', adapter);
    await press(await screen.findByTestId('location-allow'));
    await press(await screen.findByTestId('disclosure-not-now'));
    await waitFor(() => expect(onNext).toHaveBeenCalledTimes(1));
    expect(requests(adapter)).toEqual(['requestLocationForeground']);
    expect(await settings.get(MANUAL_BY_CHOICE_KEY)).toBe(true);
  });

  test('already While Using when the step opens: the disclosure, unless it was already answered', async () => {
    const adapter = fakeAdapter(snap({ platform: 'android', location: 'foreground' }));
    await renderStep('android', adapter);
    expect(await screen.findByTestId('background-disclosure-onboarding')).toBeOnTheScreen();

    // Unmount the first tree before its client is cleared: a mounted observer would re-arm a gc
    // timer on a client no longer tracked, and keep Jest from exiting (T14 review m3).
    await cleanup();
    clearQueryClients();
    const again = fakeAdapter(snap({ platform: 'android', location: 'foreground' }));
    await renderStep('android', again, { settings: { [MANUAL_BY_CHOICE_KEY]: true } });
    expect(await screen.findByText(copy.allowed)).toBeOnTheScreen();
    expect(screen.queryByTestId('background-disclosure-onboarding')).toBeNull();
    expect(requests(again)).toEqual([]);
  });

  describe('an Always the phone already allows (Task 19 r1, security I-1)', () => {
    test('inherited from the previous owner: the disclosure, and its Continue records this account’s consent', async () => {
      const adapter = fakeAdapter(snap({ platform: 'android', location: 'always' }));
      const { settings } = await renderStep('android', adapter);
      expect(await screen.findByTestId('background-disclosure-onboarding')).toBeOnTheScreen();
      await press(await screen.findByTestId('disclosure-continue'));
      await waitFor(() => expect(consents('background_location')).toHaveLength(1));
      expect(consents('background_location')[0]?.[0]).toBe('u1');
      expect(await settings.get(DISCLOSURE_AFFIRMED_KEY)).toEqual({ version: 'pd-1', at: T0, uid: 'u1' });
    });

    test('affirmed by the previous owner: still this account’s disclosure', async () => {
      const adapter = fakeAdapter(snap({ platform: 'android', location: 'always' }));
      await renderStep('android', adapter, {
        settings: { [DISCLOSURE_AFFIRMED_KEY]: { version: 'pd-1', at: T0, uid: 'previous-owner' } },
      });
      expect(await screen.findByTestId('background-disclosure-onboarding')).toBeOnTheScreen();
    });

    test('affirmed by this account: no disclosure again', async () => {
      const adapter = fakeAdapter(snap({ platform: 'android', location: 'always' }));
      await renderStep('android', adapter, { affirmed: true });
      expect(await screen.findByText(copy.allowed)).toBeOnTheScreen();
      expect(screen.queryByTestId('background-disclosure-onboarding')).toBeNull();
    });

    test('iOS: no disclosure here (design §5.3); turning auto-record on is gated instead', async () => {
      const adapter = fakeAdapter(snap({ platform: 'ios', location: 'always' }));
      await renderStep('ios', adapter);
      expect(await screen.findByText(copy.allowed)).toBeOnTheScreen();
      expect(screen.queryByTestId('background-disclosure-onboarding')).toBeNull();
    });
  });
});

test('a denial records no consent, says so, and Continue still moves on (D12)', async () => {
  const adapter = fakeAdapter(snap({ platform: 'ios', location: 'undetermined', precise: null, locationCanAskAgain: true }), {
    foreground: 'denied',
  });
  adapter.requestLocationForeground = jest.fn(async () => {
    adapter.log.push('requestLocationForeground');
    adapter.current = { ...adapter.current, location: 'denied', locationCanAskAgain: false };
    return 'denied' as const;
  });
  const { onNext } = await renderStep('ios', adapter);
  await press(await screen.findByTestId('location-allow'));
  expect(await screen.findByText(copy.denied)).toBeOnTheScreen();
  expect(mockRecordConsent).not.toHaveBeenCalled();
  expect(screen.getByTestId('location-settings')).toBeOnTheScreen();
  await press(screen.getByTestId('location-continue'));
  expect(onNext).toHaveBeenCalledTimes(1);
  expect(requests(adapter)).toEqual(['requestLocationForeground']);
  expect(mockRecordConsent).not.toHaveBeenCalled();
});

test('Not now asks nothing and records nothing', async () => {
  const adapter = fakeAdapter(snap({ platform: 'android', location: 'undetermined', precise: null }));
  const { onNext } = await renderStep('android', adapter);
  await press(await screen.findByTestId('location-not-now'));
  expect(onNext).toHaveBeenCalledTimes(1);
  expect(requests(adapter)).toEqual([]);
  expect(mockRecordConsent).not.toHaveBeenCalled();
});

test('approximate location: said plainly, with Settings, and Continue moves on', async () => {
  const adapter = fakeAdapter(snap({ platform: 'ios', location: 'undetermined', precise: null }));
  adapter.requestLocationForeground = jest.fn(async () => {
    adapter.log.push('requestLocationForeground');
    adapter.current = { ...adapter.current, location: 'foreground', precise: false };
    return 'foreground' as const;
  });
  const { onNext } = await renderStep('ios', adapter);
  await press(await screen.findByTestId('location-allow'));
  expect(await screen.findByText(copy.approximate)).toBeOnTheScreen();
  expect(onNext).not.toHaveBeenCalled();
  await press(screen.getByTestId('location-settings'));
  expect(adapter.log).toContain('openAppSettings');
  await press(screen.getByTestId('location-continue'));
  expect(onNext).toHaveBeenCalledTimes(1);
  // Approximate is still a grant.
  expect(consents('location')).toHaveLength(1);
});

test('back from Settings with location on: the step shows it and records the consent on Continue', async () => {
  const adapter = fakeAdapter(snap({ platform: 'ios', location: 'denied', locationCanAskAgain: false, precise: null }));
  const { onNext, appState } = await renderStep('ios', adapter);
  expect(await screen.findByText(copy.denied)).toBeOnTheScreen();
  await press(screen.getByTestId('location-settings'));
  adapter.current = { ...adapter.current, location: 'foreground', precise: true };
  await act(async () => {
    appState.foreground();
  });
  expect(await screen.findByText(copy.allowed)).toBeOnTheScreen();
  expect(mockRecordConsent).not.toHaveBeenCalled();
  await press(screen.getByTestId('location-continue'));
  expect(onNext).toHaveBeenCalledTimes(1);
  expect(consents('location')).toHaveLength(1);
});

test('an offline consent is kept for the account and the step moves on', async () => {
  mockRecordConsent.mockImplementation(async () => {
    throw new Error('offline');
  });
  const adapter = fakeAdapter(snap({ platform: 'ios', location: 'undetermined', precise: null }));
  const { onNext, settings } = await renderStep('ios', adapter);
  await press(await screen.findByTestId('location-allow'));
  await waitFor(() => expect(onNext).toHaveBeenCalledTimes(1));
  expect(await settings.get(PENDING_PERMISSION_CONSENTS_KEY)).toEqual({ userId: 'u1', types: ['location'] });
});

test('a read failure says so with a retry, and the step is still passable', async () => {
  const adapter = fakeAdapter(snap({ platform: 'ios' }));
  adapter.failReads = true;
  const { onNext } = await renderStep('ios', adapter);
  expect(await screen.findByTestId('location-read-error')).toBeOnTheScreen();
  await press(screen.getByTestId('location-continue'));
  expect(onNext).toHaveBeenCalledTimes(1);
  expect(requests(adapter)).toEqual([]);
});

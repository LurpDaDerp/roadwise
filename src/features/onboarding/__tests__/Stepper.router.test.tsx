/**
 * The stepper under the real expo-router, with a screen pushed over it (review T11 I1).
 *
 * A screen presented over an onboarding step — Task 9's background disclosure, or a drive screen
 * when a drive starts mid-onboarding — owns the Android back button. The step's back listener and
 * its `start` resume must not act while covered: either would `router.replace` a route onboarding
 * is not showing, and on a drive route that is a reroute during a recording (I10).
 *
 * Android back is modelled as React Native dispatches it: listeners newest first, stopping at the
 * first that returns true. Every listener is captured, react-navigation's own included, so the
 * navigator pops the covering screen exactly as it would on a device.
 */
import { act, renderRouter, screen } from 'expo-router/testing-library';
import { Stack, useLocalSearchParams } from 'expo-router';
import { useSyncExternalStore } from 'react';
import { BackHandler, Text } from 'react-native';

import { createSettingsRepo, type SettingsRepo } from '@/data/db/settings';
import { createTestDb } from '@/data/queries/__fixtures__/harness';
import { ThemeProvider } from '@/ui/theme';

import type { FlowContext } from '../flow';
import { OnboardingStepper, resetSessionPlan } from '../Stepper';

// Task 12's real Terms, profile and block steps read the session, the config and the server; this
// suite is about the stepper's mechanics, so those three render the placeholder frame instead.
jest.mock('../steps/TermsStep', () => {
  const { PlaceholderStep } = jest.requireActual('../steps/PlaceholderStep');
  return { TermsStep: (p: object) => <PlaceholderStep {...p} step="terms" /> };
});
jest.mock('../steps/ProfileStep', () => {
  const { PlaceholderStep } = jest.requireActual('../steps/PlaceholderStep');
  return { ProfileStep: (p: object) => <PlaceholderStep {...p} step="profile" /> };
});
jest.mock('../steps/NotEligibleStep', () => {
  const { PlaceholderStep } = jest.requireActual('../steps/PlaceholderStep');
  return { NotEligibleStep: (p: object) => <PlaceholderStep {...p} step="not-eligible" /> };
});

const ADULT: FlowContext = {
  platform: 'android',
  ageBand: '18_plus',
  drivingStage: 'new',
  termsCurrent: true,
  termsPublished: true,
  minorConsentMode: 'guardian_link_optional',
  features: { autoDetect: true, guardianInvites: false },
};

/** The flow context as an external store, so a test can change it while a screen covers the step. */
let currentCtx: FlowContext | null = ADULT;
const ctxListeners = new Set<() => void>();
async function setCtx(next: FlowContext | null) {
  currentCtx = next;
  await act(async () => {
    for (const fn of ctxListeners) fn();
  });
}
function useCtx() {
  return useSyncExternalStore(
    (fn) => {
      ctxListeners.add(fn);
      return () => ctxListeners.delete(fn);
    },
    () => currentCtx
  );
}

let settings: SettingsRepo;

function StepRoute() {
  const { step } = useLocalSearchParams<{ step: string }>();
  return <OnboardingStepper step={step} ctx={useCtx()} settings={settings} />;
}

const routes = {
  _layout: () => (
    <ThemeProvider scheme="light">
      <Stack screenOptions={{ headerShown: false }} />
    </ThemeProvider>
  ),
  '(onboarding)/_layout': () => <Stack screenOptions={{ headerShown: false }} />,
  '(onboarding)/[step]': StepRoute,
  cover: () => <Text>cover</Text>,
};

type BackListener = Parameters<typeof BackHandler.addEventListener>[1];
let backListeners: BackListener[] = [];

/** One Android back press: newest listener first, until one handles it. */
async function pressBack() {
  await act(async () => {
    for (const handler of [...backListeners].reverse()) {
      // The handlers here never read the event; React Native passes one, so the call does too.
      if (handler({} as Parameters<BackListener>[0])) return;
    }
  });
}

async function push(href: string) {
  const { router } = jest.requireActual<typeof import('expo-router')>('expo-router');
  await act(async () => {
    router.push(href as never);
  });
}

async function back() {
  const { router } = jest.requireActual<typeof import('expo-router')>('expo-router');
  await act(async () => {
    router.back();
  });
}

beforeEach(async () => {
  settings = createSettingsRepo(await createTestDb());
  currentCtx = ADULT;
  resetSessionPlan();
  backListeners = [];
  jest.spyOn(BackHandler, 'addEventListener').mockImplementation((_event, handler) => {
    backListeners.push(handler);
    return {
      remove: () => {
        backListeners = backListeners.filter((h) => h !== handler);
      },
    };
  });
});

afterEach(() => {
  jest.restoreAllMocks();
});

describe('the stepper under a covering screen', () => {
  test('control: with the step focused, Android back is the step’s Back', async () => {
    const app = renderRouter(routes, { initialUrl: '/motion' });
    await app;
    expect(app.getPathname()).toBe('/motion');

    await pressBack();

    expect(app.getPathname()).toBe('/location');
  });

  test('with a screen pushed over the step, Android back pops that screen and nothing else', async () => {
    const app = renderRouter(routes, { initialUrl: '/motion' });
    await app;
    await push('/cover');
    expect(app.getPathname()).toBe('/cover');

    await pressBack();

    // The navigator popped the cover; the step did not replace anything to reach `location`.
    expect(app.getPathname()).toBe('/motion');
    expect(screen.getByRole('header', { name: 'Motion' })).toBeTruthy();
  });

  test('a context change under the cover does not bring the step’s listener back to life', async () => {
    const app = renderRouter(routes, { initialUrl: '/ready' });
    await app;
    await push('/cover');
    // A profile or config refresh while covered changes where Back goes (auto-detect leaves the
    // flow, so Back from ready becomes notifications): a plain effect would re-subscribe here and
    // become the newest listener, ahead of the navigator's.
    await setCtx({ ...ADULT, features: { autoDetect: false, guardianInvites: false } });

    await pressBack();

    expect(app.getPathname()).toBe('/ready');
  });

  test('control: after that change, with the step focused again, Back follows the new flow', async () => {
    const app = renderRouter(routes, { initialUrl: '/ready' });
    await app;
    await push('/cover');
    await setCtx({ ...ADULT, features: { autoDetect: false, guardianInvites: false } });
    await back();

    await pressBack();

    expect(app.getPathname()).toBe('/notifications');
  });

  test('control: start resumes at once while it is focused', async () => {
    const app = renderRouter(routes, { initialUrl: '/start' });
    await app;
    await act(async () => {});

    expect(app.getPathname()).toBe('/location');
  });

  test('start does not resume under a covering screen, and resumes once it is focused again', async () => {
    currentCtx = null; // the profile is still loading
    const app = renderRouter(routes, { initialUrl: '/start' });
    await app;
    await push('/cover');

    await setCtx(ADULT);
    await act(async () => {});
    expect(app.getPathname()).toBe('/cover');

    await back();
    await act(async () => {});
    expect(app.getPathname()).toBe('/location');
  });
});

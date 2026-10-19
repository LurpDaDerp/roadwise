import { act, fireEvent, screen, waitFor } from '@testing-library/react-native';

import { PROMPTS_KEY } from '@/core/permissions';
import {
  fakeAdapter,
  fakeAppState,
  fakeHost,
  T0,
  appWorld,
  clearQueryClients,
  snap,
  type FakeAdapter,
} from '@/features/permissions/__fixtures__/harness';

import { onboardingCopy } from '../copy';
import type { FlowContext } from '../flow';
import { LocationStep } from '../steps/LocationStep';

const mockSession = { session: { user: { id: 'u1' } }, profile: { username: 'swift_fox' } };
jest.mock('@/data/supabase/client', () => ({ supabase: {} }));
jest.mock('@/data/supabase/session', () => ({ useSession: () => mockSession }));

const copy = onboardingCopy.location;

const ctx = (platform: 'ios' | 'android'): FlowContext => ({ platform, hasUsername: true });

const press = (el: Parameters<typeof fireEvent.press>[0]) =>
  act(async () => {
    fireEvent.press(el);
  });

/** Every OS request, in order (reads left out). */
const requests = (a: FakeAdapter) => a.log.filter((c) => c !== 'snapshot' && c !== 'readiness');

afterEach(() => {
  clearQueryClients();
});

async function renderStep(platform: 'ios' | 'android', adapter: FakeAdapter) {
  const w = await appWorld();
  const onNext = jest.fn();
  const appState = fakeAppState();
  await w.render(
    <LocationStep ctx={ctx(platform)} onNext={onNext} deps={{ adapter, appState, now: () => T0 }} />,
    fakeHost().host
  );
  return { ...w, onNext, appState };
}

test('the primer says why in plain words, and nothing is asked before the tap', async () => {
  const adapter = fakeAdapter(snap({ platform: 'ios', location: 'undetermined', precise: null }));
  await renderStep('ios', adapter);
  expect(await screen.findByText(copy.body)).toBeOnTheScreen();
  expect(copy.body).toBe('RoadWise uses precise location on drives you start, and to check local weather.');
  expect(requests(adapter)).toEqual([]);
});

test.each(['ios', 'android'] as const)(
  '%s: one While Using request on the tap, then on — never a background (Always) request',
  async (platform) => {
    const adapter = fakeAdapter(snap({ platform, location: 'undetermined', precise: null }), {
      foreground: 'foreground',
    });
    const { onNext, settings } = await renderStep(platform, adapter);
    await press(await screen.findByTestId('location-allow'));
    await waitFor(() => expect(onNext).toHaveBeenCalledTimes(1));
    expect(requests(adapter)).toEqual(['requestLocationForeground']);
    // While Using only (plan §1 decision 4): nothing that asks for background location, ever.
    expect(adapter.log.some((c) => /always|background/i.test(c))).toBe(false);
    // The driver's own tap: stamped so the app's own offers wait.
    expect(await settings.get(PROMPTS_KEY)).toEqual({ location: T0 });
  }
);

test('a denial says so, and Continue still moves on (D12)', async () => {
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
  expect(screen.getByTestId('location-settings')).toBeOnTheScreen();
  await press(screen.getByTestId('location-continue'));
  expect(onNext).toHaveBeenCalledTimes(1);
  expect(requests(adapter)).toEqual(['requestLocationForeground']);
});

test('Not now asks nothing', async () => {
  const adapter = fakeAdapter(snap({ platform: 'android', location: 'undetermined', precise: null }));
  const { onNext } = await renderStep('android', adapter);
  await press(await screen.findByTestId('location-not-now'));
  expect(onNext).toHaveBeenCalledTimes(1);
  expect(requests(adapter)).toEqual([]);
});

test('already allowed on Android: no disclosure and no further request; Continue moves on', async () => {
  const adapter = fakeAdapter(snap({ platform: 'android', location: 'foreground', precise: true }));
  const { onNext } = await renderStep('android', adapter);
  expect(await screen.findByText(copy.allowed)).toBeOnTheScreen();
  await press(screen.getByTestId('location-continue'));
  expect(onNext).toHaveBeenCalledTimes(1);
  expect(requests(adapter)).toEqual([]);
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
  expect(copy.approximate).toBe("Location is set to approximate, so drives can't record. Turn on Precise Location in Settings.");
  expect(onNext).not.toHaveBeenCalled();
  await press(screen.getByTestId('location-settings'));
  expect(adapter.log).toContain('openAppSettings');
  await press(screen.getByTestId('location-continue'));
  expect(onNext).toHaveBeenCalledTimes(1);
});

test('back from Settings with location on: the step shows it', async () => {
  const adapter = fakeAdapter(snap({ platform: 'ios', location: 'denied', locationCanAskAgain: false, precise: null }));
  const { onNext, appState } = await renderStep('ios', adapter);
  expect(await screen.findByText(copy.denied)).toBeOnTheScreen();
  await press(screen.getByTestId('location-settings'));
  adapter.current = { ...adapter.current, location: 'foreground', precise: true };
  await act(async () => {
    appState.foreground();
  });
  expect(await screen.findByText(copy.allowed)).toBeOnTheScreen();
  await press(screen.getByTestId('location-continue'));
  expect(onNext).toHaveBeenCalledTimes(1);
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

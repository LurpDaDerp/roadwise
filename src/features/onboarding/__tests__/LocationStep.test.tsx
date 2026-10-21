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

const ios = onboardingCopy.location.ios;
const android = onboardingCopy.location.android;

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

test('iPhone: the primer says why and that the phone asks twice, and nothing is asked before the tap', async () => {
  const adapter = fakeAdapter(snap({ platform: 'ios', location: 'undetermined', precise: null }));
  await renderStep('ios', adapter);
  expect(await screen.findByText(ios.body)).toBeOnTheScreen();
  expect(screen.getByText(ios.title)).toBeOnTheScreen();
  expect(screen.getByTestId('location-twice')).toHaveTextContent('Your iPhone asks twice. Choose “Allow While Using App”, then “Change to Always Allow”.');
  expect(requests(adapter)).toEqual([]);
});

test('Android: the primer speaks of the drives you start, with no talk of asking twice', async () => {
  const adapter = fakeAdapter(snap({ platform: 'android', location: 'undetermined', precise: null }));
  await renderStep('android', adapter);
  expect(await screen.findByText(android.body)).toBeOnTheScreen();
  expect(android.body).toBe('RoadWise uses precise location on drives you start, and to check local weather.');
  expect(screen.queryByTestId('location-twice')).toBeNull();
});

test('iPhone: one tap asks While Using, then Always, and moves on once Always is held', async () => {
  const adapter = fakeAdapter(snap({ platform: 'ios', location: 'undetermined', precise: null }), { foreground: 'foreground' });
  const { onNext, settings } = await renderStep('ios', adapter);
  await press(await screen.findByTestId('location-allow'));
  await waitFor(() => expect(onNext).toHaveBeenCalledTimes(1));
  expect(requests(adapter)).toEqual(['requestLocationForeground', 'requestLocationAlways']);
  // The driver's own tap: stamped so the app's own offers wait.
  expect(await settings.get(PROMPTS_KEY)).toEqual({ location: T0 });
});

test('iPhone: kept at While Using, the step says what that means, with Settings and Continue', async () => {
  const adapter = fakeAdapter(snap({ platform: 'ios', location: 'undetermined', precise: null }), {
    foreground: 'foreground',
    always: 'whenInUse',
  });
  const { onNext } = await renderStep('ios', adapter);
  await press(await screen.findByTestId('location-allow'));
  expect(await screen.findByText(ios.whileUsing)).toBeOnTheScreen();
  expect(onNext).not.toHaveBeenCalled();
  await press(screen.getByTestId('location-settings'));
  expect(adapter.log).toContain('openAppSettings');
  await press(screen.getByTestId('location-continue'));
  expect(onNext).toHaveBeenCalledTimes(1);
});

test('iPhone: already While Using with Always still to ask, the tap asks only for Always', async () => {
  const adapter = fakeAdapter(snap({ platform: 'ios', location: 'foreground', precise: true, canAskAlways: true }));
  const { onNext } = await renderStep('ios', adapter);
  await press(await screen.findByTestId('location-allow'));
  await waitFor(() => expect(onNext).toHaveBeenCalledTimes(1));
  expect(requests(adapter)).toEqual(['requestLocationForeground', 'requestLocationAlways']);
});

test('iPhone: Always already held shows the all-set line and asks nothing', async () => {
  const adapter = fakeAdapter(snap({ platform: 'ios', location: 'always', precise: true }));
  const { onNext } = await renderStep('ios', adapter);
  expect(await screen.findByText(ios.always)).toBeOnTheScreen();
  await press(screen.getByTestId('location-continue'));
  expect(onNext).toHaveBeenCalledTimes(1);
  expect(requests(adapter)).toEqual([]);
});

test('Android: one While Using request on the tap, then on; never an Always request', async () => {
  const adapter = fakeAdapter(snap({ platform: 'android', location: 'undetermined', precise: null }), { foreground: 'foreground' });
  const { onNext } = await renderStep('android', adapter);
  await press(await screen.findByTestId('location-allow'));
  await waitFor(() => expect(onNext).toHaveBeenCalledTimes(1));
  expect(requests(adapter)).toEqual(['requestLocationForeground']);
  expect(adapter.log.some((c) => /always|background/i.test(c))).toBe(false);
});

test('a denial says so, asks no Always, and Continue still moves on (D12)', async () => {
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
  expect(await screen.findByText(ios.denied)).toBeOnTheScreen();
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

test('already allowed on Android: no further request; Continue moves on', async () => {
  const adapter = fakeAdapter(snap({ platform: 'android', location: 'foreground', precise: true }));
  const { onNext } = await renderStep('android', adapter);
  expect(await screen.findByText(android.allowed)).toBeOnTheScreen();
  await press(screen.getByTestId('location-continue'));
  expect(onNext).toHaveBeenCalledTimes(1);
  expect(requests(adapter)).toEqual([]);
});

test('approximate location: said plainly, never asked for Always, with Settings, and Continue moves on', async () => {
  const adapter = fakeAdapter(snap({ platform: 'ios', location: 'undetermined', precise: null }));
  adapter.requestLocationForeground = jest.fn(async () => {
    adapter.log.push('requestLocationForeground');
    adapter.current = { ...adapter.current, location: 'foreground', precise: false };
    return 'foreground' as const;
  });
  const { onNext } = await renderStep('ios', adapter);
  await press(await screen.findByTestId('location-allow'));
  expect(await screen.findByText(ios.approximate)).toBeOnTheScreen();
  expect(ios.approximate).toBe('Location is set to approximate, so drives can’t record. Turn on Precise Location in Settings.');
  expect(requests(adapter)).toEqual(['requestLocationForeground']);
  expect(onNext).not.toHaveBeenCalled();
  await press(screen.getByTestId('location-settings'));
  expect(adapter.log).toContain('openAppSettings');
  await press(screen.getByTestId('location-continue'));
  expect(onNext).toHaveBeenCalledTimes(1);
});

test('back from Settings with location on Always: the step shows it', async () => {
  const adapter = fakeAdapter(snap({ platform: 'ios', location: 'denied', locationCanAskAgain: false, precise: null }));
  const { onNext, appState } = await renderStep('ios', adapter);
  expect(await screen.findByText(ios.denied)).toBeOnTheScreen();
  await press(screen.getByTestId('location-settings'));
  adapter.current = { ...adapter.current, location: 'always', precise: true };
  await act(async () => {
    appState.foreground();
  });
  expect(await screen.findByText(ios.always)).toBeOnTheScreen();
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

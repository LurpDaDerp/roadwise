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

async function renderStep(platform: 'ios' | 'android', adapter: FakeAdapter, api: number | null = platform === 'android' ? 34 : null) {
  const w = await appWorld();
  const onNext = jest.fn();
  const appState = fakeAppState();
  await w.render(
    <LocationStep ctx={ctx(platform)} onNext={onNext} deps={{ adapter, appState, now: () => T0 }} api={api} />,
    fakeHost().host
  );
  return { ...w, onNext, appState };
}

test('iPhone: the primer says why and that the phone asks twice, and nothing is asked before the tap', async () => {
  const adapter = fakeAdapter(snap({ platform: 'ios', location: 'undetermined', precise: null }));
  await renderStep('ios', adapter);
  expect(await screen.findByText(ios.body)).toBeOnTheScreen();
  expect(screen.getByText(ios.title)).toBeOnTheScreen();
  expect(screen.getByTestId('location-twice')).toHaveTextContent('Your iPhone asks twice. Choose "Allow While Using App", then "Change to Always Allow".');
  expect(requests(adapter)).toEqual([]);
});

test('Android: the primer says why and that the phone asks twice, in its own words, and nothing is asked before the tap', async () => {
  const adapter = fakeAdapter(snap({ platform: 'android', location: 'undetermined', precise: null, canAskAlways: false }));
  await renderStep('android', adapter);
  expect(await screen.findByText(android.body)).toBeOnTheScreen();
  expect(screen.getByText(android.title)).toBeOnTheScreen();
  expect(screen.getByTestId('location-twice')).toHaveTextContent('Your phone asks twice. Choose "While using the app", then "Allow all the time".');
  expect(requests(adapter)).toEqual([]);
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

test("Android: While Using, then Google Play's disclosure, then Allow all the time on Continue, and on once it is held", async () => {
  const adapter = fakeAdapter(snap({ platform: 'android', location: 'undetermined', precise: null, canAskAlways: false }), { foreground: 'foreground' });
  const { onNext, settings } = await renderStep('android', adapter);
  await press(await screen.findByTestId('location-allow'));
  // The disclosure stands between the two requests: nothing more is asked until Continue.
  expect(await screen.findByTestId('background-disclosure-body')).toHaveTextContent(
    'RoadWise collects location data to detect and record your drives automatically, even when the app is closed or not in use.'
  );
  expect(requests(adapter)).toEqual(['requestLocationForeground']);
  expect(onNext).not.toHaveBeenCalled();
  await press(screen.getByTestId('background-disclosure-continue'));
  await waitFor(() => expect(onNext).toHaveBeenCalledTimes(1));
  expect(requests(adapter)).toEqual(['requestLocationForeground', 'requestLocationAlways:disclosed']);
  expect(await settings.get(PROMPTS_KEY)).toEqual({ location: T0 });
});

test('Android: Not now on the disclosure keeps While Using, says what that means, and offers Allow all the time again (the disclosure first)', async () => {
  const adapter = fakeAdapter(snap({ platform: 'android', location: 'undetermined', precise: null, canAskAlways: false }), { foreground: 'foreground' });
  const { onNext } = await renderStep('android', adapter);
  await press(await screen.findByTestId('location-allow'));
  await press(await screen.findByTestId('background-disclosure-not-now'));
  expect(await screen.findByText(android.whileUsing)).toBeOnTheScreen();
  expect(requests(adapter)).toEqual(['requestLocationForeground']);
  expect(screen.queryByTestId('location-settings')).toBeNull();
  await press(screen.getByTestId('location-allow-always'));
  expect(await screen.findByTestId('background-disclosure-body')).toBeOnTheScreen();
  expect(requests(adapter)).toEqual(['requestLocationForeground']);
  await press(screen.getByTestId('background-disclosure-continue'));
  await waitFor(() => expect(onNext).toHaveBeenCalledTimes(1));
  expect(requests(adapter)).toEqual(['requestLocationForeground', 'requestLocationAlways:disclosed']);
});

test('Android: kept at While Using after the request (back from its settings page), Continue still moves on', async () => {
  const adapter = fakeAdapter(snap({ platform: 'android', location: 'undetermined', precise: null, canAskAlways: false }), { foreground: 'foreground', always: 'whenInUse' });
  const { onNext, appState } = await renderStep('android', adapter);
  await press(await screen.findByTestId('location-allow'));
  await press(await screen.findByTestId('background-disclosure-continue'));
  expect(await screen.findByText(android.whileUsing)).toBeOnTheScreen();
  expect(onNext).not.toHaveBeenCalled();
  // Allow all the time chosen on the settings page later: read again on the way back.
  adapter.current = { ...adapter.current, location: 'always' };
  await act(async () => {
    appState.foreground();
  });
  expect(await screen.findByText(android.always)).toBeOnTheScreen();
  await press(screen.getByTestId('location-continue'));
  expect(onNext).toHaveBeenCalledTimes(1);
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

test('Android: already allowed all the time shows the all-set line and asks nothing', async () => {
  const adapter = fakeAdapter(snap({ platform: 'android', location: 'always', precise: true, canAskAlways: false }));
  const { onNext } = await renderStep('android', adapter);
  expect(await screen.findByText(android.always)).toBeOnTheScreen();
  await press(screen.getByTestId('location-continue'));
  expect(onNext).toHaveBeenCalledTimes(1);
  expect(requests(adapter)).toEqual([]);
});

test('Android: approximate location is never asked for Allow all the time and shows no disclosure', async () => {
  const adapter = fakeAdapter(snap({ platform: 'android', location: 'undetermined', precise: null }));
  adapter.requestLocationForeground = jest.fn(async () => {
    adapter.log.push('requestLocationForeground');
    adapter.current = { ...adapter.current, location: 'foreground', precise: false };
    return 'foreground' as const;
  });
  await renderStep('android', adapter);
  await press(await screen.findByTestId('location-allow'));
  expect(await screen.findByText(android.approximate)).toBeOnTheScreen();
  expect(screen.queryByTestId('background-disclosure-body')).toBeNull();
  expect(requests(adapter)).toEqual(['requestLocationForeground']);
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
  expect(ios.approximate).toBe('Location is set to approximate, so drives can\'t record. Turn on Precise Location in Settings.');
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

describe('Android without the drive detector (no automatic drives): While Using is all the step asks', () => {
  it('one tap asks While Using only, shows no disclosure, and moves on', async () => {
    const adapter = fakeAdapter(snap({ platform: 'android', location: 'undetermined', precise: null, canAskAlways: null }), { foreground: 'foreground' });
    const { onNext } = await renderStep('android', adapter);
    expect(await screen.findByTestId('location-allow')).toBeOnTheScreen();
    // "Your phone asks twice" is not true here.
    expect(screen.queryByTestId('location-twice')).toBeNull();
    await press(screen.getByTestId('location-allow'));
    await waitFor(() => expect(onNext).toHaveBeenCalledTimes(1));
    expect(screen.queryByTestId('background-disclosure-body')).toBeNull();
    expect(requests(adapter)).toEqual(['requestLocationForeground']);
  });

  it('already While Using: says location is allowed, with no Allow all the time button', async () => {
    const adapter = fakeAdapter(snap({ platform: 'android', location: 'foreground', precise: true, canAskAlways: null }));
    const { onNext } = await renderStep('android', adapter);
    expect(await screen.findByText(android.allowed)).toBeOnTheScreen();
    expect(screen.queryByTestId('location-allow-always')).toBeNull();
    expect(screen.queryByText(android.whileUsing)).toBeNull();
    await press(screen.getByTestId('location-continue'));
    expect(onNext).toHaveBeenCalledTimes(1);
    expect(requests(adapter)).toEqual([]);
  });
});

describe('Android 9 and lower: allowing location allows it in the background too', () => {
  it("with the drive detector, Google Play's disclosure comes before the one request, naming the dialog's Allow", async () => {
    const adapter = fakeAdapter(snap({ platform: 'android', location: 'undetermined', precise: null, canAskAlways: false }), { foreground: 'always' });
    const { onNext, settings } = await renderStep('android', adapter, 28);
    await screen.findByTestId('location-allow');
    expect(screen.queryByTestId('location-twice')).toBeNull();
    await press(screen.getByTestId('location-allow'));
    expect(await screen.findByTestId('background-disclosure-body')).toBeOnTheScreen();
    expect(screen.getByTestId('background-disclosure-next')).toHaveTextContent('Next, choose "Allow".');
    // Nothing is asked before Continue.
    expect(requests(adapter)).toEqual([]);
    await press(screen.getByTestId('background-disclosure-continue'));
    await waitFor(() => expect(onNext).toHaveBeenCalledTimes(1));
    expect(requests(adapter)).toEqual(['requestLocationForeground']);
    expect(await settings.get(PROMPTS_KEY)).toEqual({ location: T0 });
  });

  it('Not now on the disclosure asks nothing and stays on the step', async () => {
    const adapter = fakeAdapter(snap({ platform: 'android', location: 'undetermined', precise: null, canAskAlways: false }), { foreground: 'always' });
    const { onNext, settings } = await renderStep('android', adapter, 28);
    await press(await screen.findByTestId('location-allow'));
    await press(await screen.findByTestId('background-disclosure-not-now'));
    expect(requests(adapter)).toEqual([]);
    expect(onNext).not.toHaveBeenCalled();
    expect(await settings.get(PROMPTS_KEY)).toBeNull();
    expect(screen.getByTestId('location-allow')).toBeOnTheScreen();
  });

  it('without the drive detector nothing runs in the background, so no disclosure', async () => {
    const adapter = fakeAdapter(snap({ platform: 'android', location: 'undetermined', precise: null, canAskAlways: null }), { foreground: 'always' });
    const { onNext } = await renderStep('android', adapter, 28);
    await press(await screen.findByTestId('location-allow'));
    await waitFor(() => expect(onNext).toHaveBeenCalledTimes(1));
    expect(screen.queryByTestId('background-disclosure-body')).toBeNull();
    expect(requests(adapter)).toEqual(['requestLocationForeground']);
  });
});

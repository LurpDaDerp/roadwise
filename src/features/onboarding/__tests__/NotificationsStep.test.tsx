import { act, fireEvent, screen, waitFor } from '@testing-library/react-native';
import { AccessibilityInfo } from 'react-native';

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
import { NotificationsStep } from '../steps/NotificationsStep';

const mockSession = { session: { user: { id: 'u1' } }, profile: { driving_stage: 'new' } };
jest.mock('@/data/supabase/client', () => ({ supabase: {} }));
jest.mock('@/data/supabase/session', () => ({ useSession: () => mockSession }));

const copy = onboardingCopy.notifications;

const ctx = (platform: 'ios' | 'android'): FlowContext => ({ platform, hasUsername: true });

const press = (el: Parameters<typeof fireEvent.press>[0]) =>
  act(async () => {
    fireEvent.press(el);
  });

afterEach(() => {
  clearQueryClients();
});

async function renderStep(
  platform: 'ios' | 'android',
  adapter: FakeAdapter,
  log: string[] = adapter.log
) {
  const w = await appWorld();
  const onNext = jest.fn();
  const ensureChannels = jest.fn(async () => {
    log.push('ensureChannels');
  });
  const requestDeviceSync = jest.fn(() => {
    log.push('requestDeviceSync');
  });
  await w.render(
    <NotificationsStep
      ctx={ctx(platform)}
      onNext={onNext}
      deps={{ adapter, appState: fakeAppState(), now: () => T0, ensureChannels, requestDeviceSync }}
    />,
    fakeHost().host
  );
  return { ...w, onNext, ensureChannels, requestDeviceSync };
}

test('the examples are pushes the server sends, worded as the server words them', async () => {
  expect(copy.previews.map((p) => p.id)).toEqual(['drive_recap', 'weekly_recap', 'friend_request']);
  await renderStep('ios', fakeAdapter(snap({ platform: 'ios', notifications: 'undetermined' })));
  expect(await screen.findByText('Your drive recap is ready')).toBeOnTheScreen();
  expect(screen.getByText('24 min · 12.0 mi. See how it went.')).toBeOnTheScreen();
  expect(screen.getByText('Your week on the road')).toBeOnTheScreen();
  expect(screen.getByText('4 drives this week. Safety Rating 92, up 1. 2 of 3 weekly goals done.')).toBeOnTheScreen();
  expect(screen.queryByText(/league|points|streak/i)).toBeNull();
  expect(screen.getByText('Someone wants to add you as a friend.')).toBeOnTheScreen();
});

test('Android: the channels exist before the one request; grant → consent → device sync → on', async () => {
  const adapter = fakeAdapter(snap({ platform: 'android', notifications: 'undetermined' }));
  const { onNext, settings } = await renderStep('android', adapter);
  await press(await screen.findByTestId('notifications-allow'));
  await waitFor(() => expect(onNext).toHaveBeenCalledTimes(1));
  const order = adapter.log.filter((c) => c !== 'snapshot');
  expect(order).toEqual(['ensureChannels', 'requestNotifications', 'requestDeviceSync']);
  expect(await settings.get(PROMPTS_KEY)).toEqual({ notifications: T0 });
});

test('iOS: no channels; one request', async () => {
  const adapter = fakeAdapter(snap({ platform: 'ios', notifications: 'undetermined' }));
  const { onNext, ensureChannels } = await renderStep('ios', adapter);
  await press(await screen.findByTestId('notifications-allow'));
  await waitFor(() => expect(onNext).toHaveBeenCalledTimes(1));
  expect(ensureChannels).not.toHaveBeenCalled();
  expect(adapter.log.filter((c) => c !== 'snapshot')).toEqual(['requestNotifications', 'requestDeviceSync']);
});

test('a channel failure does not hold the request back', async () => {
  const adapter = fakeAdapter(snap({ platform: 'android', notifications: 'undetermined' }));
  const w = await appWorld();
  const onNext = jest.fn();
  await w.render(
    <NotificationsStep
      ctx={ctx('android')}
      onNext={onNext}
      deps={{
        adapter,
        appState: fakeAppState(),
        now: () => T0,
        ensureChannels: async () => {
          throw new Error('no channel');
        },
        requestDeviceSync: () => {},
      }}
    />,
    fakeHost().host
  );
  await press(await screen.findByTestId('notifications-allow'));
  await waitFor(() => expect(onNext).toHaveBeenCalledTimes(1));
  expect(adapter.requestNotifications).toHaveBeenCalledTimes(1);
});

test('denied: no sync, said plainly, and Continue moves on (D12)', async () => {
  const adapter = fakeAdapter(snap({ platform: 'ios', notifications: 'undetermined' }));
  adapter.requestNotifications = jest.fn(async () => {
    adapter.log.push('requestNotifications');
    return 'denied' as const;
  });
  const { onNext, requestDeviceSync } = await renderStep('ios', adapter);
  await press(await screen.findByTestId('notifications-allow'));
  expect(await screen.findByText(copy.denied)).toBeOnTheScreen();
  expect(requestDeviceSync).not.toHaveBeenCalled();
  await press(screen.getByTestId('notifications-continue'));
  expect(onNext).toHaveBeenCalledTimes(1);
});

test('Android: Not now asks nothing', async () => {
  const adapter = fakeAdapter(snap({ platform: 'android', notifications: 'undetermined' }));
  const { onNext, ensureChannels } = await renderStep('android', adapter);
  expect(await screen.findByTestId('notifications-allow')).toHaveTextContent('Allow notifications');
  await press(screen.getByTestId('notifications-not-now'));
  expect(onNext).toHaveBeenCalledTimes(1);
  expect(adapter.requestNotifications).not.toHaveBeenCalled();
  expect(ensureChannels).not.toHaveBeenCalled();
});

test("iPhone: before the system alert, one button, Continue, which opens it; no Not now (Apple's rule)", async () => {
  const adapter = fakeAdapter(snap({ platform: 'ios', notifications: 'undetermined' }));
  await renderStep('ios', adapter);
  await waitFor(() => expect(screen.getByTestId('notifications-allow')).toBeEnabled());
  expect(screen.getByTestId('notifications-allow')).toHaveTextContent('Continue', { exact: true });
  expect(screen.queryByTestId('notifications-not-now')).toBeNull();
  expect(screen.queryByTestId('notifications-continue')).toBeNull();
  expect(adapter.requestNotifications).not.toHaveBeenCalled();
});

test('iPhone: a request that fails (no alert came) says so, offers Continue again and Not now, which moves on (D12)', async () => {
  const say = jest.mocked(AccessibilityInfo.announceForAccessibilityWithOptions);
  say.mockClear();
  const adapter = fakeAdapter(snap({ platform: 'ios', notifications: 'undetermined' }));
  adapter.requestNotifications = jest.fn(async () => {
    adapter.log.push('requestNotifications');
    throw new Error('no answer');
  });
  const { onNext, requestDeviceSync } = await renderStep('ios', adapter);
  await press(await screen.findByTestId('notifications-allow'));
  expect(await screen.findByText(copy.failed)).toBeOnTheScreen();
  // Read out as it appears: VoiceOver stays on the button.
  expect(say.mock.calls).toEqual([[copy.failed, { queue: true }]]);
  expect(screen.getByTestId('notifications-allow')).toHaveTextContent('Continue', { exact: true });
  await press(screen.getByTestId('notifications-not-now'));
  expect(onNext).toHaveBeenCalledTimes(1);
  expect(requestDeviceSync).not.toHaveBeenCalled();
  expect(adapter.requestNotifications).toHaveBeenCalledTimes(1);
});

test.each(['ios', 'android'] as const)('%s: the lock-screen drive line shows only on Android (its drive notification needs this permission)', async (platform) => {
  const adapter = fakeAdapter(snap({ platform, notifications: 'undetermined' }));
  await renderStep(platform, adapter);
  await screen.findByTestId('notifications-allow');
  if (platform === 'android') expect(screen.getByTestId('notifications-android-drive')).toHaveTextContent(copy.android);
  else expect(screen.queryByTestId('notifications-android-drive')).toBeNull();
});

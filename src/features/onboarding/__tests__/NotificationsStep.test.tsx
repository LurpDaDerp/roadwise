import { act, fireEvent, screen, waitFor } from '@testing-library/react-native';

import { PROMPTS_KEY } from '@/core/permissions';
import { registerDriveStateSource } from '@/data/devices/driveStateStore';
import { T0 } from '@/data/queries/__fixtures__/rows';
import {
  fakeAdapter,
  fakeAppState,
  fakeHost,
  permissionsWorld,
  snap,
  type FakeAdapter,
} from '@/features/permissions/__fixtures__/harness';
import { clearQueryClients } from '@/features/trips/__fixtures__/render';
import { LIVE_TYPES, renderLocal, renderPush } from '@/notifications/catalog';

import { onboardingCopy } from '../copy';
import type { FlowContext } from '../flow';
import { PERMISSION_CONSENT_VERSION } from '../state';
import { NotificationsStep, previewNotifications } from '../steps/NotificationsStep';

const mockSession = { session: { user: { id: 'u1' } }, profile: { driving_stage: 'new' } };
const mockRecordConsent = jest.fn(async (_uid: string, _c: { type: string; version: string }) => ({}));
jest.mock('@/data/supabase/session', () => ({ useSession: () => mockSession }));
jest.mock('@/data/supabase/profile', () => ({
  recordConsent: (uid: string, c: { type: string; version: string }) => mockRecordConsent(uid, c),
}));

const copy = onboardingCopy.notifications;

const ctx = (platform: 'ios' | 'android'): FlowContext => ({
  platform,
  ageBand: '18_plus',
  drivingStage: 'new',
  termsCurrent: true,
  termsPublished: false,
  minorConsentMode: 'guardian_link_optional',
  features: { autoDetect: true, guardianInvites: false },
});

const press = (el: Parameters<typeof fireEvent.press>[0]) =>
  act(async () => {
    fireEvent.press(el);
  });

let release: (() => void) | null = null;
afterEach(() => {
  clearQueryClients();
  mockRecordConsent.mockClear();
  release?.();
  release = null;
});

async function renderStep(
  platform: 'ios' | 'android',
  adapter: FakeAdapter,
  log: string[] = adapter.log
) {
  const w = await permissionsWorld();
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

test('the previews are the catalog’s own copy, and only of live types', async () => {
  const previews = previewNotifications('android');
  expect(previews.map((p) => p.type)).toEqual(['trip_summary', 'permission_lapsed']);
  for (const p of previews) expect(LIVE_TYPES).toContain(p.type);
  const summary = renderLocal('trip_summary', {
    clientTripId: 'example',
    distanceM: 5150,
    roleUnknown: true,
    scorableIfDriver: false,
    count: 1,
  });
  expect(previews[0]).toMatchObject({ title: summary.title, body: summary.body });
  const lapse = renderPush('permission_lapsed', { permission: 'location', platform: 'android', deviceId: 'example' });
  expect(previews[1]).toMatchObject({ title: lapse?.title, body: lapse?.body });

  await renderStep('ios', fakeAdapter(snap({ platform: 'ios', notifications: 'undetermined' })));
  expect(await screen.findByText(summary.title)).toBeOnTheScreen();
  expect(screen.getByText(lapse!.title)).toBeOnTheScreen();
});

test('the promise is printed only while this phone reports when it is driving', async () => {
  await renderStep('ios', fakeAdapter(snap({ platform: 'ios', notifications: 'undetermined' })));
  await screen.findByTestId('notifications-allow');
  expect(screen.queryByText("We hold them while you're driving.")).toBeNull();

  clearQueryClients();
  release = registerDriveStateSource();
  await renderStep('ios', fakeAdapter(snap({ platform: 'ios', notifications: 'undetermined' })));
  expect(await screen.findByText("We hold them while you're driving.")).toBeOnTheScreen();
  expect(copy.promise).toBe("We hold them while you're driving.");
});

test('Android: the channels exist before the one request; grant → consent → device sync → on', async () => {
  const adapter = fakeAdapter(snap({ platform: 'android', notifications: 'undetermined' }));
  const { onNext, settings } = await renderStep('android', adapter);
  await press(await screen.findByTestId('notifications-allow'));
  await waitFor(() => expect(onNext).toHaveBeenCalledTimes(1));
  const order = adapter.log.filter((c) => c !== 'snapshot');
  expect(order).toEqual(['ensureChannels', 'requestNotifications', 'requestDeviceSync']);
  expect(mockRecordConsent).toHaveBeenCalledWith('u1', {
    type: 'notifications',
    version: PERMISSION_CONSENT_VERSION,
  });
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
  const w = await permissionsWorld();
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

test('denied: no consent, no sync, the inbox line, and Continue moves on (D12)', async () => {
  const adapter = fakeAdapter(snap({ platform: 'ios', notifications: 'undetermined' }));
  adapter.requestNotifications = jest.fn(async () => {
    adapter.log.push('requestNotifications');
    return 'denied' as const;
  });
  const { onNext, requestDeviceSync } = await renderStep('ios', adapter);
  await press(await screen.findByTestId('notifications-allow'));
  expect(await screen.findByText(copy.denied)).toBeOnTheScreen();
  expect(mockRecordConsent).not.toHaveBeenCalled();
  expect(requestDeviceSync).not.toHaveBeenCalled();
  await press(screen.getByTestId('notifications-continue'));
  expect(onNext).toHaveBeenCalledTimes(1);
});

test('Not now asks nothing', async () => {
  const adapter = fakeAdapter(snap({ platform: 'android', notifications: 'undetermined' }));
  const { onNext, ensureChannels } = await renderStep('android', adapter);
  await press(await screen.findByTestId('notifications-not-now'));
  expect(onNext).toHaveBeenCalledTimes(1);
  expect(adapter.requestNotifications).not.toHaveBeenCalled();
  expect(ensureChannels).not.toHaveBeenCalled();
  expect(mockRecordConsent).not.toHaveBeenCalled();
});

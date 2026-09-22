/**
 * Channels, the "Were you driving?" category, the memoised setup and the one foreground handler.
 */
import {
  DEVICE_CHANNELS,
  ensureAndroidChannels,
  type ChannelsApi,
} from '@/features/notifications/channels';
import {
  ensureNotificationSetup,
  registerCategories,
  ROLE_ACTIONS,
  TRIP_ROLE_CATEGORY,
  type SetupApi,
} from '@/features/notifications/categories';
import { foregroundBehavior, installForegroundHandler } from '@/features/notifications/handler';

jest.mock('expo-notifications', () => ({
  setNotificationChannelAsync: jest.fn(async () => null),
  setNotificationCategoryAsync: jest.fn(async () => null),
  setNotificationHandler: jest.fn(),
  AndroidImportance: { DEFAULT: 3, HIGH: 4 },
}));

const fakeApi = () => {
  const calls: string[] = [];
  const api = {
    AndroidImportance: { DEFAULT: 3, HIGH: 4 },
    setNotificationChannelAsync: jest.fn(async (id: string) => {
      calls.push(`channel:${id}`);
      return null;
    }),
    setNotificationCategoryAsync: jest.fn(async (id: string) => {
      calls.push(`category:${id}`);
      return { identifier: id, actions: [], options: {} };
    }),
  };
  return { api: api as unknown as SetupApi & ChannelsApi, raw: api, calls };
};

describe('ensureAndroidChannels', () => {
  test('creates exactly "trips" (Drive summaries) and "recording_problems" (Recording problems)', async () => {
    const { api, raw } = fakeApi();
    await ensureAndroidChannels(api, 'android');
    expect(raw.setNotificationChannelAsync.mock.calls).toEqual([
      ['trips', { name: 'Drive summaries', importance: 3 }],
      ['recording_problems', { name: 'Recording problems', importance: 3 }],
    ]);
    expect(DEVICE_CHANNELS.map((c) => c.id)).toEqual(['trips', 'recording_problems']);
  });

  test("never touches M3's native foreground-service channel", async () => {
    const { api, raw } = fakeApi();
    await ensureAndroidChannels(api, 'android');
    const ids = raw.setNotificationChannelAsync.mock.calls.map((c) => c[0]);
    expect(ids).not.toContain('drive_recording');
  });

  test('is idempotent: a second call makes no further native call', async () => {
    const { api, raw } = fakeApi();
    await ensureAndroidChannels(api, 'android');
    await ensureAndroidChannels(api, 'android');
    expect(raw.setNotificationChannelAsync).toHaveBeenCalledTimes(2);
  });

  test('a failure is not remembered: the next call tries again', async () => {
    const { api, raw } = fakeApi();
    raw.setNotificationChannelAsync.mockRejectedValueOnce(new Error('boom'));
    await expect(ensureAndroidChannels(api, 'android')).rejects.toThrow('boom');
    await ensureAndroidChannels(api, 'android');
    expect(raw.setNotificationChannelAsync.mock.calls.map((c) => c[0])).toEqual([
      'trips',
      'trips',
      'recording_problems',
    ]);
  });

  test('does nothing on iOS', async () => {
    const { api, raw } = fakeApi();
    await ensureAndroidChannels(api, 'ios');
    expect(raw.setNotificationChannelAsync).not.toHaveBeenCalled();
  });
});

describe('registerCategories', () => {
  test('registers trip_role with "I drove" and "Passenger", each opening the app', async () => {
    const { api, raw } = fakeApi();
    await registerCategories(api);
    expect(raw.setNotificationCategoryAsync).toHaveBeenCalledTimes(1);
    expect(raw.setNotificationCategoryAsync).toHaveBeenCalledWith('trip_role', [
      { identifier: 'drove', buttonTitle: 'I drove', options: { opensAppToForeground: true } },
      { identifier: 'passenger', buttonTitle: 'Passenger', options: { opensAppToForeground: true } },
    ]);
    expect(TRIP_ROLE_CATEGORY).toBe('trip_role');
  });

  test('the identifiers map to the roles the trip stores', () => {
    expect(ROLE_ACTIONS).toEqual({ drove: 'driver', passenger: 'passenger' });
  });
});

describe('ensureNotificationSetup', () => {
  test('resolves only after the channels and the category exist, so a schedule after it has them', async () => {
    const { api, calls } = fakeApi();
    await ensureNotificationSetup(api, 'android');
    calls.push('schedule');
    expect(calls).toEqual([
      'channel:trips',
      'channel:recording_problems',
      'category:trip_role',
      'schedule',
    ]);
  });

  test('is memoised: many callers, one registration', async () => {
    const { api, raw } = fakeApi();
    await Promise.all([
      ensureNotificationSetup(api, 'android'),
      ensureNotificationSetup(api, 'android'),
    ]);
    await ensureNotificationSetup(api, 'android');
    expect(raw.setNotificationCategoryAsync).toHaveBeenCalledTimes(1);
    expect(raw.setNotificationChannelAsync).toHaveBeenCalledTimes(2);
  });

  test('a failed setup is retried by the next caller', async () => {
    const { api, raw } = fakeApi();
    raw.setNotificationCategoryAsync.mockRejectedValueOnce(new Error('no'));
    await expect(ensureNotificationSetup(api, 'ios')).rejects.toThrow('no');
    await ensureNotificationSetup(api, 'ios');
    expect(raw.setNotificationCategoryAsync).toHaveBeenCalledTimes(2);
  });

  test('on iOS it registers the category without channels', async () => {
    const { api, calls } = fakeApi();
    await ensureNotificationSetup(api, 'ios');
    expect(calls).toEqual(['category:trip_role']);
  });
});

describe('the foreground handler', () => {
  test('the behaviour hides the banner and the list while recording, and is always silent', () => {
    expect(foregroundBehavior(true)).toEqual({
      shouldShowBanner: false,
      shouldShowList: false,
      shouldPlaySound: false,
      shouldSetBadge: false,
    });
    expect(foregroundBehavior(false)).toEqual({
      shouldShowBanner: true,
      shouldShowList: true,
      shouldPlaySound: false,
      shouldSetBadge: false,
    });
  });

  test('reads the recording state at the moment each notification arrives', async () => {
    const set = jest.fn();
    let recording = false;
    installForegroundHandler({ isRecording: () => recording }, { setNotificationHandler: set });
    const handler = set.mock.calls[0][0] as { handleNotification: () => Promise<unknown> };
    await expect(handler.handleNotification()).resolves.toMatchObject({ shouldShowBanner: true });
    recording = true;
    await expect(handler.handleNotification()).resolves.toMatchObject({
      shouldShowBanner: false,
      shouldShowList: false,
    });
  });

  test('a recording state that cannot be read counts as recording (quiet)', async () => {
    const set = jest.fn();
    installForegroundHandler(
      {
        isRecording: () => {
          throw new Error('no host');
        },
      },
      { setNotificationHandler: set }
    );
    const handler = set.mock.calls[0][0] as { handleNotification: () => Promise<unknown> };
    await expect(handler.handleNotification()).resolves.toMatchObject({ shouldShowBanner: false });
  });

  test('uninstalling clears the handler, but only if no newer install replaced it', () => {
    const set = jest.fn();
    const first = installForegroundHandler({ isRecording: () => false }, { setNotificationHandler: set });
    const second = installForegroundHandler({ isRecording: () => false }, { setNotificationHandler: set });
    first();
    expect(set).toHaveBeenCalledTimes(2);
    second();
    expect(set).toHaveBeenLastCalledWith(null);
    second();
    expect(set).toHaveBeenCalledTimes(3);
  });
});

// The Android channels: each notification presented as the iPhone presents it (the recap peeks
// silently, the weather heads-up and "Are you driving?" are silent, the pushes sound, nothing badges
// the launcher), the old ids deleted once the new ones exist (Android fixes a channel's importance,
// sound and badge at creation), and each poster on its own channel, named in the trigger.
import { createPassengerNotePort } from '@/drive/passengerNote';
import { createExpoSummaryPort } from '@/features/drive/summaryNotifier';
import { createExpoHeadsUpPort, HEADS_UP_CHANNEL_ID } from '@/features/weather/commuteHeadsUp';

import { DEVICE_CHANNELS, DRIVE_ALERTS_CHANNEL_ID, ensureAndroidChannels, PUSH_CHANNEL_ID, RECAP_CHANNEL_ID, RETIRED_CHANNEL_IDS, WEATHER_CHANNEL_ID, type ChannelsApi } from '../channels';

const mockPosted: unknown[] = [];
jest.mock('expo-notifications', () => ({
  AndroidImportance: { MIN: 1, LOW: 2, DEFAULT: 3, HIGH: 4 },
  setNotificationChannelAsync: async () => null,
  deleteNotificationChannelAsync: async () => {},
  scheduleNotificationAsync: async (req: unknown) => {
    mockPosted.push(req);
    return 'id';
  },
  SchedulableTriggerInputTypes: { DATE: 'date' },
}));
jest.mock('@/features/notifications/categories', () => ({ ensureNotificationSetup: async () => {} }));

beforeEach(() => {
  mockPosted.length = 0;
});

/** A fresh API object (the creation is memoised per object), logging every call in order. */
function fakeApi(o: { failCreate?: boolean; failDelete?: boolean; noDelete?: boolean } = {}) {
  const log: string[] = [];
  const options: Record<string, unknown> = {};
  const api = {
    AndroidImportance: { MIN: 1, LOW: 2, DEFAULT: 3, HIGH: 4 },
    setNotificationChannelAsync: jest.fn(async (id: string, opts: unknown) => {
      if (o.failCreate) throw new Error('no channels');
      log.push(`create:${id}`);
      options[id] = opts;
      return null;
    }),
    ...(o.noDelete
      ? {}
      : {
          deleteNotificationChannelAsync: jest.fn(async (id: string) => {
            log.push(`delete:${id}`);
            if (o.failDelete) throw new Error('refused');
          }),
        }),
  };
  return { api: api as unknown as ChannelsApi, log, options };
}

describe('the channels', () => {
  test('four, by id: the recap, the pushes, the weather heads-up and "Are you driving?"', () => {
    expect(DEVICE_CHANNELS.map((c) => c.id)).toEqual(['recaps', 'pushes', 'weather', 'drive_alerts']);
    expect([RECAP_CHANNEL_ID, PUSH_CHANNEL_ID, WEATHER_CHANNEL_ID, DRIVE_ALERTS_CHANNEL_ID]).toEqual(['recaps', 'pushes', 'weather', 'drive_alerts']);
    expect(RETIRED_CHANNEL_IDS).toEqual(['trips', 'updates']);
    for (const c of DEVICE_CHANNELS) expect(RETIRED_CHANNEL_IDS).not.toContain(c.id);
  });

  test('made on Android, then the old ids deleted: the recap HIGH and silent, the pushes DEFAULT with the default sound, the others DEFAULT and silent, none with a badge', async () => {
    const f = fakeApi();
    await ensureAndroidChannels(f.api, 'android');
    expect(f.log).toEqual(['create:recaps', 'create:pushes', 'create:weather', 'create:drive_alerts', 'delete:trips', 'delete:updates']);
    expect(f.options).toEqual({
      recaps: { name: 'Drive recaps', description: 'Your recap when a drive ends.', importance: 4, showBadge: false, sound: null, enableVibrate: false },
      pushes: { name: 'Updates', description: 'Your weekly recap, your monthly Wrapped and friend requests.', importance: 3, showBadge: false },
      weather: { name: 'Weather before your commute', description: 'A heads-up when bad weather is due around the time you usually leave.', importance: 3, showBadge: false, sound: null, enableVibrate: false },
      drive_alerts: { name: 'Are you driving?', description: 'Asks during a drive when your car isn’t connected, in case you’re a passenger.', importance: 3, showBadge: false, sound: null, enableVibrate: false },
    });
  });

  test('once per API object; nothing at all off Android', async () => {
    const f = fakeApi();
    await ensureAndroidChannels(f.api, 'android');
    await ensureAndroidChannels(f.api, 'android');
    expect(f.log.filter((l) => l.startsWith('create:'))).toHaveLength(4);
    const ios = fakeApi();
    await ensureAndroidChannels(ios.api, 'ios');
    expect(ios.log).toEqual([]);
  });

  test('a delete that fails holds nothing up (the new channels are made); without the delete API the old ids stay', async () => {
    const f = fakeApi({ failDelete: true });
    await expect(ensureAndroidChannels(f.api, 'android')).resolves.toBeUndefined();
    expect(f.log).toEqual(['create:recaps', 'create:pushes', 'create:weather', 'create:drive_alerts', 'delete:trips', 'delete:updates']);
    const g = fakeApi({ noDelete: true });
    await expect(ensureAndroidChannels(g.api, 'android')).resolves.toBeUndefined();
    expect(g.log).toHaveLength(4);
  });

  test('a creation that fails rejects, and the next caller tries again', async () => {
    const f = fakeApi({ failCreate: true });
    await expect(ensureAndroidChannels(f.api, 'android')).rejects.toThrow('no channels');
    await expect(ensureAndroidChannels(f.api, 'android')).rejects.toThrow('no channels');
    expect(f.api.setNotificationChannelAsync).toHaveBeenCalledTimes(2);
  });

  test("the pushes' channel is the one the server names (push_copy.ts ANDROID_CHANNEL)", () => {
    const { ANDROID_CHANNEL } = jest.requireActual<{ ANDROID_CHANNEL: string }>('../../../../supabase/functions/_shared/push_copy');
    expect(ANDROID_CHANNEL).toBe(PUSH_CHANNEL_ID);
  });
});

describe('each poster on its channel, named in the trigger (Android reads it only there)', () => {
  test('the recap on recaps, posted at once', async () => {
    await createExpoSummaryPort().schedule({ identifier: 'drive-summary:a', clientTripId: 'a', title: 't', body: 'b', url: '/drives/a?fresh=1' });
    expect(mockPosted).toEqual([expect.objectContaining({ trigger: { channelId: 'recaps' } })]);
  });

  test('the weather heads-up on weather, at its time, with no sound', async () => {
    expect(HEADS_UP_CHANNEL_ID).toBe('weather');
    await createExpoHeadsUpPort().schedule({ identifier: 'weather-commute:home-work', title: 'Freezing rain', body: 'x', fireAt: 1_000, departAt: 1_800_000, leg: 'home-work' });
    expect(mockPosted).toEqual([expect.objectContaining({ content: expect.objectContaining({ sound: false }), trigger: { type: 'date', date: 1_000, channelId: 'weather' } })]);
  });

  test('"Are you driving?" on drive_alerts, posted at once with no sound (on iOS a channel-only trigger is no trigger)', async () => {
    await createPassengerNotePort({} as never).post('0b0b0b0b-0000-4000-8000-000000000001');
    expect(mockPosted).toEqual([expect.objectContaining({ content: expect.objectContaining({ title: 'Are you driving?', sound: false }), trigger: { channelId: 'drive_alerts' } })]);
  });
});

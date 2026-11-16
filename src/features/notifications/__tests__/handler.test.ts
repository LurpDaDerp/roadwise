import type * as Notifications from 'expo-notifications';

import { foregroundBehavior, installForegroundHandler, type HandlerApi } from '../handler';

type Handler = Parameters<HandlerApi['setNotificationHandler']>[0];

function install(isRecording: () => boolean, os?: string, level?: number): NonNullable<Handler> {
  let installed: Handler = null;
  const api: HandlerApi = { setNotificationHandler: (h) => void (installed = h) };
  installForegroundHandler({ isRecording, ...(os !== undefined ? { os } : {}), ...(level !== undefined ? { api: level } : {}) }, api);
  if (installed === null) throw new Error('no handler installed');
  return installed;
}

const note = (data: Record<string, unknown>): Notifications.Notification =>
  ({ date: 0, request: { identifier: 'x', content: { data }, trigger: null } }) as unknown as Notifications.Notification;

describe('foreground notification handler', () => {
  it('hides everything else while a drive records, and shows it quietly otherwise', async () => {
    expect(await install(() => true).handleNotification(note({ kind: 'driveSummary' }))).toEqual(foregroundBehavior(true));
    expect(await install(() => false).handleNotification(note({ kind: 'driveSummary' }))).toEqual(foregroundBehavior(false));
  });

  it('reads an unknown recording state as recording', async () => {
    const h = install(() => {
      throw new Error('boom');
    });
    expect(await h.handleNotification(note({}))).toEqual(foregroundBehavior(true));
  });

  it('on iOS never asks for a sound, the recap included', async () => {
    for (const kind of ['driveSummary', 'weeklyRecap', undefined]) {
      expect(await install(() => false, 'ios').handleNotification(note({ kind }))).toEqual({
        shouldShowBanner: true,
        shouldShowList: true,
        shouldPlaySound: false,
        shouldSetBadge: false,
      });
    }
  });

  it('on Android lets the recap "play" its silent channel so expo does not build it silent (no heads-up otherwise)', async () => {
    expect(await install(() => false, 'android').handleNotification(note({ kind: 'driveSummary' }))).toEqual({
      shouldShowBanner: true,
      shouldShowList: true,
      shouldPlaySound: true,
      shouldSetBadge: false,
    });
  });

  it('on Android keeps every other notification quiet in front, and hides the recap while recording', async () => {
    for (const kind of ['weeklyRecap', 'weatherCommute', undefined]) {
      expect((await install(() => false, 'android').handleNotification(note({ kind }))).shouldPlaySound).toBe(false);
    }
    expect(await install(() => true, 'android').handleNotification(note({ kind: 'driveSummary' }))).toEqual({
      shouldShowBanner: false,
      shouldShowList: false,
      shouldPlaySound: false,
      shouldSetBadge: false,
    });
  });

  it('on Android 7 (no channels: the notification itself would sound) keeps the recap quiet in front', async () => {
    for (const level of [24, 25]) {
      expect((await install(() => false, 'android', level).handleNotification(note({ kind: 'driveSummary' }))).shouldPlaySound).toBe(false);
    }
    expect((await install(() => false, 'android', 26).handleNotification(note({ kind: 'driveSummary' }))).shouldPlaySound).toBe(true);
  });

  it('tolerates a notification with no data', async () => {
    const bare = { date: 0, request: { identifier: 'x', content: {}, trigger: null } } as unknown as Notifications.Notification;
    expect((await install(() => false, 'android').handleNotification(bare)).shouldPlaySound).toBe(false);
  });
});

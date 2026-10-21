import type * as Notifications from 'expo-notifications';

import { foregroundBehavior, installForegroundHandler, PHONE_REMINDER_BEHAVIOR, type HandlerApi } from '../handler';
import { PHONE_REMINDER_KIND } from '../hrefs';

type Handler = Parameters<HandlerApi['setNotificationHandler']>[0];

function install(isRecording: () => boolean): NonNullable<Handler> {
  let installed: Handler = null;
  const api: HandlerApi = { setNotificationHandler: (h) => void (installed = h) };
  installForegroundHandler({ isRecording }, api);
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

  it('always shows the phone-pickup reminder, silently, even while a drive records', async () => {
    for (const recording of [true, false]) {
      const behavior = await install(() => recording).handleNotification(note({ kind: PHONE_REMINDER_KIND, url: '/drive' }));
      expect(behavior).toEqual(PHONE_REMINDER_BEHAVIOR);
      expect(behavior).toMatchObject({ shouldShowBanner: true, shouldShowList: true, shouldPlaySound: false, shouldSetBadge: false });
    }
  });
});

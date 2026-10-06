/**
 * Device notification plumbing: the channels, the app's only foreground handler, and the only
 * response listener (`NotificationsHost`).
 */
export { DEVICE_CHANNELS, ensureAndroidChannels, type ChannelsApi, type DeviceChannel } from './channels';
export { ensureNotificationSetup, type SetupApi } from './categories';
export { notificationCopy } from './copy';
export { foregroundBehavior, installForegroundHandler, type HandlerApi } from './handler';
export { NotificationsHost, type NotificationsHostProps } from './NotificationsHost';
export { ALLOWED_HREFS, isAllowedHref, SUMMARY_HREF } from './hrefs';
export {
  allowHref,
  FALLBACK_HREF,
  handleResponse,
  PENDING_HREF_KEY,
  PENDING_HREF_MAX_AGE_MS,
  replayPendingHref,
  routeForResponse,
  type NotificationRoute,
  type ReplayOutcome,
  type ResponseDeps,
  type ResponseOutcome,
} from './responses';

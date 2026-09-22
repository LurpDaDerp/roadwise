/**
 * Device notification plumbing: the channels, the "Were you driving?" category, the app's only
 * foreground handler, and the only response listener (`NotificationsHost`).
 */
export {
  DEVICE_CHANNELS,
  ensureAndroidChannels,
  type ChannelsApi,
  type DeviceChannel,
} from './channels';
export {
  ensureNotificationSetup,
  registerCategories,
  ROLE_ACTIONS,
  TRIP_ROLE_CATEGORY,
  type CategoriesApi,
  type RoleActionId,
  type SetupApi,
} from './categories';
export { notificationCopy } from './copy';
export { foregroundBehavior, installForegroundHandler, type HandlerApi } from './handler';
export { NotificationsHost, type NotificationsHostProps } from './NotificationsHost';
export {
  allowHref,
  ALLOWED_HREFS,
  FALLBACK_HREF,
  handleResponse,
  OPENED_TRIPS_MAX,
  PENDING_HREF_KEY,
  PENDING_HREF_MAX_AGE_MS,
  recordOpenedTrip,
  replayPendingHref,
  routeForResponse,
  type NotificationRoute,
  type ReplayOutcome,
  type ResponseDeps,
  type ResponseOutcome,
  type RoleOutcome,
} from './responses';

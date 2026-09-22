/**
 * Query and storage keys for the notification lane, in one place so the inbox (Task 6), the
 * notification host (Task 5), H6 (Task 7) and M3's rewired summary notifier (Task 19) agree.
 */

/** React Query key of the server inbox. */
export const INBOX_QUERY_KEY = ['inbox'] as const;

/** React Query key of the user's notification preferences. */
export const PREFS_QUERY_KEY = ['notificationPrefs'] as const;

/** Settings key: drives whose summary the driver has opened. */
export const OPENED_TRIPS_KEY = 'notifications.openedTrips';

/** Settings key: `{ day, count }` of non-family notifications the phone showed today (§11.1 cap). */
export const LOCAL_SENT_KEY = 'notifications.localSent';

/** Settings key: the cached effective preferences, read by the local delivery plan offline. */
export const PREFS_CACHE_KEY = 'notifications.prefs';

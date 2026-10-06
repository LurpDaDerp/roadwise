import type { Href } from 'expo-router';

/** Where the settings screens live — the one module for these routes. */
export const SETTINGS_HREFS = {
  root: '/settings' as Href,
  account: '/settings/account' as Href,
  alerts: '/settings/alerts' as Href,
  dms: '/settings/dms' as Href,
  notifications: '/settings/notifications' as Href,
  privacyZones: '/settings/privacy-zones' as Href,
  deleteAccount: '/settings/delete-account' as Href,
  blocked: '/settings/blocked' as Href,
  permissions: '/settings/permissions' as Href,
  howPointsWork: '/how-points-work' as Href,
} as const;

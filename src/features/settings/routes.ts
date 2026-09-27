import type { Href } from 'expo-router';

/**
 * Where the settings screens live — the one module for these routes. Casts: typed routes are
 * generated at `expo start`, and the camera screen is lane B's (`app/(app)/settings/camera.tsx`).
 */
export const SETTINGS_HREFS = {
  root: '/settings' as Href,
  profile: '/settings/profile' as Href,
  alerts: '/settings/alerts' as Href,
  camera: '/settings/camera' as Href,
  notifications: '/settings/notifications' as Href,
  privacy: '/settings/privacy' as Href,
  deleteAccount: '/settings/delete-account' as Href,
  help: '/settings/help' as Href,
  /** The existing auto-record screen (M4), the drive detection setting. */
  detection: '/permissions/auto-record' as Href,
  /** The scoring explainer (E4), linked from Help. */
  scoring: '/insights/how-scoring-works' as Href,
} as const;

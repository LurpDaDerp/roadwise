// Where DashPal's links lead, and the deep link held during a drive.
import type { Href } from 'expo-router';

import { SETTINGS_HREFS } from '@/features/settings/routes';

/** Settings: a `roadwise://dashpal` link that arrived during a drive, `{ at }`, replayed when idle. */
export const PENDING_SETUP_KEY = 'dashcam.pendingSetup';
export const PENDING_SETUP_MAX_AGE_MS = 12 * 60 * 60_000;

/** The setup href, with the dashcam the prompt found. */
export const setupHref = (found?: string): Href =>
  (found ? `${String(SETTINGS_HREFS.dashcamSetup)}?found=${encodeURIComponent(found)}` : SETTINGS_HREFS.dashcamSetup) as Href;

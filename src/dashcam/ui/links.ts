// Where DashPal's links lead, and the deep link held during a drive.
import type { Href } from 'expo-router';

import { SETTINGS_HREFS } from '@/features/settings/routes';

import { isDashcamId } from '../protocol';

/**
 * Settings: a DashPal link that arrived during a drive or while signed out, `{ at, dashcamId,
 * signIn? }`, replayed once a drive is over and the driver is signed in with setup done. Never its
 * code: that waits in SecureStore (`dashpal.pendingCode`). `signIn`: held through a sign-in, replayed
 * only while its code is still held (the onboarding step may have used it).
 */
export const PENDING_SETUP_KEY = 'dashcam.pendingSetup';
export const PENDING_SETUP_MAX_AGE_MS = 12 * 60 * 60_000;

export interface SetupTarget {
  /** a peripheral the nearby prompt found */
  found?: string;
  /** a link opened from outside: its DashPal (or null for a link without one); its code is in SecureStore */
  link?: string | null;
  /** Set up again (the stored label code) */
  again?: boolean;
}

/** The setup href for a target. */
export function setupHref(target: SetupTarget = {}): Href {
  const q: string[] = [];
  if (target.found) q.push(`found=${encodeURIComponent(target.found)}`);
  if (target.link !== undefined) q.push(`link=${target.link && isDashcamId(target.link) ? target.link : '1'}`);
  if (target.again) q.push('again=1');
  return (q.length > 0 ? `${String(SETTINGS_HREFS.dashcamSetup)}?${q.join('&')}` : SETTINGS_HREFS.dashcamSetup) as Href;
}

/** The setup route's params as a target (the inverse of `setupHref`). */
export function setupTargetOf(params: { found?: string | string[]; link?: string | string[]; again?: string | string[] }): SetupTarget {
  const one = (v: string | string[] | undefined): string | undefined => (typeof v === 'string' && v.length > 0 ? v : undefined);
  const found = one(params.found);
  const link = one(params.link);
  const again = one(params.again) === '1';
  return {
    ...(found ? { found } : {}),
    ...(link !== undefined ? { link: isDashcamId(link.toLowerCase()) ? link.toLowerCase() : null } : {}),
    ...(again ? { again } : {}),
  };
}

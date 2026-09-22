/**
 * The app's ONE deep-link allowlist (final review m1): the routes a notification tap may open
 * (`responses.ts`) and the only links onboarding may hold and replay (`authGuard.ts`). Anchored,
 * so a held or pushed value can only ever be one of these screens. Pure: no native module, so the
 * auth gate can import it without loading expo-notifications.
 */

export const SUMMARY_HREF = /^\/trips\/([A-Za-z0-9_-]{1,64})\/summary$/;

/**
 * An invite link, `roadwise://join/<code>` (M5 §R10): the 8-character referral code in its own
 * alphabet, upper case only. Allowlisted so onboarding holds and replays it (M4's `authGuard`).
 */
export const JOIN_HREF = /^\/join\/([ABCDEFGHJKMNPQRSTUVWXYZ23456789]{8})$/;

export const ALLOWED_HREFS: readonly RegExp[] = [
  SUMMARY_HREF,
  /^\/trips$/,
  /^\/permissions$/,
  /^\/inbox$/,
  // The rewards notifications' screens (M5).
  /^\/rewards$/,
  /^\/rewards\/goal$/,
  /^\/rewards\/challenges$/,
  /^\/rewards\/badges$/,
  /^\/rewards\/invite$/,
  JOIN_HREF,
];

/** Whether `url` is exactly one of the allowlisted routes. */
export const isAllowedHref = (url: unknown): url is string =>
  typeof url === 'string' && ALLOWED_HREFS.some((re) => re.test(url));

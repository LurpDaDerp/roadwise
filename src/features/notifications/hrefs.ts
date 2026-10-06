/**
 * The app's ONE deep-link allowlist (final review m1): the routes a notification tap may open
 * (`responses.ts`) and the only links onboarding may hold and replay (`authGuard.ts`). Anchored,
 * so a held or pushed value can only ever be one of these screens. Pure: no native module, so the
 * auth gate can import it without loading expo-notifications.
 */

export const SUMMARY_HREF = /^\/drives\/([A-Za-z0-9_-]{1,64})$/;

export const ALLOWED_HREFS: readonly RegExp[] = [
  SUMMARY_HREF,
  /^\/drives$/,
  /^\/home$/,
  /^\/leagues$/,
  /^\/friends$/,
  /^\/settings\/permissions$/,
];

/** Whether `url` is exactly one of the allowlisted routes. */
export const isAllowedHref = (url: unknown): url is string =>
  typeof url === 'string' && ALLOWED_HREFS.some((re) => re.test(url));

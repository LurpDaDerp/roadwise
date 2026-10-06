/**
 * The app's ONE deep-link allowlist: the routes a notification tap may open (`responses.ts`) and
 * the only links onboarding may hold and replay (`authGuard.ts`). Anchored, so a held or pushed
 * value can only ever be one of these screens. Nothing here opens a drive start (plan §7).
 */

export const SUMMARY_HREF = /^\/drives\/([A-Za-z0-9-]{1,64})(?:\?fresh=1)?$/;

export const ALLOWED_HREFS: readonly RegExp[] = [SUMMARY_HREF, /^\/drives$/, /^\/home$/, /^\/leagues$/, /^\/friends$/];

/** Whether `url` is exactly one of the allowlisted routes. */
export const isAllowedHref = (url: unknown): url is string => typeof url === 'string' && ALLOWED_HREFS.some((re) => re.test(url));

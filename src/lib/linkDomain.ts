/**
 * The web domain RoadWise's share links live on (`app.config.ts` reads `ROADWISE_LINK_DOMAIN` into
 * `extra.linkDomain`, beside `ios.associatedDomains`). ONE value: none is set yet, and until it is,
 * a shared Wrapped's link is `roadwise://w/<id>` and no https link opens the app.
 */

/** A bare host name: letters, digits and hyphens in dot-separated labels, no scheme, port or path. `app.config.ts` copies it (`LINK_HOST_RE`). */
export const HOST_RE = /^(?=.{1,253}$)([a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/;

/** The value as a host name, lower-cased, or null when it isn't one. */
export function asLinkDomain(raw: unknown): string | null {
  if (typeof raw !== 'string') return null;
  const host = raw.trim().toLowerCase();
  return HOST_RE.test(host) ? host : null;
}

/** The configured link domain, or null when none is set (or it can't be read). */
export function linkDomain(): string | null {
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports -- read lazily: pure callers and Node tests never load it
    const Constants = (require('expo-constants') as typeof import('expo-constants')).default;
    const extra = Constants.expoConfig?.extra as { linkDomain?: unknown } | undefined;
    return asLinkDomain(extra?.linkDomain);
  } catch {
    return null;
  }
}

/**
 * The friend link and the one QR code the app reads: `roadwise://add/<username>` opens that
 * driver's profile (`/u/<username>`), from a QR code or a tapped link (`app/(app)/add/[username]`).
 *
 * A shared monthly Wrapped's link opens `/w/<id>` (`wrappedLink`).
 *
 * Usernames are 3 to 20 of `a-z 0-9 _` (case-insensitive on the server, lower-cased here). Anything
 * that isn't exactly one of these shapes is rejected: a scanned code can never send someone
 * anywhere else in the app.
 */
import type { Href } from 'expo-router';

import { linkDomain } from '@/lib/linkDomain';

export const USERNAME_RE = /^[a-z0-9_]{3,20}$/;
const ADD_LINK_RE = /^roadwise:\/\/add\/([A-Za-z0-9_]{3,20})\/?$/;

/** The link a driver's QR code holds. */
export function addLink(username: string): string {
  return `roadwise://add/${username.toLowerCase()}`;
}

/** The username in a scanned code, or null when the code is anything but an add link. */
export function parseAddLink(raw: unknown): string | null {
  if (typeof raw !== 'string') return null;
  const match = ADD_LINK_RE.exec(raw.trim());
  return match?.[1] ? match[1].toLowerCase() : null;
}

/** A profile route. Cast: the typed-routes union lags dynamic routes. */
export function profileHref(username: string): Href {
  return `/u/${encodeURIComponent(username.toLowerCase())}` as Href;
}

/** A shared Wrapped's id: 12 letters and digits (`create_wrapped_share`). */
export { SHARE_ID_RE as WRAPPED_ID_RE } from '@/data/server/wrappedIds';
// `w/<id>`, then at most a trailing slash and a query or fragment (the same shape `+native-intent` lets in).
const WRAPPED_SCHEME_LINK_RE = /^roadwise:\/\/\/?w\/([A-Za-z0-9]{12})\/?(?:[?#].*)?$/;
const WRAPPED_WEB_LINK_RE = /^https:\/\/([^/?#]+)\/w\/([A-Za-z0-9]{12})\/?(?:[?#].*)?$/i;

/**
 * A shared Wrapped's link: `https://<domain>/w/<id>` once the link domain is set
 * (`@/lib/linkDomain`), `roadwise://w/<id>` until then. Both open `/w/<id>` in the app.
 */
export function wrappedLink(id: string, domain: string | null = linkDomain()): string {
  return domain ? `https://${domain}/w/${id}` : `roadwise://w/${id}`;
}

/**
 * The share id in a Wrapped link, or null: `roadwise://w/<id>`, or `https://<domain>/w/<id>` only
 * on the configured link domain (never another host, never plain http).
 */
export function parseWrappedLink(raw: unknown, domain: string | null = linkDomain()): string | null {
  if (typeof raw !== 'string') return null;
  const s = raw.trim();
  const scheme = WRAPPED_SCHEME_LINK_RE.exec(s);
  if (scheme?.[1]) return scheme[1];
  const web = WRAPPED_WEB_LINK_RE.exec(s);
  if (web?.[1] && web[2] && domain !== null && web[1].toLowerCase() === domain.toLowerCase()) return web[2];
  return null;
}

/** A shared Wrapped's route. Cast: the typed-routes union lags dynamic routes. */
export function wrappedHref(id: string): Href {
  return `/w/${id}` as Href;
}

/** The Wrapped archive and one month's own story. */
export const WRAPPED_ARCHIVE_HREF = '/wrapped' as Href;
export function wrappedMonthHref(month: string): Href {
  return `/wrapped/${month}` as Href;
}

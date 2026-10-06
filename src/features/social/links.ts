/**
 * The friend link and the one QR code the app reads: `roadwise://add/<username>` opens that
 * driver's profile (`/u/<username>`), from a QR code or a tapped link (`app/(app)/add/[username]`).
 *
 * Usernames are 3 to 20 of `a-z 0-9 _` (case-insensitive on the server, lower-cased here). Anything
 * that isn't exactly one of these shapes is rejected: a scanned code can never send someone
 * anywhere else in the app.
 */
import type { Href } from 'expo-router';

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

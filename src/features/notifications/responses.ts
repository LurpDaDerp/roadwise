/**
 * What a tap on a notification does, for local and pushed notifications alike.
 *
 * `routeForResponse` is pure: it reads the notification's `data.url` and lets through only the
 * routes a notification may open. Anything else opens Home; a response that is not shaped like one
 * opens nothing. `handleResponse` navigates, or (while a drive is under way or the navigator is
 * not mounted yet) holds the href in settings for `replayPendingHref`. The drive's recording note
 * is not handled here: `NotificationsHost` opens the driving screen for it, and it is never held.
 */
import * as Notifications from 'expo-notifications';

import { createSettingsRepo, type Db } from '@/data/db';

import { ALLOWED_HREFS, isAllowedHref, SUMMARY_HREF } from './hrefs';

/** Settings key: `{ href, at }` of a tap held while the app could not navigate. */
export const PENDING_HREF_KEY = 'notifications.pendingHref';
/** A held tap older than this is dropped. */
export const PENDING_HREF_MAX_AGE_MS = 12 * 60 * 60_000;
export const FALLBACK_HREF = '/home';

export { ALLOWED_HREFS };

export interface NotificationRoute {
  /** One of `ALLOWED_HREFS`. */
  href: string;
  /** The drive a summary href names. */
  clientTripId?: string;
}

/** The url if allowlisted, else Home. */
export function allowHref(url: unknown): string {
  return isAllowedHref(url) ? url : FALLBACK_HREF;
}

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null;

export function routeForResponse(response: Notifications.NotificationResponse | null | undefined): NotificationRoute | null {
  const r: unknown = response;
  if (!isRecord(r) || typeof r.actionIdentifier !== 'string') return null;
  const notification = r.notification;
  if (!isRecord(notification) || !isRecord(notification.request)) return null;
  const content = notification.request.content;
  if (!isRecord(content)) return null;
  // A dismissal or any other system action is not a request to open anything.
  if (r.actionIdentifier !== Notifications.DEFAULT_ACTION_IDENTIFIER) return null;
  const data = content.data;
  const href = isRecord(data) && data.url !== undefined ? allowHref(data.url) : FALLBACK_HREF;
  const clientTripId = SUMMARY_HREF.exec(href)?.[1];
  return clientTripId === undefined ? { href } : { href, clientTripId };
}

export interface ResponseDeps {
  db: Db;
  navigate(href: string): void;
  /** True while the app must not navigate: a drive under way, or no navigator yet. */
  isBusy(): boolean;
  now?(): number;
  onError?(e: unknown, ctx: string): void;
}

export type ResponseOutcome = { kind: 'ignored' } | { kind: 'navigated' | 'deferred'; href: string };

export async function handleResponse(response: Notifications.NotificationResponse | null | undefined, deps: ResponseDeps): Promise<ResponseOutcome> {
  const route = routeForResponse(response);
  if (route === null) return { kind: 'ignored' };
  const now = (deps.now ?? Date.now)();
  if (deps.isBusy()) {
    await createSettingsRepo(deps.db)
      .set(PENDING_HREF_KEY, { href: route.href, at: now })
      .catch((e: unknown) => deps.onError?.(e, 'notifications.pending'));
    return { kind: 'deferred', href: route.href };
  }
  deps.navigate(route.href);
  return { kind: 'navigated', href: route.href };
}

export type ReplayOutcome = { kind: 'none' | 'busy' | 'expired' } | { kind: 'navigated'; href: string };

/** Delivers the held tap, once, if the app may navigate now and the tap is not stale. */
export async function replayPendingHref(deps: Pick<ResponseDeps, 'db' | 'navigate' | 'isBusy' | 'now'>): Promise<ReplayOutcome> {
  if (deps.isBusy()) return { kind: 'busy' };
  const settings = createSettingsRepo(deps.db);
  const stored = await settings.get<unknown>(PENDING_HREF_KEY);
  if (stored === null) return { kind: 'none' };
  if (deps.isBusy()) return { kind: 'busy' };
  await settings.remove(PENDING_HREF_KEY);
  const now = (deps.now ?? Date.now)();
  if (!isRecord(stored) || typeof stored.at !== 'number' || now - stored.at > PENDING_HREF_MAX_AGE_MS) return { kind: 'expired' };
  const href = allowHref(stored.href);
  deps.navigate(href);
  return { kind: 'navigated', href };
}

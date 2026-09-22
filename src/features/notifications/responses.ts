/**
 * What a tap on a notification does — for local and pushed notifications alike.
 *
 * `routeForResponse` is pure: it reads the notification's `data.url` and lets through only the
 * four routes a notification may open. Anything else opens the inbox, where every notice is
 * listed; a response that is not shaped like one opens nothing. The role buttons on "Were you
 * driving?" add the answer for the trip the url names.
 *
 * `handleResponse` acts on it: it writes a role answer through `setTripRole` (the same write as the
 * summary's chips), records the trip as opened so the inbox mirror — which arrives only after
 * sync — can be marked read then, and navigates. While a drive is under way (or the navigator is
 * not mounted yet) it navigates nowhere: the href is held in settings and `replayPendingHref`
 * delivers it once the drive is over.
 */
import * as Notifications from 'expo-notifications';

import { createSettingsRepo, MissingTripError, type Db } from '@/data/db';
import {
  setTripRole as defaultSetTripRole,
  type ChosenRole,
} from '@/features/trips/roleActions';
import { OPENED_TRIPS_KEY } from '@/notifications/keys';

import { ROLE_ACTIONS } from './categories';

/** Settings key: `{ href, at }` of a tap held while the app could not navigate. */
export const PENDING_HREF_KEY = 'notifications.pendingHref';
/** A held tap older than this is dropped (the trip summary's catalog TTL, 12 h). */
export const PENDING_HREF_MAX_AGE_MS = 12 * 60 * 60_000;
export const OPENED_TRIPS_MAX = 50;
export const FALLBACK_HREF = '/inbox';

const TRIP_ID = /^[A-Za-z0-9_-]{1,64}$/;
const SUMMARY_HREF = /^\/trips\/([A-Za-z0-9_-]{1,64})\/summary$/;
export const ALLOWED_HREFS: readonly RegExp[] = [
  SUMMARY_HREF,
  /^\/trips$/,
  /^\/permissions$/,
  /^\/inbox$/,
];

/** M3's interim drive-summary data (`summaryNotifier.ts`, until Task 19 gives it a `url`). */
const LEGACY_SUMMARY_KIND = 'driveSummary';

export interface NotificationRoute {
  /** One of `ALLOWED_HREFS`. */
  href: string;
  /** A role answer from the "Were you driving?" buttons; present only with `clientTripId`. */
  role?: ChosenRole;
  /** The trip a summary href names. */
  clientTripId?: string;
}

/** The url if allowlisted, else the inbox. */
export function allowHref(url: unknown): string {
  return typeof url === 'string' && ALLOWED_HREFS.some((re) => re.test(url)) ? url : FALLBACK_HREF;
}

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null;

function urlOf(data: unknown): string | null {
  if (!isRecord(data)) return FALLBACK_HREF;
  if (data.url !== undefined) return allowHref(data.url);
  if (data.kind === LEGACY_SUMMARY_KIND && Array.isArray(data.clientTripIds)) {
    const ids = data.clientTripIds;
    if (ids.length === 0) return null;
    if (ids.length > 1) return '/trips';
    const id: unknown = ids[0];
    return typeof id === 'string' && TRIP_ID.test(id) ? `/trips/${id}/summary` : FALLBACK_HREF;
  }
  return FALLBACK_HREF;
}

export function routeForResponse(
  response: Notifications.NotificationResponse | null | undefined
): NotificationRoute | null {
  const r: unknown = response;
  if (!isRecord(r) || typeof r.actionIdentifier !== 'string') return null;
  const notification = r.notification;
  if (!isRecord(notification) || !isRecord(notification.request)) return null;
  const content = notification.request.content;
  if (!isRecord(content)) return null;

  const action = r.actionIdentifier;
  const role = Object.prototype.hasOwnProperty.call(ROLE_ACTIONS, action)
    ? ROLE_ACTIONS[action as keyof typeof ROLE_ACTIONS]
    : undefined;
  // A dismissal or any other system action is not a request to open anything.
  if (action !== Notifications.DEFAULT_ACTION_IDENTIFIER && role === undefined) return null;

  const href = urlOf(content.data);
  if (href === null) return null;
  const clientTripId = SUMMARY_HREF.exec(href)?.[1];
  if (clientTripId === undefined) return { href };
  return role === undefined ? { href, clientTripId } : { href, clientTripId, role };
}

export interface ResponseDeps {
  db: Db;
  navigate(href: string): void;
  /** True while the app must not navigate: a drive under way, or no navigator yet. */
  isBusy(): boolean;
  setTripRole?: typeof defaultSetTripRole;
  /** After a role write, so the screens showing the trip refresh. */
  onTripChanged?(clientTripId: string): void | Promise<void>;
  /** Removes the answered notification from the tray. */
  dismiss?(identifier: string): Promise<void>;
  now?(): number;
  onError?(e: unknown, ctx: string): void;
}

export type RoleOutcome = 'applied' | 'missing-trip' | 'failed';

export type ResponseOutcome =
  | { kind: 'ignored' }
  | { kind: 'navigated' | 'deferred'; href: string; role?: RoleOutcome };

/** Most recent last, each id once, at most `OPENED_TRIPS_MAX`. */
export async function recordOpenedTrip(db: Db, clientTripId: string): Promise<void> {
  const settings = createSettingsRepo(db);
  const stored = await settings.get<unknown>(OPENED_TRIPS_KEY);
  const previous = Array.isArray(stored)
    ? stored.filter((id): id is string => typeof id === 'string' && id !== clientTripId)
    : [];
  await settings.set(OPENED_TRIPS_KEY, [...previous, clientTripId].slice(-OPENED_TRIPS_MAX));
}

async function applyRole(
  response: Notifications.NotificationResponse,
  clientTripId: string,
  role: ChosenRole,
  deps: ResponseDeps,
  now: number
): Promise<RoleOutcome> {
  const write = deps.setTripRole ?? defaultSetTripRole;
  const report = deps.onError ?? (() => {});
  let outcome: RoleOutcome;
  try {
    await write(deps.db, clientTripId, role, now);
    outcome = 'applied';
  } catch (e) {
    if (!(e instanceof MissingTripError)) {
      // Kept in the tray: the driver can answer again, or on the summary this tap opens.
      report(e, 'notifications.role');
      return 'failed';
    }
    // Not on this phone (deleted, or wiped by a handover): the summary says what it knows.
    outcome = 'missing-trip';
  }
  if (outcome === 'applied') {
    try {
      await deps.onTripChanged?.(clientTripId);
    } catch (e) {
      report(e, 'notifications.refresh');
    }
  }
  const identifier = response.notification.request.identifier;
  await deps.dismiss?.(identifier).catch((e: unknown) => report(e, 'notifications.dismiss'));
  return outcome;
}

export async function handleResponse(
  response: Notifications.NotificationResponse | null | undefined,
  deps: ResponseDeps
): Promise<ResponseOutcome> {
  const route = routeForResponse(response);
  if (route === null || !response) return { kind: 'ignored' };
  const now = (deps.now ?? Date.now)();
  const report = deps.onError ?? (() => {});

  let role: RoleOutcome | undefined;
  if (route.role !== undefined && route.clientTripId !== undefined) {
    role = await applyRole(response, route.clientTripId, route.role, deps, now);
  }

  if (route.clientTripId !== undefined) {
    await recordOpenedTrip(deps.db, route.clientTripId).catch((e: unknown) =>
      report(e, 'notifications.opened')
    );
  }

  const withRole = role === undefined ? {} : { role };
  if (deps.isBusy()) {
    await createSettingsRepo(deps.db)
      .set(PENDING_HREF_KEY, { href: route.href, at: now })
      .catch((e: unknown) => report(e, 'notifications.pending'));
    return { kind: 'deferred', href: route.href, ...withRole };
  }
  deps.navigate(route.href);
  return { kind: 'navigated', href: route.href, ...withRole };
}

export type ReplayOutcome =
  | { kind: 'none' | 'busy' | 'expired' }
  | { kind: 'navigated'; href: string };

/** Delivers the held tap, once, if the app may navigate now and the tap is not stale. */
export async function replayPendingHref(
  deps: Pick<ResponseDeps, 'db' | 'navigate' | 'isBusy' | 'now'>
): Promise<ReplayOutcome> {
  if (deps.isBusy()) return { kind: 'busy' };
  const settings = createSettingsRepo(deps.db);
  const stored = await settings.get<unknown>(PENDING_HREF_KEY);
  if (stored === null) return { kind: 'none' };
  // A drive may have begun during the read; the tap waits for that one too.
  if (deps.isBusy()) return { kind: 'busy' };
  await settings.remove(PENDING_HREF_KEY);
  const now = (deps.now ?? Date.now)();
  if (
    !isRecord(stored) ||
    typeof stored.at !== 'number' ||
    now - stored.at > PENDING_HREF_MAX_AGE_MS
  ) {
    return { kind: 'expired' };
  }
  const href = allowHref(stored.href);
  deps.navigate(href);
  return { kind: 'navigated', href };
}

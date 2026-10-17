import type { EngineStatus } from '@/core/engine/engine.types';
import type { SettingsRepo } from '@/data/db/settings';
import { isBusyStatus, tripRecords } from '@/drive/policy';
import { ONBOARDING_PENDING_HREF_KEY } from '@/features/onboarding/state';
import { ALLOWED_HREFS, isAllowedHref } from '@/features/notifications/hrefs';

import type { UpdateStatus } from './version';

/**
 * Where a driver belongs, as pure functions of the facts the app holds, so every case can be
 * reasoned about (and tested) without a navigator. `resolveStart` answers the cold start at `/`
 * (A1); `resolveGate` answers every later change — signing in or out, a profile arriving, the
 * minimum version rising — for a driver who is already somewhere.
 */
export type SessionStatus = 'loading' | 'signedOut' | 'signedIn';

/** What the profile allows: not known yet, setup still owed, or the app. */
export type ProfileGate = 'unknown' | 'onboarding' | 'ready';

/**
 * The drive, as the gates need it.
 * - `busy`: the host is busy (recording, ending or finalizing). No gate moves anyone then (rev1:
 *   I10): a setup or update screen must never replace a drive.
 * - `tripOpen`: a confirmed trip is open (recording or ending). Only then does a relaunch go back
 *   to the driving screen.
 */
export interface DriveFacts {
  busy: boolean;
  tripOpen: boolean;
}

export function driveFacts(snapshot: { status: EngineStatus }, hostBusy: boolean): DriveFacts {
  return {
    busy: hostBusy || isBusyStatus(snapshot.status),
    tripOpen: tripRecords(snapshot.status),
  };
}

const isRecord = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v);

const filled = (v: unknown): boolean => typeof v === 'string' && v.trim().length > 0;

/**
 * Setup is done once the account has a username and the server has stamped `onboarded_at`. Read
 * loosely: the profile row's generated type is being rebuilt, and a row without either column
 * simply reads as setup still owed.
 */
export function profileGate(profile: unknown): ProfileGate {
  if (!isRecord(profile)) return 'unknown';
  return filled(profile.onboarded_at) && filled(profile.username) ? 'ready' : 'onboarding';
}

export const ONBOARDING_START = '/(onboarding)/start';
export const HOME = '/(tabs)/home';
export const SIGN_IN = '/(auth)/sign-in';
export const UPDATE_REQUIRED = '/update-required';
export const DRIVE = '/drive';

export type StartRoute =
  | typeof SIGN_IN
  | typeof ONBOARDING_START
  | typeof HOME
  | typeof UPDATE_REQUIRED
  | typeof DRIVE;

/**
 * A1. Null means "hold the frame": the session is still being read, the config cache has not been
 * read (`update === null`), or the profile is not known yet (the launch router shows its retry
 * after 10 s).
 */
export function resolveStart(
  status: SessionStatus,
  gate: ProfileGate,
  update: UpdateStatus | null,
  drive: DriveFacts
): StartRoute | null {
  // A relaunch into an open trip goes straight back to it, before any other rule. Nothing else may
  // stand between a driver and the drive under way.
  if (drive.tripOpen) return DRIVE;
  if (update === null) return null;
  if (update === 'required') return UPDATE_REQUIRED;
  // While the stored session is still being read nobody may be sent anywhere, or a warm start
  // flashes the sign-in screen at a signed-in driver.
  if (status === 'loading') return null;
  if (status === 'signedOut') return SIGN_IN;
  return gateRoute(gate);
}

function gateRoute(gate: ProfileGate): StartRoute | null {
  switch (gate) {
    case 'unknown':
      return null;
    case 'onboarding':
      return ONBOARDING_START;
    case 'ready':
      return HOME;
  }
}

export type GateRoute =
  | '/'
  | typeof SIGN_IN
  | typeof ONBOARDING_START
  | typeof HOME
  | typeof UPDATE_REQUIRED;

export function resolveGate(
  status: SessionStatus,
  gate: ProfileGate,
  update: UpdateStatus,
  segments: readonly string[],
  drive: DriveFacts
): GateRoute | null {
  // rev1: I10 — no redirect of any kind while a drive is under way or the driving screen is showing.
  // The effect re-runs when the host goes idle, and the gate answers then.
  if (drive.busy || segments[0] === 'drive') return null;
  // `/` is the launch router's own screen and `resolveStart` is already deciding it. Answering as
  // well would mount the destination twice before the two agreed on it.
  if (segments.length === 0) return null;

  const onUpdateScreen = segments[0] === 'update-required';
  if (update === 'required') return onUpdateScreen ? null : UPDATE_REQUIRED;
  // The screen is shown only for a known, required update. Updated, or offline and unknown: the
  // launch router decides afresh.
  if (onUpdateScreen) return '/';

  // Nothing is known yet. Moving now would throw a signed-in driver at sign-in on every warm start.
  if (status === 'loading') return null;

  const inAuthGroup = segments[0] === '(auth)';
  // `app/auth/callback.tsx` sits outside the group: it is a deep-link landing pad (diagnostics
  // builds' magic link), not a screen anyone should be left on once its session has arrived.
  const onCallback = segments[0] === 'auth' && segments[1] === 'callback';
  const inOnboarding = segments[0] === '(onboarding)';

  // Every magic-link landing starts signed out, and the exchange is a network round trip away.
  if (status === 'signedOut') return inAuthGroup || onCallback ? null : SIGN_IN;

  switch (gate) {
    // The profile is not known yet (a first launch whose read failed). Stay put, but not on a
    // sign-in screen: the launch router holds the frame and offers the retry.
    case 'unknown':
      return inAuthGroup || onCallback ? '/' : null;
    // From anywhere outside onboarding — the tabs, the app stack, the sign-in screen and the
    // callback alike.
    case 'onboarding':
      return inOnboarding ? null : ONBOARDING_START;
    case 'ready':
      return inAuthGroup || onCallback || inOnboarding ? HOME : null;
  }
}

/** A friend link's landing (`roadwise://add/<name>` → `/u/<name>`). */
const PROFILE_HREF = /^\/u\/([a-z0-9_]{3,20})$/;
const ADD_LINK = /^\/add\/([A-Za-z0-9_]{3,20})$/;
/** A clan invite: `roadwise://clan/<code>`, or its landing `/clan/join?code=<code>`. */
const CLAN_LINK = /^\/clan\/([A-Za-z0-9]{8})$/;
export const CLAN_JOIN_HREF = /^\/clan\/join\?code=([A-Z0-9]{8})$/;
const CLAN_JOIN_LOOSE = /^\/clan\/join\?code=([A-Za-z0-9]{8})$/;

/**
 * The deep links the onboarding gate holds for later (`onboarding.pendingHref`): the shapes the
 * notification router allows (Task 5), plus a friend's profile and a clan invite, which a new
 * driver is the most likely to open before setup.
 * Anchored, and normalised to one form each, so a held value can only ever be one of these screens.
 */
export const PENDING_HREF_ALLOWLIST: readonly RegExp[] = [...ALLOWED_HREFS, PROFILE_HREF, CLAN_JOIN_HREF];

export function pendingHrefFor(pathname: unknown): string | null {
  if (typeof pathname !== 'string') return null;
  if (isAllowedHref(pathname) || PROFILE_HREF.test(pathname) || CLAN_JOIN_HREF.test(pathname)) return pathname;
  const add = ADD_LINK.exec(pathname);
  if (add) return `/u/${add[1]!.toLowerCase()}`;
  const clan = CLAN_LINK.exec(pathname) ?? CLAN_JOIN_LOOSE.exec(pathname);
  if (clan) return `/clan/join?code=${clan[1]!.toUpperCase()}`;
  return null;
}

/** The invite code a held clan link carries, for the onboarding clan step to prefill; else null. */
export function heldClanCode(href: string | null): string | null {
  return href === null ? null : (CLAN_JOIN_HREF.exec(href)?.[1] ?? null);
}

/**
 * Where setup ends for a held link: the link itself, except a clan invite, which the clan step has
 * already offered (prefilled) — opening it again after a join would only say "already in a clan".
 */
export function exitHref(href: string | null): string | null {
  return href !== null && heldClanCode(href) === null ? href : null;
}

/**
 * Holds an allowlisted deep link for `finishOnboarding`, bound to the account it arrived for
 * (`{ uid, href }`, M5 T12 r1); anything else is ignored.
 */
export async function savePendingHref(settings: SettingsRepo, pathname: unknown, uid: string): Promise<boolean> {
  const href = pendingHrefFor(pathname);
  if (href === null || uid.length === 0) return false;
  await settings.set(ONBOARDING_PENDING_HREF_KEY, { uid, href });
  return true;
}

/**
 * The deep link held for `uid`, re-checked against the allowlist on the way out; null when none.
 * A link held for another account, a malformed value, or a bare string from an older build is
 * removed and reads as none, so no account ever inherits another's held link.
 */
export async function readPendingHref(settings: SettingsRepo, uid: string): Promise<string | null> {
  try {
    const raw = await settings.get<unknown>(ONBOARDING_PENDING_HREF_KEY);
    if (raw === null) return null;
    const record = typeof raw === 'object' && !Array.isArray(raw) ? (raw as Record<string, unknown>) : null;
    const href = record !== null && record.uid === uid ? pendingHrefFor(record.href) : null;
    if (href === null) await settings.remove(ONBOARDING_PENDING_HREF_KEY);
    return href;
  } catch {
    return null;
  }
}

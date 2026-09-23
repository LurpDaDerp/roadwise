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

/** What the profile allows: not known yet, an under-13 account, setup still owed, or the app. */
export type ProfileGate = 'unknown' | 'blocked' | 'onboarding' | 'ready';

/**
 * The drive, as the gates need it.
 * - `busy`: the host is busy (candidate, recording, ending or finalizing). No gate moves anyone
 *   then (rev1: I10): a setup or update screen must never replace a drive (SR1, SR7).
 * - `tripOpen`: a confirmed trip is open (recording or ending). Only then does a relaunch go back
 *   to the drive screen (N-m3): a candidate may be a bus ride, and finalizing is already over.
 * - `mode`: which drive screen that is — mounted is the HUD, anything else the pocket screen.
 */
export interface DriveFacts {
  busy: boolean;
  mode: 'mounted' | 'pocket' | 'auto' | null;
  tripOpen: boolean;
}

export function driveFacts(
  snapshot: { status: EngineStatus; mode: 'mounted' | 'pocket' | 'auto' },
  hostBusy: boolean
): DriveFacts {
  return {
    busy: hostBusy || isBusyStatus(snapshot.status),
    mode: snapshot.mode,
    tripOpen: tripRecords(snapshot.status),
  };
}

/** The slice of a profile row the gate reads. */
export interface GateProfile {
  age_band?: string | null;
  flags?: unknown;
}

export function profileGate(profile: GateProfile | null | undefined): ProfileGate {
  if (!profile) return 'unknown';
  // Checked before `onboarded`: an account that is (or has become) under 13 is blocked whatever
  // its flags say.
  if (profile.age_band === 'u13') return 'blocked';
  const flags = profile.flags;
  const onboarded =
    typeof flags === 'object' && flags !== null && (flags as { onboarded?: unknown }).onboarded === true;
  return onboarded ? 'ready' : 'onboarding';
}

export const ONBOARDING_START = '/(onboarding)/start';
export const NOT_ELIGIBLE = '/(onboarding)/not-eligible';
export const HOME = '/(tabs)/home';
export const WELCOME = '/(auth)/welcome';
export const UPDATE_REQUIRED = '/update-required';
export const DRIVE_HUD = '/drive/hud';
export const DRIVE_POCKET = '/drive/pocket';

export type StartRoute =
  | typeof WELCOME
  | typeof ONBOARDING_START
  | typeof NOT_ELIGIBLE
  | typeof HOME
  | typeof UPDATE_REQUIRED
  | typeof DRIVE_HUD
  | typeof DRIVE_POCKET;

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
  // A relaunch into an open trip goes straight back to it, before any other rule (rev1: I2,
  // C3/C4). Nothing else may stand between a driver and the drive under way.
  if (drive.tripOpen) return drive.mode === 'mounted' ? DRIVE_HUD : DRIVE_POCKET;
  if (update === null) return null;
  if (update === 'required') return UPDATE_REQUIRED;
  // While the stored session is still being read nobody may be sent anywhere, or a warm start
  // flashes the sign-in screen at a signed-in driver.
  if (status === 'loading') return null;
  if (status === 'signedOut') return WELCOME;
  return gateRoute(gate);
}

function gateRoute(gate: ProfileGate): StartRoute | null {
  switch (gate) {
    case 'unknown':
      return null;
    case 'blocked':
      return NOT_ELIGIBLE;
    case 'onboarding':
      return ONBOARDING_START;
    case 'ready':
      return HOME;
  }
}

export type GateRoute =
  | '/'
  | typeof WELCOME
  | typeof ONBOARDING_START
  | typeof NOT_ELIGIBLE
  | typeof HOME
  | typeof UPDATE_REQUIRED;

export function resolveGate(
  status: SessionStatus,
  gate: ProfileGate,
  update: UpdateStatus,
  segments: readonly string[],
  drive: DriveFacts
): GateRoute | null {
  // rev1: I10 — no redirect of any kind while a drive is under way or a drive screen is showing.
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

  // Nothing is known yet. Moving now would throw a signed-in driver at Welcome on every warm start.
  if (status === 'loading') return null;

  const inAuthGroup = segments[0] === '(auth)';
  // `app/auth/callback.tsx` sits outside the group: it is a deep-link landing pad, not a screen
  // anyone should be left on once the session it was carrying has arrived.
  const onCallback = segments[0] === 'auth' && segments[1] === 'callback';
  const inOnboarding = segments[0] === '(onboarding)';

  // Every magic-link landing starts signed out, and the exchange is a network round trip away.
  // Moving now would unmount the callback mid-flight — and an expired link would never get to
  // show its retry. The screen speaks for itself: it either flips to signedIn or says why not.
  if (status === 'signedOut') return inAuthGroup || onCallback ? null : WELCOME;

  switch (gate) {
    // The profile is not known yet (a first launch whose read failed). Stay put, but not on a
    // sign-in screen: the launch router holds the frame and offers the retry.
    case 'unknown':
      return inAuthGroup || onCallback ? '/' : null;
    // The stepper routes within onboarding itself: an under-13 flow is only `not-eligible`.
    case 'blocked':
      return inOnboarding ? null : NOT_ELIGIBLE;
    // From anywhere outside onboarding — the tabs, the app stack, a sign-in screen and the
    // callback alike (closes M0 M-13: the callback can no longer skip setup).
    case 'onboarding':
      return inOnboarding ? null : ONBOARDING_START;
    case 'ready':
      return inAuthGroup || onCallback || inOnboarding ? HOME : null;
  }
}

/**
 * The deep links the onboarding gate holds for later (`onboarding.pendingHref`), which
 * `finishOnboarding` opens instead of Home. The same shapes the notification router allows
 * (Task 5), anchored, so a held value can only ever be one of these screens.
 */
export const PENDING_HREF_ALLOWLIST: readonly RegExp[] = ALLOWED_HREFS;

export function pendingHrefFor(pathname: unknown): string | null {
  return isAllowedHref(pathname) ? pathname : null;
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

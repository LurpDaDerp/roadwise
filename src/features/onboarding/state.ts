import { normaliseReferralCode } from '@scoring';

import type { SettingsRepo } from '@/data/db/settings';
import { JOIN_HREF } from '@/features/notifications/hrefs';

import { isStepId, type StepId } from './flow';

/**
 * Where onboarding was left, on this device, for this owner. Every key lives in `settings`, which a
 * handover wipes with the rest of the previous driver's local state, so none needs an owner id.
 */
export const ONBOARDING_STEP_KEY = 'onboarding.step';
/** The steps the walk had counted at the saved step, so a resume keeps "Step n of total" (T11 m1). */
export const ONBOARDING_PLAN_KEY = 'onboarding.plan';
/**
 * A deep link that arrived while onboarding was still owed (Task 17 stores it, allowlisted);
 * `finishOnboarding` (Task 14) opens it instead of Home. Stored as `{ uid, href }` and returned
 * only to that account (M5 T12 r1): a bare string written by an older build reads as no hold.
 */
export const ONBOARDING_PENDING_HREF_KEY = 'onboarding.pendingHref';

/** The last step shown, or null. A value this build does not know (a retired step) reads as none. */
export async function readSavedStep(settings: SettingsRepo): Promise<StepId | null> {
  const value = await settings.get<unknown>(ONBOARDING_STEP_KEY);
  return isStepId(value) ? value : null;
}

export async function saveStep(settings: SettingsRepo, step: StepId): Promise<void> {
  await settings.set(ONBOARDING_STEP_KEY, step);
}

/** The steps counted for "Step n of total" when the step was saved, so a resume keeps the count. */
export async function readSavedPlan(settings: SettingsRepo): Promise<StepId[]> {
  const value = await settings.get<unknown>(ONBOARDING_PLAN_KEY);
  return Array.isArray(value) ? value.filter(isStepId) : [];
}

export async function savePlan(settings: SettingsRepo, plan: readonly StepId[]): Promise<void> {
  await settings.set(ONBOARDING_PLAN_KEY, plan);
}

// ---------------------------------------------------------------------------------------------
// A6–A8: the permission consents (`location`, `motion`, `notifications`) the steps record on a
// grant. One the server did not take (offline) waits here, bound to the account it was given by,
// and `finishOnboarding` sends it — never under another account.
// ---------------------------------------------------------------------------------------------

/**
 * The version a permission consent records: the A6–A8 primer wording the driver agreed under.
 * Bump it whenever that wording changes what it says about the use.
 */
export const PERMISSION_CONSENT_VERSION = 'primer-1';

export type PermissionConsentType = 'location' | 'motion' | 'notifications';
const CONSENT_TYPES: readonly PermissionConsentType[] = ['location', 'motion', 'notifications'];

/** Settings key: `{ userId, types }`, the grants whose consent is still owed to the server. */
export const PENDING_PERMISSION_CONSENTS_KEY = 'onboarding.pendingPermissionConsents';

export interface PendingPermissionConsents {
  userId: string;
  types: PermissionConsentType[];
}

/** What is owed for `userId`: another account's record, or a malformed one, reads as nothing. */
export async function readPendingPermissionConsents(
  settings: SettingsRepo,
  userId: string
): Promise<PermissionConsentType[]> {
  const raw = await settings.get<unknown>(PENDING_PERMISSION_CONSENTS_KEY);
  if (raw === null || typeof raw !== 'object') return [];
  const { userId: owner, types } = raw as Record<string, unknown>;
  if (owner !== userId || !Array.isArray(types)) return [];
  return CONSENT_TYPES.filter((t) => types.includes(t));
}

/** Adds `type` to what `userId` owes. A record held for another account is replaced. */
export async function addPendingPermissionConsent(
  settings: SettingsRepo,
  userId: string,
  type: PermissionConsentType
): Promise<void> {
  const held = await readPendingPermissionConsents(settings, userId);
  const types = held.includes(type) ? held : [...held, type];
  await settings.set(PENDING_PERMISSION_CONSENTS_KEY, { userId, types } satisfies PendingPermissionConsents);
}

/** Writes what is still owed after a flush; nothing owed removes the key. */
export async function savePendingPermissionConsents(
  settings: SettingsRepo,
  userId: string,
  types: readonly PermissionConsentType[]
): Promise<void> {
  if (types.length === 0) {
    await settings.remove(PENDING_PERMISSION_CONSENTS_KEY);
    return;
  }
  await settings.set(PENDING_PERMISSION_CONSENTS_KEY, { userId, types: [...types] } satisfies PendingPermissionConsents);
}

export async function clearOnboardingState(settings: SettingsRepo): Promise<void> {
  await settings.remove(ONBOARDING_STEP_KEY);
  await settings.remove(ONBOARDING_PLAN_KEY);
  await settings.remove(ONBOARDING_PENDING_HREF_KEY);
}

// ---------------------------------------------------------------------------------------------
// The signed-out invite hold (M5 T12 round 1, the "JOIN HOLD" ruling). A `/join/<CODE>` link that
// arrives while nobody is signed in is kept in ONE slot so the person who signs up next can be
// asked about it once. It binds to the first account that signs in; a different account, a
// sign-out before it is used, 24 h, an under-13 account or an account that can't use a code all
// drop it. It is only ever navigated to: the join screen still needs the Use code tap. Nothing
// here is logged.
// ---------------------------------------------------------------------------------------------

/** Settings key: `{ href, heldAt, uid }`, the one held invite link. */
export const HELD_JOIN_KEY = 'auth.heldJoin';

/** An invite held longer than this is dropped on the next read (a future `heldAt` too). */
export const HELD_JOIN_TTL_MS = 24 * 60 * 60_000;

export interface HeldJoin {
  /** Canonical: `/join/` and the 8-character code, upper case. */
  href: string;
  /** Epoch ms of the capture. */
  heldAt: number;
  /** The account it is bound to; null until the first sign-in after the capture. */
  uid: string | null;
}

/**
 * `pathname` as a canonical invite link (`/join/ABCD2345`), or null. One path segment only (no
 * query, fragment or further path), cleaned the way a typed code is (upper case, no spaces or
 * hyphens) and then held to the one allowlist's `JOIN_HREF`.
 */
export function joinHrefFor(pathname: unknown): string | null {
  if (typeof pathname !== 'string') return null;
  const match = /^\/join\/([^/?#]+)$/.exec(pathname);
  if (!match || match[1] === undefined) return null;
  let raw: string;
  try {
    raw = decodeURIComponent(match[1]);
  } catch {
    return null;
  }
  const href = `/join/${normaliseReferralCode(raw)}`;
  return JOIN_HREF.test(href) ? href : null;
}

/** A stored value as a live hold: exactly the three keys, canonical, unexpired. Null otherwise. */
function liveHold(raw: unknown, now: number): HeldJoin | null {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const record = raw as Record<string, unknown>;
  if (Object.keys(record).sort().join(',') !== 'heldAt,href,uid') return null;
  const { href, heldAt, uid } = record;
  if (typeof href !== 'string' || joinHrefFor(href) !== href) return null;
  if (typeof heldAt !== 'number' || !Number.isFinite(heldAt)) return null;
  if (heldAt > now || now - heldAt >= HELD_JOIN_TTL_MS) return null;
  if (uid !== null && (typeof uid !== 'string' || uid.length === 0)) return null;
  return { href, heldAt, uid };
}

/** Holds an invite link that arrived signed out, unbound, replacing any earlier one. */
export async function holdJoin(settings: SettingsRepo, pathname: unknown, now: number): Promise<boolean> {
  const href = joinHrefFor(pathname);
  if (href === null) return false;
  await settings.set(HELD_JOIN_KEY, { href, heldAt: now, uid: null } satisfies HeldJoin);
  return true;
}

/**
 * The held invite for `uid` (null while signed out), re-validated. An expired, malformed or
 * foreign-bound slot is removed and reads as none; an unbound one is returned as it is.
 */
export async function readHeldJoin(settings: SettingsRepo, now: number, uid: string | null): Promise<HeldJoin | null> {
  const raw = await settings.get<unknown>(HELD_JOIN_KEY);
  if (raw === null) return null;
  const hold = liveHold(raw, now);
  if (hold === null || (hold.uid !== null && hold.uid !== uid)) {
    await settings.remove(HELD_JOIN_KEY);
    return null;
  }
  return hold;
}

/**
 * Binds the held invite to the account that just signed in: an unbound slot takes `uid`, a slot
 * bound to `uid` stays, a slot bound to anyone else is removed. Returns the bound hold or null.
 */
export async function bindHeldJoin(settings: SettingsRepo, uid: string, now: number): Promise<HeldJoin | null> {
  const hold = await readHeldJoin(settings, now, uid);
  if (hold === null) return null;
  if (hold.uid === uid) return hold;
  const bound: HeldJoin = { ...hold, uid };
  await settings.set(HELD_JOIN_KEY, bound);
  return bound;
}

export async function clearHeldJoin(settings: SettingsRepo): Promise<void> {
  await settings.remove(HELD_JOIN_KEY);
}

/**
 * For the handover wipe (security R4): the one thing it may carry across. Only a live hold that is
 * unbound — or already bound to the incoming account itself, when the gate bound it before the
 * wipe ran — is returned; one bound to the previous owner never is.
 */
export async function takeCarriableHeldJoin(
  settings: SettingsRepo,
  now: number,
  incomingUid: string
): Promise<Pick<HeldJoin, 'href' | 'heldAt'> | null> {
  const hold = liveHold(await settings.get<unknown>(HELD_JOIN_KEY), now);
  if (hold === null || (hold.uid !== null && hold.uid !== incomingUid)) return null;
  return { href: hold.href, heldAt: hold.heldAt };
}

/** Writes a carried hold back after the wipe, bound to the incoming account. */
export async function restoreCarriedHeldJoin(
  settings: SettingsRepo,
  carried: Pick<HeldJoin, 'href' | 'heldAt'>,
  uid: string
): Promise<void> {
  await settings.set(HELD_JOIN_KEY, { href: carried.href, heldAt: carried.heldAt, uid } satisfies HeldJoin);
}

/**
 * Invite links the app itself opened from a hold, in this process: the join screen reads the mark
 * so an account that can't use a code is sent Home silently instead of being told why (security
 * R6). Opening a link directly is never marked, so that path keeps its explanations.
 */
const heldArrivals = new Set<string>();

export function markHeldJoinArrival(href: string): void {
  heldArrivals.add(href);
}

export function isHeldJoinArrival(href: string): boolean {
  return heldArrivals.has(href);
}

export function clearHeldJoinArrival(href: string): void {
  heldArrivals.delete(href);
}

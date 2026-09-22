/**
 * The onboarding steps' server and device calls: the write-once birth date, the profile basics,
 * the under-13 clean-up (Task 12) and the guardian invite (Task 13).
 *
 * Every Supabase call goes through the app client and the M0 wrappers, so the column lists and the
 * RLS scoping are the ones the rest of the app already relies on. Nothing here decides a route;
 * the steps do that from what these return.
 */
import { LAST_USER_KEY, PENDING_OWNER_KEY } from '@/boot/device';
import { APP_CONFIG_KEY } from '@/data/config/appConfig';
import type { Db } from '@/data/db/driver';
import { createSettingsRepo } from '@/data/db/settings';
import { emitDataChanged } from '@/data/events';
import { supabase } from '@/data/supabase/client';
import { recordConsent, updateOwnProfile, type Profile } from '@/data/supabase/profile';
import { TRACES_BUCKET } from '@/data/sync/runner';
import { SESSION_UID_KEY } from '@/data/sync/queue';
import { createExpoTraceFs } from '@/data/sync/traceFs';
import type { LegalState } from '@/features/auth/legal';
import { DISCLAIMER_ACK_KEY, type ConsentRow, type TermsType } from '@/features/auth/pendingConsent';
import { PROFILE_CACHE_KEY } from '@/features/auth/profileCache';

import type { AgeBand, DrivingStage } from './flow';
import { ONBOARDING_PLAN_KEY, ONBOARDING_STEP_KEY } from './state';

// ---------------------------------------------------------------------------------------------
// Birth date (write-once, 0001 `set_birth_date`).
// ---------------------------------------------------------------------------------------------

export type SetBirthDateResult = 'set' | 'already-set';

/** 0001's refusal of a second write: `insufficient_privilege` with exactly this message. */
const ALREADY_SET = 'birth date already set';

interface PgError {
  code?: string;
  message?: string;
}

/**
 * Store the confirmed birth date (`YYYY-MM-DD`). The server keeps the first one it is given and
 * derives the age band from it (a trigger, so the band has moved by the time this resolves); a
 * second write is refused and reported as `'already-set'`, which the caller treats as done — the
 * date on the account is the one that counts. Anything else rejects.
 */
export async function setBirthDate(iso: string): Promise<SetBirthDateResult> {
  const { error } = await supabase.rpc('set_birth_date', { p_birth_date: iso });
  if (!error) return 'set';
  const pg = error as PgError;
  if (pg.code === '42501' && pg.message === ALREADY_SET) return 'already-set';
  throw error;
}

export interface PrivateProfile {
  /** `YYYY-MM-DD`, or null while the driver has not answered. */
  birthDate: string | null;
}

/** The caller's own `private_profiles` row (RLS: owner only). Rejects when it cannot be read. */
export async function readPrivateProfile(userId: string): Promise<PrivateProfile> {
  const { data, error } = await supabase
    .from('private_profiles')
    .select('birth_date')
    .eq('user_id', userId)
    .single();
  if (error) throw error;
  return { birthDate: data?.birth_date ?? null };
}

/**
 * The age band the server derived, read straight from the row rather than from the session's copy:
 * the session's profile state lands on a later render than the refresh that fetched it, and the
 * under-13 branch must not guess.
 */
export async function readAgeBand(userId: string): Promise<AgeBand> {
  const { data, error } = await supabase
    .from('profiles')
    .select('age_band')
    .eq('id', userId)
    .single();
  if (error) throw error;
  const band = data?.age_band;
  return band === 'u13' || band === '13_17' || band === '18_plus' ? band : 'unknown';
}

/** A4's name and driving stage, through the only profile write path (M0). */
export function saveProfileBasics(
  userId: string,
  basics: { displayName: string; drivingStage: Exclude<DrivingStage, 'unknown'> }
): Promise<Profile> {
  return updateOwnProfile(userId, {
    display_name: basics.displayName,
    driving_stage: basics.drivingStage,
  });
}

/**
 * Acknowledge the disclaimer on the account: `flags.disclaimerAcknowledged = version`, merged on
 * the server by T2's caller-own `merge_own_profile_flags` (`flags || patch`), so a concurrent
 * write of another flag is never overwritten by a read-modify-write here. Rejects on failure.
 */
export async function acknowledgeDisclaimer(version: string): Promise<void> {
  const { error } = await supabase.rpc('merge_own_profile_flags', {
    patch: { disclaimerAcknowledged: version },
  });
  if (error) throw error;
}

/** The account's Terms and Privacy consents (RLS: owner only). Rejects when they cannot be read. */
export async function fetchOwnConsents(userId: string): Promise<ConsentRow[]> {
  const { data, error } = await supabase
    .from('consents')
    .select('type,version,revoked_at')
    .eq('user_id', userId)
    .in('type', ['tos', 'privacy']);
  if (error) throw error;
  return data ?? [];
}

/**
 * The signed-in Terms step's acceptance (rev1: I7): a live `tos` and `privacy` consent at the
 * versions published now, recording only a type the account does not already hold at that
 * version, so a retry after a partial failure records nothing twice. Unpublished, it records
 * nothing and makes no call — a consent to a document nobody can open is not one. Returns what it
 * recorded; rejects on a failed read or write.
 *
 * The sign-in screen's pending acceptance (`markTermsAccepted` / `flushPendingConsents`) is not
 * used here: it is honoured only by the sign-in visit that made it, and this tick is made by an
 * account already signed in.
 */
export async function recordCurrentTerms(userId: string, legal: LegalState): Promise<TermsType[]> {
  if (!legal.published || !legal.tos || !legal.privacy) return [];
  const current: Record<TermsType, string> = { tos: legal.tos.version, privacy: legal.privacy.version };
  const held = await fetchOwnConsents(userId);
  const recorded: TermsType[] = [];
  for (const type of ['tos', 'privacy'] as const) {
    if (held.some((c) => c.type === type && c.version === current[type] && !c.revoked_at)) continue;
    await recordConsent(userId, { type, version: current[type] });
    recorded.push(type);
  }
  return recorded;
}

// ---------------------------------------------------------------------------------------------
// A5: the guardian invite (0006 `create_guardian_invite` / `guardian_link_state`). Dark: the step
// that calls these is in the flow only while `feature_flags.guardian_invites` is on, which M6 sets
// when redemption ships (rev1: I6); the server refuses the invite while the flag is off, too.
// ---------------------------------------------------------------------------------------------

export type GuardianLinkStatus = 'none' | 'pending' | 'linked' | 'declined' | 'expired';

export interface GuardianLink {
  status: GuardianLinkStatus;
  /** When the live code stops working; null unless the server has one to report. */
  expiresAt: string | null;
}

export interface GuardianInvite {
  /** Six characters from 0006's alphabet. Shown and shared once; the server keeps only a hash. */
  code: string;
  expiresAt: string;
}

/**
 * The refusals the step says something specific about. Anything else rejects as it came and is
 * reported as a plain failure.
 */
export type GuardianInviteFailure = 'rate-limited' | 'already-linked' | 'not-available';

export class GuardianInviteError extends Error {
  readonly reason: GuardianInviteFailure;
  constructor(reason: GuardianInviteFailure) {
    super(`guardian invite refused: ${reason}`);
    this.name = 'GuardianInviteError';
    this.reason = reason;
  }
}

/** 0006's refusals, matched on code AND the exact message (a 42501 alone says nothing). */
const GUARDIAN_REFUSALS: readonly { code: string; message: string; reason: GuardianInviteFailure }[] = [
  { code: '42501', message: 'invite limit reached', reason: 'rate-limited' },
  { code: '22023', message: 'guardian already linked', reason: 'already-linked' },
  { code: '42501', message: 'guardian invites are not available yet', reason: 'not-available' },
  // An account that is not 13–17 (an adult, or a band the step's context had not caught up with).
  { code: '42501', message: 'guardian invites are for drivers under 18', reason: 'not-available' },
];

/** `ABCDEFGHJKMNPQRSTUVWXYZ23456789`, six of them: what 0006 draws from. */
const INVITE_CODE = /^[ABCDEFGHJKMNPQRSTUVWXYZ23456789]{6}$/;
const LINK_STATUSES: readonly GuardianLinkStatus[] = ['none', 'pending', 'linked', 'declined', 'expired'];

/**
 * Issue a guardian invite for the caller. The server revokes any earlier live code, so a caller
 * that still holds a code should share that one again rather than call this. Rejects with a
 * `GuardianInviteError` for a refusal the step can name, or with the error as it came.
 */
export async function createGuardianInvite(): Promise<GuardianInvite> {
  const { data, error } = await supabase.rpc('create_guardian_invite');
  if (error) {
    const pg = error as PgError;
    const known = GUARDIAN_REFUSALS.find((r) => r.code === pg.code && r.message === pg.message);
    if (known) throw new GuardianInviteError(known.reason);
    throw error;
  }
  const reply = (data ?? {}) as { code?: unknown; expires_at?: unknown };
  if (typeof reply.code !== 'string' || !INVITE_CODE.test(reply.code) || typeof reply.expires_at !== 'string') {
    throw new Error('create_guardian_invite returned no usable code');
  }
  return { code: reply.code, expiresAt: reply.expires_at };
}

/**
 * Whether a failed call never reached the server (T13 review m4). PostgREST answers every refusal
 * with a SQLSTATE or a PGRST code; supabase-js reports a fetch that failed (offline, DNS, a
 * timeout) as an error with an empty `code`. A thrown `TypeError` from `fetch` counts too.
 */
export function isNetworkFailure(error: unknown): boolean {
  if (error instanceof GuardianInviteError) return false;
  if (error instanceof TypeError) return true;
  if (typeof error !== 'object' || error === null) return false;
  const { code, message } = error as PgError;
  if (code === '') return true;
  return code === undefined && /fetch|network|abort|timed? ?out/i.test(message ?? '');
}

/** The caller's guardian link as the server sees it. Rejects on an error or a status it doesn't know. */
export async function readGuardianLink(): Promise<GuardianLink> {
  const { data, error } = await supabase.rpc('guardian_link_state');
  if (error) throw error;
  const reply = (data ?? {}) as { status?: unknown; expires_at?: unknown };
  const status = LINK_STATUSES.find((s) => s === reply.status);
  if (!status) throw new Error('guardian_link_state returned an unknown status');
  return { status, expiresAt: typeof reply.expires_at === 'string' ? reply.expires_at : null };
}

// ---------------------------------------------------------------------------------------------
// Under 13: the account's storage objects (rev1: I5).
// ---------------------------------------------------------------------------------------------

/**
 * Every bucket M4 knows a driver's objects can be in. V2 has no avatar bucket; `traces` holds the
 * raw drive traces under `<uid>/`. Postgres cannot delete the bytes, so the block screen removes
 * them through the Storage API (and `underage_object_keys()` lists any left for M8's job).
 */
export const PURGE_BUCKETS: readonly string[] = [TRACES_BUCKET];

/** Objects listed (and removed) per round. */
export const PURGE_PAGE = 100;
/** A bound on the rounds per bucket, so a remove that keeps "succeeding" cannot loop forever. */
export const PURGE_MAX_ROUNDS = 50;

interface ListedObject {
  name: string;
  /** Null for a folder (a prefix with objects under it). */
  id: string | null;
}

/**
 * Remove every object under the caller's own prefix in every bucket in `PURGE_BUCKETS`, through
 * the Storage API as the caller (the `*_delete_own` policies; the under-13 policy refuses inserts
 * only). `'done'` only when a final listing of every bucket is empty — the block screen says
 * "We've kept only what we need" on that and nothing less. A failed list or remove, a remove that
 * removed nothing, a nested folder this does not walk, or running out of rounds is `'partial'`.
 */
export async function purgeOwnObjects(userId: string): Promise<'done' | 'partial'> {
  let complete = true;
  for (const bucket of PURGE_BUCKETS) {
    if ((await purgeBucket(bucket, userId)) === 'partial') complete = false;
  }
  return complete ? 'done' : 'partial';
}

async function purgeBucket(bucket: string, userId: string): Promise<'done' | 'partial'> {
  const store = supabase.storage.from(bucket);
  for (let round = 0; round < PURGE_MAX_ROUNDS; round += 1) {
    let listed: ListedObject[];
    try {
      const { data, error } = await store.list(userId, { limit: PURGE_PAGE, offset: 0 });
      if (error) return 'partial';
      listed = (data ?? []) as ListedObject[];
    } catch {
      return 'partial';
    }
    const files = listed.filter((entry) => entry.id !== null);
    // Traces are flat (`<uid>/<clientTripId>.bin.gz`). A folder would hold objects this does not
    // reach, and saying "done" over them would be untrue.
    if (files.length < listed.length) return 'partial';
    if (files.length === 0) return 'done';
    try {
      const { data, error } = await store.remove(files.map((f) => `${userId}/${f.name}`));
      if (error) return 'partial';
      // A policy that refuses a delete answers with nothing removed rather than an error.
      if (!data || data.length === 0) return 'partial';
    } catch {
      return 'partial';
    }
  }
  return 'partial';
}

// ---------------------------------------------------------------------------------------------
// Under 13: the child's drives on this phone (T1 security re-audit; T1 r2 review n1).
// ---------------------------------------------------------------------------------------------

/**
 * Every table that holds a driver's drives, or work owed to the server about them, children
 * before parents: the handover wipe's list (`src/boot/device.ts` `DEVICE_TABLES`) without
 * `settings`, which `KEPT_SETTINGS` handles key by key. The queue goes with everything in it —
 * `age_pending`-deferred uploads included — so nothing sits there to fail later as a 403.
 */
export const CHILD_DRIVE_TABLES: readonly string[] = [
  'trip_events',
  'samples',
  'sync_queue',
  'score_daily_cache',
  'inbox_cache',
  'speed_limit_tiles',
  'trips',
];

/** Settings key: `{ userId, at }`, written once this account's removal has fully succeeded. */
export const BLOCK_PURGED_KEY = 'onboarding.blockPurgedAt';

/**
 * The ONLY settings a blocked account keeps (Ruling T12 security I-1, client part; supersedes a
 * prefix list). Everything else in `settings` is deleted with the drive tables, in the same
 * transaction — so a key a later task adds is removed by default, drive-derived or not (the
 * role-route cells, `role.answer.*`, `engine.arbiter.*`, opened trip ids, the insights baseline,
 * the hydrate cursors, tombstones, the consents and profile caches, a pending disclosure consent,
 * a held deep link to a trip…). The auto-record choice (`drive.autoDetect`) and its intent
 * (`permissions.autoRecordIntent`) go too: the minimisation deleted the background-location
 * consent, so a child released at 13 opts in again and sees the disclosure first. What stays is what the signed-in app needs until sign-out:
 * whose phone this is (the owner fences), the public config, the disclaimer acknowledgement,
 * where onboarding is, this removal's own stamp, and `profile.cache` — rewritten, never kept as it was:
 * reduced to `{ id, age_band: 'u13' }` for the device owner, so a relaunch (offline included)
 * still knows the band and the host never arms auto-record for the child (H2 daff447), while no
 * name or other field survives. Add a key here only if the block screen cannot work without it,
 * and never one derived from a drive.
 */
export const KEPT_SETTINGS: readonly string[] = [
  LAST_USER_KEY,
  PENDING_OWNER_KEY,
  SESSION_UID_KEY,
  APP_CONFIG_KEY,
  DISCLAIMER_ACK_KEY,
  PROFILE_CACHE_KEY,
  ONBOARDING_STEP_KEY,
  ONBOARDING_PLAN_KEY,
  BLOCK_PURGED_KEY,
];

export interface LocalPurgeDeps {
  /** The drive traces on disk. Default: the app's traces directory, every file in it. */
  traces?: { clear(): Promise<void> };
  /** Cancel drive summaries still scheduled. Default: M3's `cancelDriveSummaries`. */
  cancelSummaries?: () => Promise<void>;
}

async function clearTraceFiles(): Promise<void> {
  const fs = await createExpoTraceFs();
  // The Expo adapter always lists; one that could not would leave files this cannot vouch for.
  if (!fs.list) throw new Error('the traces directory cannot be listed');
  for (const name of await fs.list()) await fs.remove(name);
}

async function cancelSummaries(): Promise<void> {
  // Loaded here, as the handover wipe loads it: a test that never purges must not pull in the
  // notifications native module.
  // eslint-disable-next-line @typescript-eslint/no-require-imports -- deferred native module
  const { cancelDriveSummaries } = require('@/features/drive/summaryNotifier') as typeof import('@/features/drive/summaryNotifier');
  await cancelDriveSummaries();
}

/**
 * Remove the child's drives from this phone: the rows in `CHILD_DRIVE_TABLES` and every setting
 * outside `KEPT_SETTINGS` in one transaction, then the trace files, and any drive summary still scheduled. Rows first, files
 * second, as the handover wipe does: a crash between leaves unreferenced bytes, never rows
 * pointing at traces that are gone. A failure anywhere rejects, so the caller never reports a
 * clean phone it has not got. The caller waits for an open drive to close before calling this.
 */
export async function purgeLocalDriveData(db: Db, deps: LocalPurgeDeps = {}): Promise<void> {
  await (deps.cancelSummaries ?? cancelSummaries)().catch(() => {
    // A summary for a drive whose rows are about to go names nothing once they have; not fatal.
  });
  await db.transaction(async (tx) => {
    for (const table of CHILD_DRIVE_TABLES) await tx.execute(`DELETE FROM ${table}`);
    await tx.execute(
      `DELETE FROM settings WHERE key NOT IN (${KEPT_SETTINGS.map(() => '?').join(', ')})`,
      [...KEPT_SETTINGS]
    );
    // The profile cache keeps the band and nothing else, in the shape `readProfileCache` reads.
    const settings = createSettingsRepo(tx);
    const owner = await settings.get<unknown>(LAST_USER_KEY);
    if (typeof owner === 'string' && owner !== '') {
      await settings.set(PROFILE_CACHE_KEY, { userId: owner, profile: { id: owner, age_band: 'u13' } });
    } else {
      await settings.remove(PROFILE_CACHE_KEY);
    }
  });
  await (deps.traces ? deps.traces.clear() : clearTraceFiles());
  // Screens reading trips re-read (the same invalidation a restore triggers).
  emitDataChanged({ source: 'hydrate' });
}

/** Whether this account's removal already finished on this phone (the block screen skips it). */
export async function readBlockPurged(db: Db, userId: string): Promise<boolean> {
  try {
    const stamp = await createSettingsRepo(db).get<{ userId?: unknown }>(BLOCK_PURGED_KEY);
    return stamp?.userId === userId;
  } catch {
    return false;
  }
}

/** Stamp a removal that succeeded in full: the local purge and a `done` from Storage. */
export async function markBlockPurged(db: Db, userId: string, now: () => number = Date.now): Promise<void> {
  await createSettingsRepo(db).set(BLOCK_PURGED_KEY, { userId, at: now() });
}

/**
 * Forget the stamp: the account has been seen with a band other than u13 (released at 13, or a
 * support correction). If it is ever blocked again, the block screen runs the whole removal again
 * rather than trusting a stamp from the earlier block (T12 r1 review n1). Never rejects.
 */
export async function clearBlockPurged(db: Db): Promise<void> {
  try {
    await createSettingsRepo(db).remove(BLOCK_PURGED_KEY);
  } catch {
    // The next sighting of the band tries again.
  }
}

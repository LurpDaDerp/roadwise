/**
 * The onboarding steps' server and device calls: the write-once birth date, the profile basics,
 * and the under-13 clean-up (Task 12).
 *
 * Every Supabase call goes through the app client and the M0 wrappers, so the column lists and the
 * RLS scoping are the ones the rest of the app already relies on. Nothing here decides a route;
 * the steps do that from what these return.
 */
import type { Db } from '@/data/db/driver';
import { emitDataChanged } from '@/data/events';
import { supabase } from '@/data/supabase/client';
import { recordConsent, updateOwnProfile, type Profile } from '@/data/supabase/profile';
import { TRACES_BUCKET } from '@/data/sync/runner';
import { createExpoTraceFs } from '@/data/sync/traceFs';
import type { LegalState } from '@/features/auth/legal';
import type { ConsentRow, TermsType } from '@/features/auth/pendingConsent';

import type { AgeBand, DrivingStage } from './flow';

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
 * before parents. It is the handover wipe's list (`src/boot/device.ts` `DEVICE_TABLES`) without
 * `settings`: the device owner, the config cache and the session's own keys stay, because the
 * account is still signed in on this phone and the app must keep working until it signs out.
 * The queue goes with everything in it — `age_pending`-deferred uploads included — so nothing
 * sits there to fail later as a 403.
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
 * Remove the child's drives from this phone: the rows in `CHILD_DRIVE_TABLES` in one
 * transaction, then the trace files, and any drive summary still scheduled. Rows first, files
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
  });
  await (deps.traces ? deps.traces.clear() : clearTraceFiles());
  // Screens reading trips re-read (the same invalidation a restore triggers).
  emitDataChanged({ source: 'hydrate' });
}

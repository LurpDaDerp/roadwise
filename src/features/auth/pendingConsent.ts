/**
 * The sign-in attestation: "I'm 13 or older and agree to the Terms and Privacy Policy".
 *
 * The box is ticked before the account exists, so the tick waits in device settings and is sent
 * after sign-in with `accept_terms(p_version)`. The rules:
 *   - every visit to the sign-in screen starts unticked and drops any tick left unbound
 *     (`startSignInVisit`), so a tick is only ever the person signing in now;
 *   - a tick lives at most `PENDING_TERMS_TTL_MS`, and an untick or a sign-out clears it;
 *   - the sign-in binds it to the account it brings (`bindPendingTerms`); from then on it is sent
 *     for that account only, and one bound to another account is dropped;
 *   - a send that fails keeps the tick, and the next signed-in launch tries again. Once the server
 *     has it, the tick is marked sent and nothing more is sent for it.
 * No age or birth date is stored anywhere: the tick is the attestation.
 */
import type { SettingsRepo } from '@/data/db/settings';
import { supabase } from '@/data/supabase/client';

import { TERMS_VERSION } from './legal';
import { PENDING_TERMS_KEY } from './pendingTermsKey';

/** Settings key: `{ version, at, uid?, sent? }`, the attestation made on this phone. */
export { PENDING_TERMS_KEY };
/** How long a tick stays good for: one sign-in, a slow one included. */
export const PENDING_TERMS_TTL_MS = 24 * 60 * 60 * 1000;

export interface PendingTerms {
  version: string;
  at: number;
  /** The account the sign-in brought; absent while the tick waits for its sign-in. */
  uid?: string;
  /** The server has recorded it. */
  sent?: boolean;
}

/** `accept_terms(p_version)`. Injectable so the rules are tested without a network. */
export type AcceptTerms = (version: string) => Promise<void>;

/**
 * The backend's `accept_terms`. Typed loosely on purpose: the database (and its generated types) is
 * being rebuilt, so the call goes through an untyped `rpc`.
 */
export const acceptTermsRpc: AcceptTerms = async (version) => {
  const rpc = supabase.rpc as unknown as (
    fn: string,
    args: Record<string, unknown>
  ) => PromiseLike<{ error: unknown }>;
  const { error } = await rpc.call(supabase, 'accept_terms', { p_version: version });
  if (error) throw error instanceof Error ? error : new Error('accept_terms failed');
};

const isPendingTerms = (v: unknown): v is PendingTerms => {
  if (typeof v !== 'object' || v === null) return false;
  const r = v as Record<string, unknown>;
  return (
    typeof r.version === 'string' &&
    typeof r.at === 'number' &&
    (r.uid === undefined || typeof r.uid === 'string') &&
    (r.sent === undefined || typeof r.sent === 'boolean')
  );
};

async function readPending(settings: SettingsRepo): Promise<PendingTerms | null> {
  const raw = await settings.get<unknown>(PENDING_TERMS_KEY);
  if (raw === null) return null;
  if (isPendingTerms(raw)) return raw;
  await settings.remove(PENDING_TERMS_KEY);
  return null;
}

/**
 * The sign-in screen mounted: a tick still waiting for a sign-in is from an earlier visit (maybe
 * someone else's) and is dropped. A tick already bound to an account is that account's and stays
 * until it is sent. Never rejects.
 */
export async function startSignInVisit(settings: SettingsRepo): Promise<void> {
  try {
    const pending = await readPending(settings);
    if (pending !== null && pending.uid === undefined) await settings.remove(PENDING_TERMS_KEY);
  } catch {
    // Unreadable: the send's own checks still hold.
  }
}

/** The box was ticked. */
export async function markTermsAccepted(
  settings: SettingsRepo,
  now: () => number = Date.now
): Promise<void> {
  await settings.set(PENDING_TERMS_KEY, { version: TERMS_VERSION, at: now() } satisfies PendingTerms);
}

/** The box was unticked, or the driver signed out: forget the tick. */
export async function clearTermsAccepted(settings: SettingsRepo): Promise<void> {
  await settings.remove(PENDING_TERMS_KEY);
}

/**
 * A driver signed in: a tick still waiting for its sign-in becomes this account's. A tick bound to
 * a different account is someone else's and is dropped. Never rejects.
 */
export async function bindPendingTerms(settings: SettingsRepo, uid: string): Promise<void> {
  try {
    const pending = await readPending(settings);
    if (pending === null || pending.uid === uid) return;
    if (pending.uid === undefined) await settings.set(PENDING_TERMS_KEY, { ...pending, uid });
    else await settings.remove(PENDING_TERMS_KEY);
  } catch {
    // Unreadable: the send's own checks still hold.
  }
}

/**
 * Sends this account's tick with `accept_terms`, once. Nothing stored, already sent, another
 * account's, or stale (older than the TTL, or stamped in the future, before it was sent): nothing
 * is sent. Rejects when the call fails, keeping the tick for the next launch.
 */
export async function flushTermsAcceptance(
  settings: SettingsRepo,
  uid: string,
  accept: AcceptTerms = acceptTermsRpc,
  now: () => number = Date.now
): Promise<{ sent: boolean }> {
  const pending = await readPending(settings);
  if (pending === null || pending.sent === true) return { sent: false };
  if (pending.uid !== undefined && pending.uid !== uid) {
    await settings.remove(PENDING_TERMS_KEY);
    return { sent: false };
  }
  const age = now() - pending.at;
  if (pending.uid === undefined && (age < 0 || age > PENDING_TERMS_TTL_MS)) {
    await settings.remove(PENDING_TERMS_KEY);
    return { sent: false };
  }
  await accept(pending.version);
  await settings.set(PENDING_TERMS_KEY, { ...pending, uid, sent: true } satisfies PendingTerms);
  return { sent: true };
}

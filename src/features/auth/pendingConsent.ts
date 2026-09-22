/**
 * Consent given before there is an account to record it on.
 *
 * The sign-in screen (A3) asks for the disclaimer — and, once they are published, the Terms and
 * Privacy Policy — before the account exists, so the acceptance waits in device settings and is
 * written to `consents` after sign-in. The rules (ruling I7):
 *   - nothing about the Terms or Privacy Policy is stored or recorded while either is unpublished;
 *   - a stored acceptance is recorded only for the exact versions published now, and only for a
 *     type the account does not already hold at that version, so flushing twice records nothing new;
 *   - the disclaimer is not a `consents` type in 0001. Its acknowledgement is a preference, kept
 *     here and, by the Terms step, in `profiles.flags.disclaimerAcknowledged`.
 */
import type { Db } from '@/data/db/driver';
import { createSettingsRepo, type SettingsRepo } from '@/data/db/settings';
import { supabase } from '@/data/supabase/client';
import { recordConsent } from '@/data/supabase/profile';

import { DISCLAIMER_VERSION, type LegalState } from './legal';

/** Settings key: `{ tos, privacy }`, the versions accepted on this phone and not yet recorded. */
export const PENDING_TERMS_KEY = 'auth.pendingTerms';
/** Settings key: the `DISCLAIMER_VERSION` last acknowledged on this phone. */
export const DISCLAIMER_ACK_KEY = 'auth.disclaimerAcknowledged';

export type TermsType = 'tos' | 'privacy';
const TERMS_TYPES: readonly TermsType[] = ['tos', 'privacy'];

export interface TermsConsent {
  type: TermsType;
  version: string;
}

/** The columns of a `consents` row this reads. */
export interface ConsentRow {
  type: string;
  version: string;
  revoked_at?: string | null;
}

/** The server calls a flush makes; injectable so the rules are tested without a network. */
export interface ConsentApi {
  fetchConsents(userId: string): Promise<ConsentRow[]>;
  recordConsent(userId: string, consent: TermsConsent): Promise<unknown>;
}

type PendingTerms = Record<TermsType, string>;

const defaultApi: ConsentApi = {
  async fetchConsents(userId) {
    const { data, error } = await supabase
      .from('consents')
      .select('type,version,revoked_at')
      .eq('user_id', userId)
      .in('type', [...TERMS_TYPES]);
    if (error) throw error;
    return data ?? [];
  },
  recordConsent: (userId, consent) => recordConsent(userId, consent),
};

const isPendingTerms = (v: unknown): v is PendingTerms =>
  typeof v === 'object' &&
  v !== null &&
  typeof (v as Record<string, unknown>).tos === 'string' &&
  typeof (v as Record<string, unknown>).privacy === 'string';

/** A live consent of `type` at exactly `version`. */
const holds = (consents: readonly ConsentRow[], type: TermsType, version: string): boolean =>
  consents.some((c) => c.type === type && c.version === version && !c.revoked_at);

/**
 * The driver ticked the box on the sign-in screen. Published: remember the Terms and Privacy
 * versions they saw, and the disclaimer. Unpublished: the disclaimer only — and any acceptance
 * left from an earlier showing is dropped, because this showing did not ask for it.
 */
export async function markTermsAccepted(settings: SettingsRepo, legal: LegalState): Promise<void> {
  if (legal.published && legal.tos && legal.privacy) {
    const pending: PendingTerms = { tos: legal.tos.version, privacy: legal.privacy.version };
    await settings.set(PENDING_TERMS_KEY, pending);
  } else {
    await settings.remove(PENDING_TERMS_KEY);
  }
  await settings.set(DISCLAIMER_ACK_KEY, DISCLAIMER_VERSION);
}

/**
 * Record the stored acceptance on the signed-in account. Unpublished, or nothing stored: no network
 * call and nothing recorded. The acceptance is cleared once every type is on the account, or when
 * it names versions other than the ones published now (it is not consent to those). A failed read
 * or write rejects and keeps it, and the next flush skips whatever already landed.
 */
export async function flushPendingConsents(
  db: Db,
  userId: string,
  legal: LegalState,
  api: ConsentApi = defaultApi
): Promise<{ recorded: TermsType[] }> {
  if (!legal.published || !legal.tos || !legal.privacy) return { recorded: [] };

  const settings = createSettingsRepo(db);
  const pending = await settings.get<unknown>(PENDING_TERMS_KEY);
  if (pending === null) return { recorded: [] };

  const current: PendingTerms = { tos: legal.tos.version, privacy: legal.privacy.version };
  if (!isPendingTerms(pending) || TERMS_TYPES.some((type) => pending[type] !== current[type])) {
    await settings.remove(PENDING_TERMS_KEY);
    return { recorded: [] };
  }

  const existing = await api.fetchConsents(userId);
  const recorded: TermsType[] = [];
  for (const type of TERMS_TYPES) {
    if (holds(existing, type, current[type])) continue;
    await api.recordConsent(userId, { type, version: current[type] });
    recorded.push(type);
  }
  await settings.remove(PENDING_TERMS_KEY);
  return { recorded };
}

/**
 * Whether the account has agreed to what there is to agree to now. The disclaimer is tracked at its
 * own version and is always required: the current `DISCLAIMER_VERSION` acknowledged in `flags`, so
 * a new disclaimer asks again even when the Terms have not changed (ruling T15). Published, the
 * account also needs live `tos` and `privacy` consents at the current versions; the disclaimer
 * alone is never acceptance of the Terms.
 */
export function hasCurrentTerms(
  consents: readonly ConsentRow[],
  flags: { disclaimerAcknowledged?: unknown } | null | undefined,
  legal: LegalState
): boolean {
  if (flags?.disclaimerAcknowledged !== DISCLAIMER_VERSION) return false;
  if (legal.published && legal.tos && legal.privacy) {
    return holds(consents, 'tos', legal.tos.version) && holds(consents, 'privacy', legal.privacy.version);
  }
  return true;
}

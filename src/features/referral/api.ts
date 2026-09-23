/**
 * The referral calls (migration 0011): `get_my_referral_code`, `redeem_referral_code` and
 * `my_referrals`. All three are definer RPCs behind `feature_flags.referral` (off by default, R-F);
 * the client never touches a referral table.
 *
 * - **Counts and the caller's own status only.** `my_referrals` answers exactly seven keys
 *   (`MY_REFERRALS_KEYS`), validated `.strict()`: an answer carrying anything more — a name, an id,
 *   a date — is refused whole (`unknown`), never shown.
 * - **The pattern is checked before sending.** `redeemReferralCode` normalises what was typed
 *   (`normaliseReferralCode`) and refuses anything that cannot match `REFERRAL_CODE_PATTERN` as
 *   `invalid` without a request, so a typo never spends one of the day's attempts.
 * - **Refusals.** 0011 raises some refusals and, after the attempt budget is taken, returns the
 *   same PostgREST error body with status 400/403 (so the take commits). supabase-js reports both
 *   as an error with the fixed message; `REDEEM_ERROR_MESSAGES` maps each message to a code. A lock
 *   timeout (`55P03`) is `busy`; a request that never reached the server is `offline`.
 */
import { normaliseReferralCode, REFERRAL_CODE_PATTERN } from '@scoring';
import { z } from 'zod';

import type { supabase as AppClient } from '@/data/supabase/client';

// ---------------------------------------------------------------------------------------------
// Schemas
// ---------------------------------------------------------------------------------------------

const count = z.number().int().min(0);
const code = z.string().regex(REFERRAL_CODE_PATTERN);

/** The invitee's own status: whether the code they used counted. */
export const MY_CODE_VALUES = ['none', 'pending', 'counted', 'not_counted'] as const;
export type MyCodeStatus = (typeof MY_CODE_VALUES)[number];

/** `my_referrals()`: exactly 0011's keys. */
export const MyReferralsSchema = z
  .object({
    /** The caller's own code; null until `get_my_referral_code` has created it. */
    code: code.nullable(),
    /** Friends who used the caller's code. */
    joined: count,
    /** Of those, how many counted (qualified). */
    qualified: count,
    /** Referrals that earned the caller points in the last 365 days. */
    rewardedThisYear: count,
    /** How many a year can earn points (`REWARDS.REFERRAL.YEARLY_CAP`). */
    cap: count,
    /** Whether the caller can still use a friend's code (new account, none used). Never null. */
    canRedeem: z.boolean(),
    myCode: z.enum(MY_CODE_VALUES),
  })
  .strict();
export type MyReferrals = z.infer<typeof MyReferralsSchema>;

export const MY_REFERRALS_KEYS = [
  'code',
  'joined',
  'qualified',
  'rewardedThisYear',
  'cap',
  'canRedeem',
  'myCode',
] as const;

const CodeAnswerSchema = z.object({ code }).strict();
const RedeemAnswerSchema = z.object({ status: z.literal('pending') }).strict();
export type RedeemAnswer = z.infer<typeof RedeemAnswerSchema>;

// ---------------------------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------------------------

export const REFERRAL_ERROR_CODES = [
  'offline',
  'busy',
  'invalid',
  'window_closed',
  'already_used',
  'own_code',
  'too_many',
  'not_available',
  'unknown',
] as const;
export type ReferralErrorCode = (typeof REFERRAL_ERROR_CODES)[number];

/** A referral call that did not succeed, as a code the screens word (never the server's text). */
export class ReferralError extends Error {
  override readonly name = 'ReferralError';
  constructor(readonly code: ReferralErrorCode, readonly cause?: unknown) {
    super(`referral: ${code}`);
  }
}

/** Every fixed message 0011's three RPCs raise or return, each to its code. */
export const REDEEM_ERROR_MESSAGES: Readonly<Record<string, ReferralErrorCode>> = {
  'invalid code': 'invalid',
  'code window closed': 'window_closed',
  'already used a code': 'already_used',
  'this is your own code': 'own_code',
  'too many attempts': 'too_many',
  'referrals are not available yet': 'not_available',
  'account not eligible': 'not_available',
  // A signed-out call, which no screen makes.
  'get_my_referral_code requires an authenticated user': 'unknown',
  'redeem_referral_code requires an authenticated user': 'unknown',
  'my_referrals requires an authenticated user': 'unknown',
};

const LOCK_TIMEOUT_SQLSTATE = '55P03';

export function referralErrorCode(error: unknown, status: number): ReferralErrorCode {
  if (status === 0) return 'offline';
  if (typeof error !== 'object' || error === null) return 'unknown';
  const { code: sqlstate, message } = error as { code?: unknown; message?: unknown };
  if (sqlstate === LOCK_TIMEOUT_SQLSTATE) return 'busy';
  if (typeof message === 'string') return REDEEM_ERROR_MESSAGES[message] ?? 'unknown';
  return 'unknown';
}

// ---------------------------------------------------------------------------------------------
// Calls
// ---------------------------------------------------------------------------------------------

/** The slice of the Supabase client these calls use; a test passes a fake. */
export type ReferralClient = Pick<typeof AppClient, 'rpc'>;

/** The app client, loaded on first call rather than at import (a screen test never needs its env). */
function appClient(): ReferralClient {
  // eslint-disable-next-line @typescript-eslint/no-require-imports -- the app client, only when used
  return (require('@/data/supabase/client') as typeof import('@/data/supabase/client')).supabase;
}

interface Reply {
  data: unknown;
  error: unknown;
  status: number;
}

async function callRpc<T>(reply: PromiseLike<Reply>, schema: z.ZodType<T>): Promise<T> {
  let answer: Reply;
  try {
    answer = await reply;
  } catch (error) {
    // supabase-js answers a failed fetch as `status: 0`; a throw is the same thing.
    throw new ReferralError('offline', error);
  }
  if (answer.error) throw new ReferralError(referralErrorCode(answer.error, answer.status), answer.error);
  const parsed = schema.safeParse(answer.data);
  if (!parsed.success) throw new ReferralError('unknown', parsed.error.issues);
  return parsed.data;
}

/** The caller's permanent code, created on the first call. */
export async function getMyReferralCode(client: ReferralClient = appClient()): Promise<string> {
  return (await callRpc(client.rpc('get_my_referral_code'), CodeAnswerSchema)).code;
}

/** Counts, the cap, and the caller's own status. */
export function fetchMyReferrals(client: ReferralClient = appClient()): Promise<MyReferrals> {
  return callRpc(client.rpc('my_referrals'), MyReferralsSchema);
}

/**
 * Use a friend's code. What was typed is normalised first; anything that cannot match the pattern
 * is refused here as `invalid`, with no request.
 */
export function redeemReferralCode(input: string, client: ReferralClient = appClient()): Promise<RedeemAnswer> {
  const normalised = normaliseReferralCode(input);
  if (!REFERRAL_CODE_PATTERN.test(normalised)) return Promise.reject(new ReferralError('invalid'));
  return callRpc(client.rpc('redeem_referral_code', { p_code: normalised }), RedeemAnswerSchema);
}

/** The calls the hooks make, as one injectable object. */
export interface ReferralApi {
  getMyReferralCode(): Promise<string>;
  fetchMyReferrals(): Promise<MyReferrals>;
  redeemReferralCode(input: string): Promise<RedeemAnswer>;
}

export const defaultReferralApi: ReferralApi = {
  getMyReferralCode: () => getMyReferralCode(),
  fetchMyReferrals: () => fetchMyReferrals(),
  redeemReferralCode: (input) => redeemReferralCode(input),
};

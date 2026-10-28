// The App Attest check on an upload (iPhone only).
//
// A build that attests sends one of: `x-app-attest-key` + `x-app-attest-assertion` (its key's
// assertion over the exact request body), `x-app-attest: unsupported` (App Attest is not available
// on the phone: a simulator), or `x-app-attest: unattested` (it could not attest a key yet). An
// Android build, and an iPhone build from before App Attest, send none of them.
//
// `checkUpload` decides a verdict inside the upload's transaction: the named key is read (locked) and
// the assertion verified against the exact body bytes; on success the key's counter moves up in the
// same transaction. With enforcement on, the handler lets `verified` and `android` uploads through,
// stores `unsupported` unscored, and answers the rest `attest_required` (the phone attests and sends
// again). With enforcement off, nothing is refused and the verdict only goes to the log.
import { fromHex, KEY_ID_PATTERN, MAX_ASSERTION_BYTES, verifyAssertion, type AssertionFailure, type AttestSettings } from '../_shared/appattest.ts';
import type { EngineTx } from '../_shared/engine.ts';

export const ATTEST_HEADER = 'x-app-attest';
export const ATTEST_KEY_HEADER = 'x-app-attest-key';
export const ATTEST_ASSERTION_HEADER = 'x-app-attest-assertion';

const ASSERTION_PATTERN = new RegExp(`^[A-Za-z0-9+/=]{4,${Math.ceil(MAX_ASSERTION_BYTES / 3) * 4}}$`);

/** What an upload's headers carry. */
export type UploadProof =
  | { kind: 'assertion'; keyId: string; assertion: string }
  /** The phone says App Attest is not available on it. */
  | { kind: 'unsupported' }
  /** An attesting iPhone build without an attested key yet, or with headers that do not parse. */
  | { kind: 'unattested' }
  /** No App Attest header at all: an Android build, or an iPhone build from before App Attest. */
  | { kind: 'none' };

export function readProof(headers: Headers): UploadProof {
  const keyId = headers.get(ATTEST_KEY_HEADER);
  const assertion = headers.get(ATTEST_ASSERTION_HEADER);
  if (keyId !== null || assertion !== null) {
    return keyId !== null && assertion !== null && KEY_ID_PATTERN.test(keyId) && ASSERTION_PATTERN.test(assertion)
      ? { kind: 'assertion', keyId, assertion }
      : { kind: 'unattested' };
  }
  const marker = headers.get(ATTEST_HEADER);
  if (marker === 'unsupported') return { kind: 'unsupported' };
  if (marker !== null) return { kind: 'unattested' };
  return { kind: 'none' };
}

/**
 * - `verified`: a valid assertion from the user's own key; its counter is stored.
 * - `android`: no App Attest header, from a user with an Android device registered (looked up only
 *   under enforcement).
 * - `none`: no App Attest header, not looked up (enforcement off).
 * - `unsupported`: the phone says App Attest is not available on it.
 * - `missing`: an iPhone upload with no assertion.
 * - `unknown_key`: the named key is not one of the user's.
 * - `invalid`: the assertion failed (`reason`), or its key is from Apple's sandbox, which is no
 *   longer allowed.
 * - `unchecked`: an assertion came but App Attest is not configured (no team id).
 */
export type AttestVerdict = 'verified' | 'android' | 'none' | 'unsupported' | 'missing' | 'unknown_key' | 'invalid' | 'unchecked';

export interface AttestCheck {
  verdict: AttestVerdict;
  reason?: AssertionFailure | 'environment';
}

/** The verdicts enforcement answers with `attest_required`: the phone can fix each by attesting. */
export const NEEDS_ATTESTATION: ReadonlySet<AttestVerdict> = new Set(['missing', 'unknown_key', 'invalid']);

export async function checkUpload(
  tx: Pick<EngineTx, 'attestContext' | 'advanceAttestCounter'>,
  userId: string,
  proof: UploadProof,
  body: Uint8Array,
  settings: AttestSettings | null,
  enforce: boolean
): Promise<AttestCheck> {
  switch (proof.kind) {
    case 'unsupported':
      return { verdict: 'unsupported' };
    case 'unattested':
      return { verdict: 'missing' };
    case 'none':
      if (!enforce) return { verdict: 'none' };
      return { verdict: (await tx.attestContext(userId, null)).android ? 'android' : 'missing' };
    case 'assertion': {
      if (!settings) return { verdict: 'unchecked' };
      const { key } = await tx.attestContext(userId, proof.keyId);
      if (!key) return { verdict: 'unknown_key' };
      if (key.environment === 'development' && !settings.allowDevelopment) return { verdict: 'invalid', reason: 'environment' };
      const publicKey = fromHex(key.publicKey);
      if (!publicKey) return { verdict: 'invalid', reason: 'malformed' };
      const result = await verifyAssertion({ assertion: proof.assertion, clientData: body, publicKey, counter: key.counter }, settings);
      if (!result.ok) return { verdict: 'invalid', reason: result.reason };
      // strictly above the stored counter, in this transaction: a replayed assertion never passes
      if (!(await tx.advanceAttestCounter(userId, proof.keyId, result.counter))) return { verdict: 'invalid', reason: 'counter' };
      return { verdict: 'verified' };
    }
  }
}

// app-attest: an iPhone's App Attest key, attested once per install and account.
//
// The phone asks for a challenge, has Apple attest a fresh key against SHA256(challenge), and sends
// the attestation here. Order of work, cheapest refusal first: method, JWT, size (32 KB), JSON, the
// contract (strict), App Attest configured at all (else 503 `unconfigured`), then:
//   * `{ action: 'challenge' }` → `{ challenge }`: 32 random bytes, base64url. Its SHA-256 is kept for
//     5 minutes and one use (`app_attest_issue_challenge`, 20 a user an hour, else 429
//     `too_many_challenges`).
//   * `{ action: 'attest', keyId, attestation, challenge }` → `{ status: 'attested' }`: the challenge
//     used up (`app_attest_take_challenge`, 10 attestations a user a day, else 429
//     `too_many_attestations`; one not this user's, used or expired is 400 `challenge_invalid`),
//     Apple's attestation verified against it (`verifyAttestation`, else 400
//     `attestation_invalid`), and the key stored for this user with counter 0
//     (`app_attest_save_key`; a key another account holds is 409 `key_taken`).
//
// finalize-trip then checks every iPhone upload's assertion against the stored key.
//
// A user id comes from the JWT and nowhere else. Logs carry the request id and reason codes only:
// never a key, an attestation or a challenge.
import { z } from 'zod';
import {
  KEY_ID_PATTERN,
  MAX_ATTESTATION_BYTES,
  sha256Text,
  verifyAttestation,
  type AttestSettings,
} from '../_shared/appattest.ts';
import type { AttestStore } from '../_shared/appattest_store.ts';
import { bearerToken, invalidPayload, json, pgFailure, readJsonBody, requestId, requirePost, withRequestId, type Logger } from '../_shared/http.ts';

/** An attestation is about 5 KB (7 KB in base64); nothing this function takes is larger than this. */
export const MAX_BODY_BYTES = 32_768;
/** How many random bytes a challenge holds. */
export const CHALLENGE_BYTES = 32;
/** A challenge as sent: 32 bytes in unpadded base64url. */
export const CHALLENGE_PATTERN = /^[A-Za-z0-9_-]{43}$/;

export const AppAttestRequestSchema = z.discriminatedUnion('action', [
  z.object({ action: z.literal('challenge') }).strict(),
  z
    .object({
      action: z.literal('attest'),
      keyId: z.string().regex(KEY_ID_PATTERN),
      attestation: z.string().min(1).max(Math.ceil(MAX_ATTESTATION_BYTES / 3) * 4),
      challenge: z.string().regex(CHALLENGE_PATTERN),
    })
    .strict(),
]);
export type AppAttestRequest = z.infer<typeof AppAttestRequestSchema>;

export interface AppAttestDeps {
  /** The user id the token proves, or null when it proves nothing; throws when Auth is unreachable. */
  verifyJwt(token: string): Promise<string | null>;
  store: AttestStore;
  /** Null when App Attest is not configured (no APP_ATTEST_TEAM_ID). */
  settings: AttestSettings | null;
  now?: () => number;
  /** Fills `bytes` with random bytes (WebCrypto by default). */
  random?: (bytes: Uint8Array) => void;
  log?: Logger;
}

const base64Url = (b: Uint8Array): string =>
  btoa(Array.from(b, (v) => String.fromCharCode(v)).join('')).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');

export async function handleAppAttest(req: Request, deps: AppAttestDeps): Promise<Response> {
  const log = deps.log ?? console;
  const id = requestId();
  const reply = (res: Response) => withRequestId(res, id);

  const wrongMethod = requirePost(req);
  if (wrongMethod) return reply(wrongMethod);

  const token = bearerToken(req);
  let userId: string | null = null;
  if (token) {
    try {
      userId = await deps.verifyJwt(token);
    } catch (err) {
      log.error('app-attest token check failed', { requestId: id, error: err instanceof Error ? err.message : String(err) });
      return reply(json(503, { code: 'retry' }, { 'retry-after': '2' }));
    }
  }
  if (!userId) return reply(json(401, { code: 'unauthorized' }));

  const body = await readJsonBody(req, MAX_BODY_BYTES);
  if (!body.ok) return reply(body.response);
  const parsed = AppAttestRequestSchema.safeParse(body.body);
  if (!parsed.success) return reply(invalidPayload(parsed.error));
  const request = parsed.data;

  const settings = deps.settings;
  if (!settings) return reply(json(503, { code: 'unconfigured' }));

  try {
    if (request.action === 'challenge') {
      const bytes = new Uint8Array(CHALLENGE_BYTES);
      (deps.random ?? ((b: Uint8Array) => crypto.getRandomValues(b)))(bytes);
      const challenge = base64Url(bytes);
      if (!(await deps.store.issueChallenge(userId, await sha256Text(challenge)))) {
        return reply(json(429, { code: 'too_many_challenges' }, { 'retry-after': '3600' }));
      }
      return reply(json(200, { challenge }));
    }

    // the phone's attestKeyAsync signs over SHA256 of the challenge's UTF-8, which is what is kept
    const clientDataHash = await sha256Text(request.challenge);
    const taken = await deps.store.takeChallenge(userId, clientDataHash);
    if (taken === 'limited') return reply(json(429, { code: 'too_many_attestations' }, { 'retry-after': '3600' }));
    if (taken === 'unknown') return reply(json(400, { code: 'challenge_invalid' }));

    const verified = await verifyAttestation(
      { keyId: request.keyId, attestation: request.attestation, clientDataHash },
      { ...settings, now: (deps.now ?? Date.now)() }
    );
    if (!verified.ok) {
      log.warn('app-attest attestation refused', { requestId: id, reason: verified.reason });
      return reply(json(400, { code: 'attestation_invalid' }));
    }
    const saved = await deps.store.saveKey(userId, request.keyId, verified.publicKey, verified.environment);
    if (saved === 'taken') {
      log.warn('app-attest key held by another account', { requestId: id });
      return reply(json(409, { code: 'key_taken' }));
    }
    return reply(json(200, { status: 'attested' }));
  } catch (err) {
    return reply(pgFailure(err, log, { requestId: id, action: request.action }, 'app-attest'));
  }
}

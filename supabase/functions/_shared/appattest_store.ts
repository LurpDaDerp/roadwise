// The app-attest function's database port: the `private.app_attest_*` functions of migration 0031
// over a DIRECT Postgres connection (the `private` schema is not exposed by the Data API). Each call
// is one statement in its own transaction; answers are checked against the SQL contract, and a
// writer's refusal is a `PgError` (`toPgError`) for `pgFailure` to map.
//
// finalize-trip reads and moves a key inside its own upload transaction instead (`EngineTx`).
import postgres from 'postgres';
import { z } from 'zod';
import { toHex, type AttestEnvironment } from './appattest.ts';
import { EngineContractError, toPgError } from './engine.ts';

export type TakeChallenge = 'taken' | 'unknown' | 'limited';
export type SaveKey = 'saved' | 'known' | 'taken';

export interface AttestStore {
  /** Keeps SHA256 of a fresh challenge for 5 minutes; false when the user has had 20 this hour. */
  issueChallenge(userId: string, hash: Uint8Array): Promise<boolean>;
  /** Uses up a challenge (10 attestations a user a day). */
  takeChallenge(userId: string, hash: Uint8Array): Promise<TakeChallenge>;
  /** Stores a verified key with counter 0. */
  saveKey(userId: string, keyId: string, publicKey: Uint8Array, environment: AttestEnvironment): Promise<SaveKey>;
}

const TakeChallengeSchema = z.enum(['taken', 'unknown', 'limited']);
const SaveKeySchema = z.enum(['saved', 'known', 'taken']);

/** One small pool per isolate, as the engine's (`prepare: false` for the transaction pooler). */
export function createAttestStore(dbUrl: string): AttestStore {
  const sql = postgres(dbUrl, {
    max: 2,
    prepare: false,
    idle_timeout: 30,
    connect_timeout: 10,
    connection: { lock_timeout: 5000, statement_timeout: 10000 },
  });
  const one = async <T>(fn: string, run: () => Promise<{ r: unknown }[]>, schema: z.ZodType<T>): Promise<T> => {
    let rows: { r: unknown }[];
    try {
      rows = await run();
    } catch (err) {
      throw toPgError(err);
    }
    const parsed = rows.length === 1 ? schema.safeParse(rows[0].r) : null;
    if (!parsed?.success) throw new EngineContractError(fn);
    return parsed.data;
  };
  return {
    issueChallenge: (userId, hash) =>
      one(
        'private.app_attest_issue_challenge',
        () => sql<{ r: unknown }[]>`select private.app_attest_issue_challenge(${userId}::uuid, decode(${toHex(hash)}, 'hex')) as r`,
        z.boolean()
      ),
    takeChallenge: (userId, hash) =>
      one(
        'private.app_attest_take_challenge',
        () => sql<{ r: unknown }[]>`select private.app_attest_take_challenge(${userId}::uuid, decode(${toHex(hash)}, 'hex')) as r`,
        TakeChallengeSchema
      ),
    saveKey: (userId, keyId, publicKey, environment) =>
      one(
        'private.app_attest_save_key',
        () =>
          sql<{ r: unknown }[]>`select private.app_attest_save_key(${userId}::uuid, ${keyId}::text, decode(${toHex(publicKey)}, 'hex'), ${environment}::text) as r`,
        SaveKeySchema
      ),
  };
}

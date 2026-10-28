// send-email's database port: migration 0033's `private.take_auth_mail` over a DIRECT Postgres
// connection (the `private` schema is not exposed by the Data API), one statement in its own
// transaction. Short timeouts: Auth gives the whole hook call 5 s.
import postgres from 'postgres';
import { z } from 'zod';
import { EngineContractError, toPgError } from '../_shared/engine.ts';

export interface MailCap {
  /** Takes one mail for the address with this SHA256: false (nothing taken) when it has had 5 this hour or 10 today. */
  take(addressHash: Uint8Array): Promise<boolean>;
}

const toHex = (bytes: Uint8Array): string => Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');

/** One small pool per isolate (`prepare: false` for the transaction pooler). */
export function createMailCap(dbUrl: string): MailCap {
  const sql = postgres(dbUrl, {
    max: 2,
    prepare: false,
    idle_timeout: 30,
    connect_timeout: 2,
    connection: { lock_timeout: 1000, statement_timeout: 1500 },
  });
  return {
    take: async (addressHash) => {
      let rows: { r: unknown }[];
      try {
        rows = await sql<{ r: unknown }[]>`select private.take_auth_mail(decode(${toHex(addressHash)}, 'hex')) as r`;
      } catch (err) {
        throw toPgError(err);
      }
      const parsed = rows.length === 1 ? z.boolean().safeParse(rows[0].r) : null;
      if (!parsed?.success) throw new EngineContractError('private.take_auth_mail');
      return parsed.data;
    },
  };
}

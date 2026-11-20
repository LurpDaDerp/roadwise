// send-email's database port: migration 0045's `private.take_auth_mail` over a DIRECT Postgres
// connection (the `private` schema is not exposed by the Data API), one statement in its own
// transaction. Short timeouts: Auth gives the whole hook call 5 s, and the send needs most of it.
import postgres from 'postgres';
import { z } from 'zod';
import { EngineContractError, toPgError } from '../_shared/engine.ts';
import type { CapAnswer } from './handler.ts';

export interface MailCap {
  /**
   * Takes one mail for the inbox and the IP (null: none reported) with these SHA-256s, both or
   * neither: 'ok', or which cap is full ('address': 5 this hour or 10 today; 'ip': 20 or 50).
   */
  take(addressHash: Uint8Array, ipHash: Uint8Array | null): Promise<CapAnswer>;
}

const toHex = (bytes: Uint8Array): string => Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');

const AnswerSchema = z.enum(['ok', 'address', 'ip']);

/** One small pool per isolate (`prepare: false` for the transaction pooler). */
export function createMailCap(dbUrl: string): MailCap {
  const sql = postgres(dbUrl, {
    max: 2,
    prepare: false,
    idle_timeout: 30,
    connect_timeout: 1,
    connection: { lock_timeout: 1000, statement_timeout: 1500 },
  });
  return {
    take: async (addressHash, ipHash) => {
      let rows: { r: unknown }[];
      try {
        rows = ipHash === null
          ? await sql<{ r: unknown }[]>`select private.take_auth_mail(decode(${toHex(addressHash)}, 'hex'), null) as r`
          : await sql<{ r: unknown }[]>`select private.take_auth_mail(decode(${toHex(addressHash)}, 'hex'), decode(${toHex(ipHash)}, 'hex')) as r`;
      } catch (err) {
        throw toPgError(err);
      }
      const parsed = rows.length === 1 ? AnswerSchema.safeParse(rows[0].r) : null;
      if (!parsed?.success) throw new EngineContractError('private.take_auth_mail');
      return parsed.data;
    },
  };
}

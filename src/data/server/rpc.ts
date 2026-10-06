/**
 * Calls a v3 server RPC (see `.agent/v3/backend-interface.md` for every name and shape).
 *
 * The generated `Database` types describe jsonb returns as `Json`, so each feature declares the
 * shape it reads and passes it as `T`. Errors surface as `RpcError` carrying Postgres's code
 * (`22023` bad input, `42501` not allowed, `P0001` rate limited, …) and its fixed message.
 */
import { supabase } from '@/data/supabase/client';

export class RpcError extends Error {
  constructor(
    message: string,
    readonly code: string | null
  ) {
    super(message);
    this.name = 'RpcError';
  }
}

type LooseRpc = (
  fn: string,
  args?: Record<string, unknown>
) => PromiseLike<{ data: unknown; error: { message: string; code?: string } | null }>;

export async function callRpc<T>(fn: string, args?: Record<string, unknown>): Promise<T> {
  const rpc = supabase.rpc.bind(supabase) as unknown as LooseRpc;
  const { data, error } = await rpc(fn, args ?? {});
  if (error) throw new RpcError(error.message, error.code ?? null);
  return data as T;
}

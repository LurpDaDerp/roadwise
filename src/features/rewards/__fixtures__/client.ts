/**
 * A PostgREST double for the rewards calls: `from(table)` builders that record their chain and
 * resolve through `reply(table, ops)`, and `rpc(fn, args)` through `rpc`. Cast to `RewardsClient`.
 */
import type { RewardsClient } from '../api';

export interface Reply {
  data: unknown;
  error: unknown;
  status: number;
}

export type Op = [string, ...unknown[]];

export const ok = (data: unknown): Reply => ({ data, error: null, status: 200 });
export const offline = (): Reply => ({ data: null, error: { message: 'TypeError: Network request failed', code: '' }, status: 0 });
export const refused = (code: string, message: string, status = 400): Reply => ({ data: null, error: { code, message }, status });

export function fakeRewardsClient(opts: {
  reply?: (table: string, ops: Op[]) => Reply;
  rpc?: (fn: string, args: unknown) => Reply | Promise<Reply>;
}) {
  const selects: { table: string; ops: Op[] }[] = [];
  const rpcs: { fn: string; args: unknown }[] = [];
  const client = {
    from(table: string) {
      const ops: Op[] = [];
      selects.push({ table, ops });
      const builder = {
        select: (cols: string) => (ops.push(['select', cols]), builder),
        order: (col: string, o: unknown) => (ops.push(['order', col, o]), builder),
        limit: (n: number) => (ops.push(['limit', n]), builder),
        eq: (col: string, v: unknown) => (ops.push(['eq', col, v]), builder),
        neq: (col: string, v: unknown) => (ops.push(['neq', col, v]), builder),
        then: <R>(resolve: (r: Reply) => R, reject?: (e: unknown) => R) =>
          Promise.resolve(opts.reply ? opts.reply(table, ops) : ok([])).then(resolve, reject),
      };
      return builder;
    },
    rpc(fn: string, args?: unknown) {
      rpcs.push({ fn, args });
      return Promise.resolve(opts.rpc ? opts.rpc(fn, args) : ok(null));
    },
  };
  return { client: client as unknown as RewardsClient, selects, rpcs };
}

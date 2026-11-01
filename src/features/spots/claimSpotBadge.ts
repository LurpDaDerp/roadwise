/**
 * Spot Cleared: the badge for clearing a spot to watch. Spots are computed only on this phone and
 * never uploaded, so the phone claims the badge through `claim_spot_cleared` (which sends nothing
 * about the spot or its place).
 *
 * After a spot recompute: once any spot has cleared, and neither the cached summary nor the local
 * flag says the badge is already held, the claim goes out once. On success the flag is set and the
 * summary refetches, so Profile shows the badge. A failure (offline, signed out) stays silent and
 * the next recompute tries again.
 */
import type { QueryClient } from '@tanstack/react-query';

import type { Db } from '@/data/db/driver';
import { createSettingsRepo } from '@/data/db/settings';
import { createSpotsRepo } from '@/data/db/spots';
import type { MySummary } from '@/data/server/summary';

/** Set (true) once the server holds Spot Cleared for this driver; cleared with the account. */
export const SPOT_CLAIMED_KEY = 'achievements.spotClaimed';
const BADGE = 'spot_cleared';

export interface ClaimSpotDeps {
  db: Db;
  queryClient: QueryClient;
  /** Calls the RPC; default the app's server client. */
  call?: (fn: 'claim_spot_cleared') => Promise<unknown>;
}

export type ClaimOutcome = 'claimed' | 'held' | 'none-cleared' | 'failed';

const isSummary = (q: { queryKey: readonly unknown[] }): boolean => q.queryKey[0] === 'server' && q.queryKey[2] === 'summary';

function defaultCall(fn: 'claim_spot_cleared'): Promise<unknown> {
  // eslint-disable-next-line @typescript-eslint/no-require-imports -- deferred: the server client loads only when a claim goes out
  const { callRpc } = require('@/data/server/rpc') as typeof import('@/data/server/rpc');
  return callRpc<unknown>(fn);
}

let inFlight: Promise<ClaimOutcome> | null = null;

async function claim(deps: ClaimSpotDeps): Promise<ClaimOutcome> {
  try {
    const settings = createSettingsRepo(deps.db);
    if ((await settings.get<boolean>(SPOT_CLAIMED_KEY)) === true) return 'held';
    const cached = deps.queryClient.getQueriesData<MySummary>({ predicate: isSummary });
    if (cached.some(([, s]) => s?.achievements.includes(BADGE))) {
      await settings.set(SPOT_CLAIMED_KEY, true);
      return 'held';
    }
    const spots = await createSpotsRepo(deps.db).list();
    if (!spots.some((s) => s.cleared_at !== null)) return 'none-cleared';
    await (deps.call ?? defaultCall)('claim_spot_cleared');
    await settings.set(SPOT_CLAIMED_KEY, true);
    await deps.queryClient.invalidateQueries({ predicate: isSummary }).catch(() => undefined);
    return 'claimed';
  } catch {
    return 'failed';
  }
}

/** Claim Spot Cleared if a spot has cleared and the badge isn't held yet. Never rejects; one claim at a time. */
export function claimSpotBadge(deps: ClaimSpotDeps): Promise<ClaimOutcome> {
  if (inFlight !== null) return inFlight;
  const p = claim(deps).finally(() => {
    inFlight = null;
  });
  inFlight = p;
  return p;
}

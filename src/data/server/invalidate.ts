/**
 * Narrow invalidation for server queries (`useServerQuery`, keys `['server', uid, root, …]`).
 *
 * Invalidating the whole `['server']` root refetched every mounted observer — the league, clan and
 * friends tabs stay mounted — after each drive and each social write. Instead a write names the
 * roots it moves: those refetch if on screen. A settled drive refetches only the summary and marks
 * the boards stale, so they refetch the next time their screen gains focus.
 */
import type { Query, QueryClient } from '@tanstack/react-query';

export type ServerRoot =
  | 'summary'
  | 'league'
  | 'friends-board'
  | 'global-board'
  | 'clan'
  | 'clan-preview'
  | 'friends'
  | 'profile'
  | 'search'
  | 'blocked'
  | 'memberStats'
  | 'heatmap'
  | 'notificationPrefs';

const FRIENDSHIP: readonly ServerRoot[] = ['friends', 'profile', 'search', 'friends-board', 'memberStats', 'heatmap'];
const CLAN: readonly ServerRoot[] = ['clan', 'clan-preview', 'friends-board', 'profile', 'memberStats', 'heatmap'];

/** What each server write moves. `'all'` for writes that reach every board (blocks); `[]` for none. */
const WRITE_ROOTS: Readonly<Record<string, readonly ServerRoot[] | 'all'>> = {
  send_friend_request: FRIENDSHIP,
  respond_friend_request: FRIENDSHIP,
  cancel_friend_request: FRIENDSHIP,
  remove_friend: FRIENDSHIP,
  block_user: 'all',
  unblock_user: 'all',
  report_target: [],
  update_profile: ['summary', 'profile', 'global-board', 'heatmap'],
  create_clan: CLAN,
  join_clan: CLAN,
  leave_clan: CLAN,
  set_member_role: ['clan'],
  transfer_leadership: ['clan'],
  remove_member: CLAN,
  regenerate_clan_code: ['clan'],
};

/** Roots a settled drive or drive action moves, besides the summary. */
const AFTER_DRIVE_STALE: readonly ServerRoot[] = ['league', 'friends-board', 'global-board', 'clan', 'profile', 'memberStats', 'heatmap'];

function inRoots(roots: readonly ServerRoot[]) {
  return (q: Query): boolean => q.queryKey[0] === 'server' && roots.includes(q.queryKey[2] as ServerRoot);
}

/** After a server write `fn` lands. Unknown writes invalidate everything (safe default). */
export function invalidateAfterWrite(qc: QueryClient, fn: string): Promise<void> {
  const roots = WRITE_ROOTS[fn] ?? 'all';
  if (roots === 'all') return qc.invalidateQueries({ queryKey: ['server'] });
  if (roots.length === 0) return Promise.resolve();
  return qc.invalidateQueries({ predicate: inRoots(roots) });
}

/** After the server settled a drive upload or a drive action: refetch the summary, mark boards stale. */
export async function invalidateAfterDrive(qc: QueryClient): Promise<void> {
  await Promise.all([
    qc.invalidateQueries({ predicate: inRoots(['summary']) }),
    qc.invalidateQueries({ predicate: inRoots(AFTER_DRIVE_STALE), refetchType: 'none' }),
  ]);
}

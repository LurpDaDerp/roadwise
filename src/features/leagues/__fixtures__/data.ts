/** Board fixtures shaped like the server's JSON, for the model and screen suites. */
import type { FriendsBoardRow, GlobalBoard, LeagueMember, MyLeague } from '../api';

export const leagueMember = (rank: number, over: Partial<LeagueMember> = {}): LeagueMember => ({
  rank,
  user_id: `u${rank}`,
  username: `driver${rank}`,
  level: 3,
  week_points: 1000 - rank * 10,
  drives: 4,
  is_me: false,
  ...over,
});

export const league = (over: Partial<MyLeague> = {}): MyLeague => ({
  week: '2026-W41',
  ends_at: '2026-10-12T04:00:00.000Z',
  tier: 'gold',
  eligible: true,
  placed: true,
  group_id: 'g1',
  members: Array.from({ length: 30 }, (_, i) => leagueMember(i + 1)),
  size: 30,
  promote: 7,
  demote: 5,
  min_drives_to_promote: 3,
  last_result: null,
  ...over,
});

export const friendRow = (username: string, over: Partial<FriendsBoardRow> = {}): FriendsBoardRow => ({
  rank: 1,
  user_id: username,
  username,
  level: 2,
  value: 100,
  ranked: true,
  is_me: false,
  ...over,
});

export const globalBoard = (over: Partial<GlobalBoard> = {}): GlobalBoard => ({
  top: [
    { rank: 1, user_id: 'g1', username: 'smooth_sam', safety_rating: 99.4, clean_miles: 410.2 },
    { rank: 2, user_id: 'id-me', username: 'maya', safety_rating: 97.1, clean_miles: 220 },
  ],
  me: { rank: 2, percentile: 8, eligible: true, safety_rating: 97.1 },
  ...over,
});

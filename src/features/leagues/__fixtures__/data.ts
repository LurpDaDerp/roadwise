/** Board fixtures shaped like the server's JSON, for the model and screen suites. */
import type { FriendsBoardRow, GlobalBoard } from '../api';

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

/** Board fixtures shaped like the server's JSON, for the model and screen suites. */
import type { FriendsBoardRow } from '../api';

export const friendRow = (username: string, over: Partial<FriendsBoardRow> = {}): FriendsBoardRow => ({
  rank: 1,
  user_id: username,
  username,
  value: 90,
  ranked: true,
  is_me: false,
  miles_90d: 128,
  ...over,
});

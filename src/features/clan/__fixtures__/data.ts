/** Clan fixtures shaped like `get_my_clan`'s JSON. */
import type { ClanMember, MyClan } from '../api';

export const clanMember = (username: string, over: Partial<ClanMember> = {}): ClanMember => ({
  user_id: `id-${username}`,
  username,
  role: 'member',
  joined_at: '2026-09-01T00:00:00.000Z',
  level: 4,
  safety_rating: 90,
  ranked: true,
  points: 1200,
  week_points: 150,
  miles_30d: 80,
  clean_pct: 75,
  streak: 6,
  ...over,
});

export const myClan = (over: Partial<MyClan> = {}): MyClan => ({
  clan: { id: 'clan-1', name: 'Night Owls', banner: 'ocean', invite_code: 'ABCD2345', member_count: 3 },
  my_role: 'leader',
  goal: { week: '2026-W41', target_clean_miles: 80, clean_miles: 31.6 },
  members: [
    clanMember('me', { role: 'leader', joined_at: '2026-08-01T00:00:00.000Z', safety_rating: 95, points: 3000 }),
    clanMember('copilot', { role: 'coleader', joined_at: '2026-08-15T00:00:00.000Z', safety_rating: 88, points: 900 }),
    clanMember('rookie', { ranked: false, safety_rating: 99, points: 40, clean_pct: null, streak: 1 }),
  ],
  ...over,
});

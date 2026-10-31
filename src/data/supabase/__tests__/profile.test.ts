import { fetchProfile, PROFILE_COLUMNS, updateOwnProfile } from '@/data/supabase/profile';

const mockRpc = jest.fn(async (_fn: string, _args: Record<string, unknown>) => null);
jest.mock('@/data/server/rpc', () => ({ callRpc: (fn: string, args: Record<string, unknown>) => mockRpc(fn, args) }));

// The real client reads `.env` and AsyncStorage at import time, neither of which exists under Jest.
const mockSelect = jest.fn();
jest.mock('@/data/supabase/client', () => ({
  supabase: {
    from: (table: string) => ({
      select: (columns: string) => {
        mockSelect(table, columns);
        return { eq: () => ({ single: async () => ({ data: { id: 'u1' }, error: null }) }) };
      },
    }),
  },
}));

test("reads the owner's profile by the columns the server grants, never `*` (it hides `flagged`)", async () => {
  await fetchProfile('u1');
  expect(mockSelect).toHaveBeenCalledWith('profiles', PROFILE_COLUMNS);
  expect(PROFILE_COLUMNS).not.toMatch(/\*|flagged/);
});

// Granted for older builds only: this build no longer reads it.
const UNREAD = new Set(['league_eligible']);

test('asks for exactly the columns the migrations grant to the owner, less those later migrations drop and those it no longer reads', () => {
  // eslint-disable-next-line @typescript-eslint/no-require-imports -- a Node read in a test
  const fs = require('node:fs') as { readFileSync: (f: string, e: string) => string; readdirSync: (d: string) => string[] };
  // eslint-disable-next-line @typescript-eslint/no-require-imports -- ditto
  const { join } = require('node:path') as { join: (...p: string[]) => string };
  const dir = join(process.cwd(), 'supabase/migrations');
  const files = fs.readdirSync(dir).filter((f) => f.endsWith('.sql')).sort();
  const all = files.map((f) => fs.readFileSync(join(dir, f), 'utf8'));
  const names = (list: string) => list.split(',').map((c) => c.trim());
  const granted = new Set(all.flatMap((sql) => [...sql.matchAll(/grant select \(([^)]*)\)\s+on public\.profiles to authenticated/g)].flatMap((m) => names(m[1] ?? ''))));
  const dropped = new Set(all.flatMap((sql) => [...sql.matchAll(/alter table public\.profiles drop column (\w+)/g)].map((m) => m[1])));
  expect(names(PROFILE_COLUMNS).sort()).toEqual([...granted].filter((c) => !dropped.has(c) && !UNREAD.has(c)).sort());
  expect(names(PROFILE_COLUMNS)).not.toContain('league_eligible');
  expect(names(PROFILE_COLUMNS)).toEqual(expect.arrayContaining(['share_rating', 'share_categories', 'share_achievements', 'share_stats']));
});

test('update_profile carries only the keys given: the four sharing switches, the heat map and the units', async () => {
  await updateOwnProfile('u1', { share_rating: false, share_categories: true, share_achievements: true, share_stats: false, heatmap_visibility: 'friends' });
  expect(mockRpc).toHaveBeenLastCalledWith('update_profile', {
    p_share_rating: false,
    p_share_categories: true,
    p_share_achievements: true,
    p_share_stats: false,
    p_heatmap_visibility: 'friends',
  });
  await updateOwnProfile('u1', { units: 'km' });
  expect(mockRpc).toHaveBeenLastCalledWith('update_profile', { p_units: 'km' });
});

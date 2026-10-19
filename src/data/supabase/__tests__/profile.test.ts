import { fetchProfile, PROFILE_COLUMNS } from '@/data/supabase/profile';

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

test('asks for exactly the columns migration 0001 grants to the owner, less those later migrations drop', () => {
  // eslint-disable-next-line @typescript-eslint/no-require-imports -- a Node read in a test
  const fs = require('node:fs') as { readFileSync: (f: string, e: string) => string; readdirSync: (d: string) => string[] };
  // eslint-disable-next-line @typescript-eslint/no-require-imports -- ditto
  const { join } = require('node:path') as { join: (...p: string[]) => string };
  const dir = join(process.cwd(), 'supabase/migrations');
  const sql = fs.readFileSync(join(dir, '0001_core.sql'), 'utf8');
  const granted = /grant select \(([^)]*)\)\s+on public\.profiles to authenticated/.exec(sql)?.[1] ?? '';
  const dropped = new Set(
    fs
      .readdirSync(dir)
      .filter((f) => f.endsWith('.sql'))
      .flatMap((f) => [...fs.readFileSync(join(dir, f), 'utf8').matchAll(/alter table public\.profiles drop column (\w+)/g)].map((m) => m[1]))
  );
  const names = (list: string) => list.split(',').map((c) => c.trim()).sort();
  expect(names(PROFILE_COLUMNS)).toEqual(names(granted).filter((c) => !dropped.has(c)));
});

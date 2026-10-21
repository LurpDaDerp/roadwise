/** @jest-environment node */
import { QueryClient, QueryObserver } from '@tanstack/react-query';

import { invalidateAfterDrive, invalidateAfterWrite } from '../invalidate';

function setup() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: Infinity } } });
  const fetches: string[] = [];
  const roots = ['summary', 'friends-board', 'friends', 'profile', 'memberStats'];
  const unsubs = roots.map((root) => {
    const obs = new QueryObserver(qc, {
      queryKey: ['server', 'u1', root],
      queryFn: async () => {
        fetches.push(root);
        return root;
      },
    });
    return obs.subscribe(() => {});
  });
  const stale = (root: string) => qc.getQueryState(['server', 'u1', root])?.isInvalidated ?? false;
  return { qc, fetches, stale, done: () => unsubs.forEach((u) => u()) };
}

async function mounted(s: ReturnType<typeof setup>): Promise<void> {
  await new Promise((r) => setTimeout(r, 0));
  s.fetches.length = 0;
}

test('a settled drive refetches only the summary and marks the boards stale for their next focus', async () => {
  const s = setup();
  await mounted(s);
  await invalidateAfterDrive(s.qc);
  expect(s.fetches).toEqual(['summary']);
  expect(s.stale('friends-board')).toBe(true);
  expect(s.stale('memberStats')).toBe(true);
  expect(s.stale('friends')).toBe(false);
  s.done();
});

test('a social write refetches only what it moves; a report moves nothing; a block moves everything', async () => {
  const s = setup();
  await mounted(s);
  await invalidateAfterWrite(s.qc, 'send_friend_request');
  expect(s.fetches.sort()).toEqual(['friends', 'friends-board', 'memberStats', 'profile']);
  s.fetches.length = 0;
  await invalidateAfterWrite(s.qc, 'report_target');
  expect(s.fetches).toEqual([]);
  // a sharing setting moves the driver's row on the friends board and what friends see of them
  await invalidateAfterWrite(s.qc, 'update_profile');
  expect(s.fetches.sort()).toEqual(['friends-board', 'memberStats', 'profile', 'summary']);
  s.fetches.length = 0;
  await invalidateAfterWrite(s.qc, 'block_user');
  expect(s.fetches.sort()).toEqual(['friends', 'friends-board', 'memberStats', 'profile', 'summary']);
  s.done();
});

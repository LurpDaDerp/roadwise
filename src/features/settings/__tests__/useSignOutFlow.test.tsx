import { act, renderHook } from '@testing-library/react-native';

import type { SignOutOutcome } from '@/data/supabase/session';

import { useSignOutFlow } from '../useSignOutFlow';

const mockSignOut = jest.fn(async (_opts?: { force?: boolean }): Promise<SignOutOutcome> => ({ signedOut: true }));
jest.mock('@/data/supabase/session', () => ({ useSession: () => ({ signOut: mockSignOut }) }));

beforeEach(() => mockSignOut.mockReset());

test('a sign-out Supabase could not finish says so and asks nothing', async () => {
  mockSignOut.mockResolvedValueOnce({ signedOut: false, failed: true });
  const confirm = jest.fn(async () => true);
  const notify = jest.fn();
  const { result } = await renderHook(() => useSignOutFlow(confirm, notify));
  await act(async () => result.current.signOut());
  expect(notify).toHaveBeenCalledTimes(1);
  expect(confirm).not.toHaveBeenCalled();
  expect(mockSignOut).toHaveBeenCalledTimes(1);
  expect(result.current.signingOut).toBe(false);
});

test('unsent work asks first; a forced sign-out that then cannot finish says so too', async () => {
  mockSignOut.mockResolvedValueOnce({ signedOut: false, unsentDeletes: 2 }).mockResolvedValueOnce({ signedOut: false, failed: true });
  const confirm = jest.fn(async () => true);
  const notify = jest.fn();
  const { result } = await renderHook(() => useSignOutFlow(confirm, notify));
  await act(async () => result.current.signOut());
  expect(confirm).toHaveBeenCalledWith(expect.stringContaining('2 drives or reports'));
  expect(mockSignOut).toHaveBeenLastCalledWith({ force: true });
  expect(notify).toHaveBeenCalledTimes(1);
});

test('a plain sign-out tells nobody anything', async () => {
  const notify = jest.fn();
  const { result } = await renderHook(() => useSignOutFlow(jest.fn(), notify));
  await act(async () => result.current.signOut());
  expect(notify).not.toHaveBeenCalled();
});

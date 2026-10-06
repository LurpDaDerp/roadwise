import { renderHook } from '@testing-library/react-native';

import { buildFlowContext, useFlowContext } from '../context';

const mockSession: { profile: Record<string, unknown> | null } = { profile: null };
jest.mock('@/data/supabase/session', () => ({ useSession: () => mockSession }));

describe('buildFlowContext', () => {
  it('a claimed username drops the username step', () => {
    expect(buildFlowContext({ platform: 'ios', profile: { username: 'swift_fox' } })).toEqual({
      platform: 'ios',
      hasUsername: true,
    });
  });

  it('no username, a blank one, or a row without the column: still owed', () => {
    for (const profile of [{ username: null }, { username: '  ' }, {}, null]) {
      expect(buildFlowContext({ platform: 'android', profile }).hasUsername).toBe(false);
    }
  });
});

describe('useFlowContext', () => {
  it("is null while there is no profile, then follows it", async () => {
    mockSession.profile = null;
    const { result, rerender } = await renderHook(() => useFlowContext());
    expect(result.current).toBeNull();
    mockSession.profile = { username: 'swift_fox' };
    await rerender({});
    expect(result.current?.hasUsername).toBe(true);
  });
});

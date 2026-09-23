import { act, fireEvent, screen, waitFor } from '@testing-library/react-native';

import { renderedStrings } from '@/features/rewards/__fixtures__/goalChallengesWorld';
import { clearInboxClients, setOnline, settleInbox } from '@/features/inbox/__fixtures__/harness';
import { JOIN_HREF } from '@/features/notifications/hrefs';
import { BANNED_COPY } from '@/notifications/catalog';

import type { MyReferrals } from '../api';
import { referralCopy as copy } from '../copy';
import { JoinScreen } from '../JoinScreen';
import { CODE, fakeReferralApi, noRefresh, referralWorld, referrals } from '../__fixtures__/world';

jest.mock('@/data/supabase/client', () => ({ supabase: {} }));
jest.mock('@/data/supabase/session', () => ({
  useSession: () => ({ session: { user: { id: '00000000-0000-4000-8000-00000000000a' } } }),
}));
const mockRouter = { push: jest.fn(), back: jest.fn(), replace: jest.fn(), canGoBack: jest.fn(() => true) };
jest.mock('expo-router', () => ({ useRouter: () => mockRouter }));

afterEach(async () => {
  await clearInboxClients();
  setOnline(null);
  mockRouter.canGoBack.mockReturnValue(true);
  jest.clearAllMocks();
});

async function renderJoin(param: unknown, state: MyReferrals = referrals({ canRedeem: true }), opts: { referral?: boolean } = {}) {
  const w = await referralWorld({ referral: opts.referral ?? true });
  const server = fakeReferralApi(state);
  await w.render(<JoinScreen code={param} deps={{ api: server.api, refreshConfig: noRefresh }} />);
  await screen.findByTestId('join-screen');
  await waitFor(() => expect(screen.queryByTestId('join-loading')).toBeNull());
  await settleInbox();
  return { ...w, ...server };
}

const press = async (el: Parameters<typeof fireEvent.press>[0]) => {
  await act(async () => {
    fireEvent.press(el);
  });
  await settleInbox();
};

function assertCopyRules() {
  for (const s of renderedStrings(screen.toJSON())) {
    for (const re of BANNED_COPY) expect(s).not.toMatch(re);
    expect(s).not.toMatch(/redeem/i);
  }
}

describe('JoinScreen (roadwise://join/<code>)', () => {
  test('the route is the allowlisted one', () => {
    expect(JOIN_HREF.test(`/join/${CODE}`)).toBe(true);
  });

  test.each([['IIII1111'], ['ABC'], [undefined], [['ABCD2345', 'x']], ['ABCD2345/../x']])(
    'an invalid link (%p): said so, with Back, and no request',
    async (param) => {
      const { api } = await renderJoin(param);
      expect(screen.getByText(copy.join.invalid)).toBeTruthy();
      expect(api.fetchMyReferrals).not.toHaveBeenCalled();
      expect(api.redeemReferralCode).not.toHaveBeenCalled();
      await press(screen.getByRole('button', { name: 'Back' }));
      expect(mockRouter.back).toHaveBeenCalled();
    }
  );

  test('a valid link asks first: nothing is used until the tap', async () => {
    const { api } = await renderJoin(CODE);
    const question = screen.getByTestId('join-question');
    expect(question.props.children).toBe('Use code ABCD2345 from a friend?');
    expect(question.props.accessibilityLabel).toBe('Use code A, B, C, D, 2, 3, 4, 5 from a friend?');
    expect(api.redeemReferralCode).not.toHaveBeenCalled();
    await press(screen.getByRole('button', { name: 'Use code' }));
    expect(api.redeemReferralCode).toHaveBeenCalledWith(CODE);
    expect(screen.getByText(copy.redeem.saved)).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Use code' })).toBeNull();
    assertCopyRules();
  });

  test('a lower-case link is read as its code', async () => {
    await renderJoin('abcd2345');
    expect(screen.getByTestId('join-question').props.children).toBe('Use code ABCD2345 from a friend?');
  });

  test('Not now leaves without using it', async () => {
    const { api } = await renderJoin(CODE);
    await press(screen.getByRole('button', { name: 'Not now' }));
    expect(mockRouter.back).toHaveBeenCalled();
    expect(api.redeemReferralCode).not.toHaveBeenCalled();
  });

  test('Not now with nowhere to go back to: Home', async () => {
    mockRouter.canGoBack.mockReturnValue(false);
    await renderJoin(CODE);
    await press(screen.getByRole('button', { name: 'Not now' }));
    expect(mockRouter.replace).toHaveBeenCalledWith('/(tabs)/home');
  });

  test('a refusal reads the generic line, and the question stays', async () => {
    const { server } = await renderJoin(CODE);
    server.fail.redeem = 'invalid';
    await press(screen.getByRole('button', { name: 'Use code' }));
    expect(screen.getByTestId('join-error').props.children).toBe("That code didn't work.");
  });

  test('the window closed: the explanation, and no way to use it', async () => {
    await renderJoin(CODE, referrals({ canRedeem: false, myCode: 'none' }));
    expect(screen.getByText('Codes can be used in your first 14 days.')).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Use code' })).toBeNull();
    assertCopyRules();
  });

  test('a code already used: the explanation and its status', async () => {
    await renderJoin(CODE, referrals({ canRedeem: false, myCode: 'pending' }));
    expect(screen.getByText("You've already used a friend's code.")).toBeTruthy();
    expect(screen.getByText("Your friend's code will count after 3 scored drives.")).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Use code' })).toBeNull();
  });

  test('flag off: not available, nothing asked, and the link does not break', async () => {
    const { api } = await renderJoin(CODE, referrals({ canRedeem: true }), { referral: false });
    expect(screen.getByText(copy.unavailable)).toBeTruthy();
    expect(api.fetchMyReferrals).not.toHaveBeenCalled();
    expect(screen.queryByRole('button', { name: 'Use code' })).toBeNull();
  });
});

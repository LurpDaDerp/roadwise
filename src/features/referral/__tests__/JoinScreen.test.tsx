import { act, fireEvent, screen, waitFor } from '@testing-library/react-native';

import { renderedStrings } from '@/features/rewards/__fixtures__/goalChallengesWorld';
import { clearInboxClients, setOnline, settleInbox } from '@/features/inbox/__fixtures__/harness';
import { JOIN_HREF } from '@/features/notifications/hrefs';
import { clearAllHeldJoinArrivals, markHeldJoinArrival } from '@/features/onboarding/state';
import { BANNED_COPY } from '@/notifications/catalog';

import type { MyReferrals } from '../api';
import { referralCopy as copy } from '../copy';
import { JoinScreen } from '../JoinScreen';
import { CODE, fakeReferralApi, noRefresh, referralWorld, referrals, UID } from '../__fixtures__/world';

jest.mock('@/data/supabase/client', () => ({ supabase: {} }));
jest.mock('@/data/supabase/session', () => ({
  useSession: () => ({ session: { user: { id: '00000000-0000-4000-8000-00000000000a' } } }),
}));
const mockRouter = { push: jest.fn(), back: jest.fn(), replace: jest.fn(), canGoBack: jest.fn(() => true) };
jest.mock('expo-router', () => ({ useRouter: () => mockRouter }));

afterEach(async () => {
  clearAllHeldJoinArrivals();
  await clearInboxClients();
  setOnline(null);
  mockRouter.canGoBack.mockReturnValue(true);
  jest.clearAllMocks();
});

/** The caller's own code is OWN; the links carry a friend's, CODE. */
const OWN = 'MNPQ6789';

async function renderJoin(
  param: unknown,
  state: MyReferrals = referrals({ canRedeem: true, code: OWN }),
  opts: { referral?: boolean; held?: boolean } = {}
) {
  if (opts.held) markHeldJoinArrival(UID, `/join/${CODE}`);
  const w = await referralWorld({ referral: opts.referral ?? true });
  const server = fakeReferralApi(state);
  await w.render(<JoinScreen code={param} deps={{ api: server.api, refreshConfig: noRefresh }} />);
  await screen.findByTestId('join-screen');
  await waitFor(() => expect(screen.queryByTestId('join-loading')).toBeNull());
  if (opts.held) await waitFor(() => expect(screen.queryByTestId('join-leaving')).toBeNull());
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

  test("n1: a link carrying the caller's own code is caught before any attempt is spent", async () => {
    const { api } = await renderJoin(CODE, referrals({ canRedeem: true, code: CODE }));
    await press(screen.getByRole('button', { name: 'Use code' }));
    expect(api.redeemReferralCode).not.toHaveBeenCalled();
    expect(screen.getByTestId('join-error').props.children).toBe("That's your own code.");
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
    expect(screen.getByText("Your friend's code counts once your first 3 scored drives are confirmed.")).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Use code' })).toBeNull();
  });

  test('flag off: not available, nothing asked, and the link does not break', async () => {
    const { api } = await renderJoin(CODE, referrals({ canRedeem: true }), { referral: false });
    expect(screen.getByText(copy.unavailable)).toBeTruthy();
    expect(api.fetchMyReferrals).not.toHaveBeenCalled();
    expect(screen.queryByRole('button', { name: 'Use code' })).toBeNull();
  });

  describe('opened by the app from a signed-out hold (T12 r1, security R6/R7)', () => {
    test('the account can use it: the same question, the code shown, and nothing sent until the tap', async () => {
      const { api } = await renderJoin(CODE, referrals({ canRedeem: true, code: OWN }), { held: true });
      expect(screen.getByTestId('join-question').props.children).toBe('Use code ABCD2345 from a friend?');
      expect(screen.getByRole('button', { name: 'Not now' })).toBeTruthy();
      expect(api.redeemReferralCode).not.toHaveBeenCalled();
      expect(mockRouter.replace).not.toHaveBeenCalled();
      await press(screen.getByRole('button', { name: 'Use code' }));
      expect(api.redeemReferralCode).toHaveBeenCalledWith(CODE);
    });

    test.each([
      ['the window closed', referrals({ canRedeem: false, myCode: 'none', code: OWN })],
      ['a code already used', referrals({ canRedeem: false, myCode: 'pending', code: OWN })],
    ])('%s: Home, silently, with no card', async (_name, state) => {
      const w = await referralWorld({ referral: true });
      const server = fakeReferralApi(state);
      markHeldJoinArrival(UID, `/join/${CODE}`);
      await w.render(<JoinScreen code={CODE} deps={{ api: server.api, refreshConfig: noRefresh }} />);
      await waitFor(() => expect(mockRouter.replace).toHaveBeenCalledWith('/(tabs)/home'));
      expect(screen.queryByText(copy.explain.windowClosed)).toBeNull();
      expect(screen.queryByText(copy.explain.alreadyUsed)).toBeNull();
      expect(screen.queryByText("That code didn't work.")).toBeNull();
      expect(server.api.redeemReferralCode).not.toHaveBeenCalled();
    });

    test('invites off: Home, silently, and nothing asked of the server', async () => {
      const w = await referralWorld({ referral: false });
      const server = fakeReferralApi();
      markHeldJoinArrival(UID, `/join/${CODE}`);
      await w.render(<JoinScreen code={CODE} deps={{ api: server.api, refreshConfig: noRefresh }} />);
      await waitFor(() => expect(mockRouter.replace).toHaveBeenCalledWith('/(tabs)/home'));
      expect(screen.queryByText(copy.unavailable)).toBeNull();
      expect(server.api.fetchMyReferrals).not.toHaveBeenCalled();
    });

    test("a mark for another account never silences this account's direct open (m2)", async () => {
      markHeldJoinArrival('someone-else', `/join/${CODE}`);
      await renderJoin(CODE, referrals({ canRedeem: false, myCode: 'none', code: OWN }));
      expect(screen.getByText(copy.explain.windowClosed)).toBeTruthy();
      expect(mockRouter.replace).not.toHaveBeenCalled();
    });

    test('the mark is used once: opening the same link directly later explains as usual', async () => {
      const w = await referralWorld({ referral: true });
      markHeldJoinArrival(UID, `/join/${CODE}`);
      const first = fakeReferralApi(referrals({ canRedeem: true, code: OWN }));
      const view = await w.render(<JoinScreen code={CODE} deps={{ api: first.api, refreshConfig: noRefresh }} />);
      await screen.findByTestId('join-question');
      await view.unmount();
      await renderJoin(CODE, referrals({ canRedeem: false, myCode: 'none', code: OWN }));
      expect(screen.getByText(copy.explain.windowClosed)).toBeTruthy();
      expect(mockRouter.replace).not.toHaveBeenCalled();
    });
  });
});

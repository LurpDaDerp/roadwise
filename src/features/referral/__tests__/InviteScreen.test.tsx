import { act, fireEvent, screen, waitFor, within } from '@testing-library/react-native';
import { Platform } from 'react-native';

import { NOT_MONEY } from '@/features/rewards/copy/common';
import { renderedStrings } from '@/features/rewards/__fixtures__/goalChallengesWorld';
import { clearInboxClients, setOnline, settleInbox } from '@/features/inbox/__fixtures__/harness';
import { BANNED_COPY } from '@/notifications/catalog';

import type { MyReferrals, ReferralErrorCode } from '../api';
import { referralCopy as copy } from '../copy';
import { InviteScreen } from '../InviteScreen';
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
  jest.clearAllMocks();
});

const STORE = { ios: 'https://apps.apple.com/app/id1', android: 'https://play.google.com/store/apps/details?id=x' };

async function renderInvite(
  state: MyReferrals = referrals(),
  opts: { referral?: boolean; store?: typeof STORE; cached?: MyReferrals; offline?: boolean } = {}
) {
  const w = await referralWorld({ referral: opts.referral ?? true, store: opts.store, cached: opts.cached });
  if (opts.offline) setOnline(false);
  const server = fakeReferralApi(state);
  const share = jest.fn(async (_content: { message: string }) => ({ action: 'sharedAction' }));
  await w.render(<InviteScreen deps={{ api: server.api, refreshConfig: noRefresh, share }} />);
  await screen.findByTestId('invite-screen');
  await waitFor(() => expect(screen.queryByTestId('invite-loading')).toBeNull());
  await settleInbox();
  return { ...w, ...server, share };
}

const press = async (el: Parameters<typeof fireEvent.press>[0]) => {
  await act(async () => {
    fireEvent.press(el);
  });
  await settleInbox();
};

function assertCopyRules() {
  const strings = renderedStrings(screen.toJSON());
  expect(strings.length).toBeGreaterThan(0);
  for (const s of strings) {
    for (const re of BANNED_COPY) expect(s).not.toMatch(re);
    expect(s).not.toMatch(/redeem/i);
  }
}

describe('InviteScreen (F10)', () => {
  test('flag off: a plain "not available" with Back, and no request', async () => {
    const { api } = await renderInvite(referrals(), { referral: false });
    expect(screen.getByText(copy.unavailable)).toBeTruthy();
    expect(screen.queryByText('ABCD 2345')).toBeNull();
    expect(screen.queryByRole('button', { name: copy.invite.share })).toBeNull();
    expect(api.fetchMyReferrals).not.toHaveBeenCalled();
    expect(api.getMyReferralCode).not.toHaveBeenCalled();
    await press(screen.getByTestId('referral-unavailable-back'));
    expect(mockRouter.back).toHaveBeenCalled();
    assertCopyRules();
  });

  test('the server says not available (a stale flag): the same plain state', async () => {
    const w = await referralWorld({ referral: true });
    const server = fakeReferralApi();
    server.server.fail.fetch = 'not_available';
    await w.render(<InviteScreen deps={{ api: server.api, refreshConfig: noRefresh }} />);
    expect(await screen.findByText(copy.unavailable)).toBeTruthy();
  });

  test('the code: large, in two groups, spoken letter by letter', async () => {
    await renderInvite();
    const code = screen.getByTestId('invite-code');
    expect(within(code).getByText('ABCD 2345')).toBeTruthy();
    expect(code.props.accessibilityLabel).toBe('Your code: A, B, C, D, 2, 3, 4, 5');
  });

  test('the explainer, the not-money line and the yearly limit', async () => {
    await renderInvite();
    expect(screen.getByText('You both get 500 points after your friend finishes 3 scored drives.')).toBeTruthy();
    expect(screen.getByText(NOT_MONEY)).toBeTruthy();
    expect(screen.getByText('Up to 20 invites a year earn points.')).toBeTruthy();
    assertCopyRules();
  });

  test('the status is counts only', async () => {
    await renderInvite(referrals({ joined: 3, qualified: 1, rewardedThisYear: 1 }));
    const status = screen.getByTestId('invite-status');
    expect(within(status).getByText('3 joined · 1 counted')).toBeTruthy();
    expect(status.props.accessibilityLabel).toBe('Friends: 3 joined, 1 counted');
    expect(screen.queryByText(copy.invite.cap)).toBeNull();
  });

  test('the cap reached', async () => {
    await renderInvite(referrals({ joined: 25, qualified: 22, rewardedThisYear: 20 }));
    expect(screen.getByText(copy.invite.cap)).toBeTruthy();
  });

  test('Share invite: the message with no store link configured', async () => {
    const { share } = await renderInvite();
    await press(screen.getByRole('button', { name: 'Share invite' }));
    expect(share).toHaveBeenCalledTimes(1);
    expect(share.mock.calls[0]?.[0]).toEqual({
      message:
        "I'm using RoadWise to get better at driving. Join me with my code ABCD2345.\n" +
        'If you have the app: roadwise://join/ABCD2345',
    });
  });

  test("Share invite: this platform's store link when configured", async () => {
    const { share } = await renderInvite(referrals(), { store: STORE });
    await press(screen.getByRole('button', { name: 'Share invite' }));
    const link = Platform.OS === 'ios' ? STORE.ios : STORE.android;
    expect(share.mock.calls[0]?.[0].message).toBe(
      `I'm using RoadWise to get better at driving. Join me with my code ${CODE}.\n${link}\n` +
        `If you have the app: roadwise://join/${CODE}`
    );
  });

  test('a code not created yet is asked for once, then shown', async () => {
    const { api } = await renderInvite(referrals({ code: null }));
    expect(api.getMyReferralCode).toHaveBeenCalledTimes(1);
    expect(within(screen.getByTestId('invite-code')).getByText('ABCD 2345')).toBeTruthy();
  });

  test('the code could not be loaded: said so, and nothing to share', async () => {
    const w = await referralWorld({ referral: true });
    const server = fakeReferralApi(referrals({ code: null }));
    server.server.fail.code = 'unknown';
    await w.render(<InviteScreen deps={{ api: server.api, refreshConfig: noRefresh }} />);
    expect(await screen.findByText(copy.invite.codeError)).toBeTruthy();
    const shareButton = screen.getByRole('button', { name: 'Share invite' });
    expect(shareButton.props.accessibilityState).toMatchObject({ disabled: true });
  });

  test('offline: the saved counts and code, marked as saved', async () => {
    await renderInvite(referrals(), { cached: referrals({ joined: 2, qualified: 2 }), offline: true });
    expect(screen.getByText(copy.offline)).toBeTruthy();
    expect(screen.getByText('2 joined · 2 counted')).toBeTruthy();
    expect(within(screen.getByTestId('invite-code')).getByText('ABCD 2345')).toBeTruthy();
  });

  test('"Got a code from a friend?" only while a code can still be used', async () => {
    await renderInvite(referrals({ canRedeem: false }));
    expect(screen.queryByText(copy.invite.gotCode)).toBeNull();
    expect(screen.queryByTestId('redeem-input')).toBeNull();
    await clearInboxClients();
    await renderInvite(referrals({ canRedeem: true }));
    expect(screen.getByText(copy.invite.gotCode)).toBeTruthy();
    expect(screen.getByTestId('redeem-input')).toBeTruthy();
  });

  describe('using a friend\'s code', () => {
    test('what is typed is upper-cased and cleaned, sent only on the tap, then saved', async () => {
      const { api } = await renderInvite(referrals({ canRedeem: true }));
      const input = screen.getByTestId('redeem-input');
      expect(input.props.autoCorrect).toBe(false);
      expect(input.props.autoCapitalize).toBe('characters');
      await act(async () => {
        fireEvent.changeText(input, 'abcd-2345');
      });
      expect(screen.getByTestId('redeem-input').props.value).toBe('ABCD2345');
      expect(api.redeemReferralCode).not.toHaveBeenCalled();
      await press(screen.getByRole('button', { name: 'Use code' }));
      expect(api.redeemReferralCode).toHaveBeenCalledWith('ABCD2345');
      expect(screen.getByText(copy.redeem.saved)).toBeTruthy();
      expect(screen.queryByTestId('redeem-input')).toBeNull();
      assertCopyRules();
    });

    test('the pattern gate: IIII1111 is refused here, with no request', async () => {
      const { api } = await renderInvite(referrals({ canRedeem: true }));
      await act(async () => {
        fireEvent.changeText(screen.getByTestId('redeem-input'), 'IIII1111');
      });
      await press(screen.getByRole('button', { name: 'Use code' }));
      expect(api.redeemReferralCode).not.toHaveBeenCalled();
      expect(screen.getByText("That code doesn't look right.")).toBeTruthy();
    });

    test.each<[ReferralErrorCode, string]>([
      ['invalid', "That code didn't work."],
      ['window_closed', "That code didn't work."],
      ['already_used', "That code didn't work."],
      ['too_many', "That code didn't work."],
      ['own_code', "That's your own code."],
      ['busy', 'Busy right now. Try again.'],
      ['unknown', 'Something went wrong. Try again.'],
    ])('a refusal (%s) reads: %s', async (code, text) => {
      const { server } = await renderInvite(referrals({ canRedeem: true }));
      server.fail.redeem = code;
      await act(async () => {
        fireEvent.changeText(screen.getByTestId('redeem-input'), CODE);
      });
      await press(screen.getByRole('button', { name: 'Use code' }));
      expect(screen.getByTestId('redeem-error').props.children).toBe(text);
      assertCopyRules();
    });

    test('offline: refused with no request, said plainly', async () => {
      const { api } = await renderInvite(referrals({ canRedeem: true }), { cached: referrals({ canRedeem: true }), offline: true });
      await act(async () => {
        fireEvent.changeText(screen.getByTestId('redeem-input'), CODE);
      });
      await press(screen.getByRole('button', { name: 'Use code' }));
      expect(api.redeemReferralCode).not.toHaveBeenCalled();
      expect(screen.getByTestId('redeem-error').props.children).toBe(copy.error.offline);
    });
  });

  test.each([
    ['pending', "Your friend's code will count after 3 scored drives."],
    ['counted', "Your friend's code counted: 500 points added."],
    ['not_counted', "Your friend's code didn't count this time."],
  ] as const)("the friend's code status: %s", async (myCode, text) => {
    await renderInvite(referrals({ myCode }));
    expect(screen.getByText(text)).toBeTruthy();
    assertCopyRules();
  });

  test('nothing about anyone: no date, time or @ anywhere on screen', async () => {
    await renderInvite(referrals({ joined: 4, qualified: 2, myCode: 'counted' }));
    for (const s of renderedStrings(screen.toJSON())) {
      expect(s).not.toMatch(/\d{4}-\d{2}-\d{2}|\d{1,2}:\d{2}|@/);
    }
  });
});

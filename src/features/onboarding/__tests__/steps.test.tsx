/**
 * The v3 steps WP9 builds: username (live check with a friendly reason, then claim), how it works,
 * and the optional DashPal step, the last, whose way out finishes onboarding (through the stepper).
 */
import { act, fireEvent, screen, waitFor } from '@testing-library/react-native';
import { AccessibilityInfo, Platform } from 'react-native';

import { createDashpalSecrets } from '@/dashcam/secure';
import { RpcError } from '@/data/server/rpc';
import { answerRpc, appWorld, clearQueryClients, fakeAdapter, tap } from '@/features/permissions/__fixtures__/harness';

import { onboardingCopy } from '../copy';
import type { FlowContext } from '../flow';
import { DashcamStep } from '../steps/DashcamStep';
import { HowStep } from '../steps/HowStep';
import { localCheck, normaliseUsername, UsernameStep } from '../steps/UsernameStep';

const mockRpc = jest.fn();
jest.mock('@/data/server/rpc', () => {
  const actual = jest.requireActual('@/data/server/rpc');
  return { ...actual, callRpc: (fn: string, args?: unknown) => mockRpc(fn, args) };
});
jest.mock('@/data/supabase/client', () => ({ supabase: {} }));
const mockSession = {
  session: { user: { id: 'u1' } },
  profile: { username: null as string | null },
  refreshProfile: jest.fn(async () => {}),
};
jest.mock('@/data/supabase/session', () => ({ useSession: () => mockSession }));
const mockRouter = { replace: jest.fn(), push: jest.fn(), back: jest.fn(), canGoBack: () => false };
jest.mock('expo-router', () => ({ useRouter: () => mockRouter }));

const ctx: FlowContext = { platform: 'ios', hasUsername: false };
const copy = onboardingCopy;

/** What the step asked VoiceOver (iPhone, the tests' platform) or TalkBack to read out, in order. */
const spoken = () => jest.mocked(AccessibilityInfo.announceForAccessibilityWithOptions).mock.calls.map(([text]) => text);
const spokenAndroid = () => jest.mocked(AccessibilityInfo.announceForAccessibility).mock.calls.map(([text]) => text);

beforeEach(() => {
  jest.mocked(AccessibilityInfo.announceForAccessibility).mockClear();
  jest.mocked(AccessibilityInfo.announceForAccessibilityWithOptions).mockClear();
  mockRpc.mockReset();
  mockRouter.replace.mockClear();
  mockSession.refreshProfile.mockClear();
  mockSession.profile = { username: null };
});
afterEach(() => clearQueryClients());

describe('username', () => {
  it('says what is wrong before asking the server', () => {
    expect(localCheck('')).toEqual({ state: 'empty' });
    expect(localCheck('ab')).toEqual({ state: 'invalid', reason: 'length' });
    expect(localCheck('a'.repeat(21))).toEqual({ state: 'invalid', reason: 'length' });
    expect(localCheck('fox-1')).toEqual({ state: 'invalid', reason: 'characters' });
    expect(localCheck('swift_fox')).toBeNull();
    expect(normaliseUsername('Swift Fox')).toBe('swiftfox');
  });

  async function type(text: string) {
    const input = await screen.findByTestId('username-input');
    await act(async () => {
      fireEvent.changeText(input, text);
    });
  }

  it.each([
    ['reserved', copy.username.reasons.reserved],
    ['not_allowed', copy.username.reasons.not_allowed],
    ['taken', copy.username.reasons.taken],
  ])('the server’s %s comes back as a friendly line, and Claim stays off', async (reason, line) => {
    answerRpc(mockRpc, { check_username: { available: false, reason } });
    const w = await appWorld();
    await w.render(<UsernameStep ctx={ctx} onNext={jest.fn()} debounceMs={0} />);
    await type('admin_x');
    await waitFor(() => expect(screen.getByTestId('username-status')).toHaveTextContent(line));
    expect(mockRpc).toHaveBeenCalledWith('check_username', { p: 'admin_x' });
    expect(screen.getByTestId('username-claim')).toBeDisabled();
  });

  it('a short name is answered on the phone, without a request', async () => {
    const w = await appWorld();
    await w.render(<UsernameStep ctx={ctx} onNext={jest.fn()} debounceMs={0} />);
    await type('ab');
    expect(screen.getByTestId('username-status')).toHaveTextContent(copy.username.reasons.length);
    await type('Fox-1');
    expect(screen.getByTestId('username-status')).toHaveTextContent(copy.username.reasons.characters);
    expect(mockRpc).not.toHaveBeenCalled();
  });

  it('a free name can be claimed; the profile is read again before moving on', async () => {
    answerRpc(mockRpc, { check_username: { available: true, reason: null }, claim_username: null });
    const onNext = jest.fn();
    const w = await appWorld();
    await w.render(<UsernameStep ctx={ctx} onNext={onNext} debounceMs={0} />);
    await type('Swift_Fox');
    await waitFor(() => expect(screen.getByTestId('username-status')).toHaveTextContent(copy.username.available('swift_fox')));
    await tap('username-claim');
    await waitFor(() => expect(onNext).toHaveBeenCalledTimes(1));
    expect(mockRpc).toHaveBeenCalledWith('claim_username', { p: 'swift_fox' });
    expect(mockSession.refreshProfile).toHaveBeenCalled();
  });

  it.each([
    ["the server's re-check", new RpcError('username is taken', '23505')],
    ['another claim landing first', new RpcError('duplicate key value violates unique constraint "profiles_username_key"', '23505')],
  ])('a name taken at the last moment (%s) reads as taken, no longer free, and Claim turns off', async (_, refusal) => {
    answerRpc(mockRpc, {
      check_username: { available: true, reason: null },
      claim_username: refusal,
    });
    const onNext = jest.fn();
    const w = await appWorld();
    await w.render(<UsernameStep ctx={ctx} onNext={onNext} debounceMs={0} />);
    await type('swift_fox');
    await waitFor(() => expect(screen.getByTestId('username-claim')).toBeEnabled());
    await tap('username-claim');
    await waitFor(() => expect(screen.getByTestId('username-status')).toHaveTextContent(copy.username.reasons.taken));
    expect(screen.queryByText(copy.username.available('swift_fox'))).toBeNull();
    expect(screen.queryByTestId('username-claim-error')).toBeNull();
    expect(screen.getByTestId('username-claim')).toBeDisabled();
    expect(onNext).not.toHaveBeenCalled();
    expect(mockSession.refreshProfile).not.toHaveBeenCalled();
  });

  it('a "taken" that lands after the name was changed leaves the new name’s answer alone and says the claim failed', async () => {
    let refuse: (e: unknown) => void = () => {};
    answerRpc(mockRpc, {
      check_username: { available: true, reason: null },
      claim_username: () => new Promise((_, reject) => (refuse = reject)),
    });
    const onNext = jest.fn();
    const w = await appWorld();
    await w.render(<UsernameStep ctx={ctx} onNext={onNext} debounceMs={0} />);
    await type('swift_fox');
    await waitFor(() => expect(screen.getByTestId('username-claim')).toBeEnabled());
    await tap('username-claim');
    await waitFor(() => expect(mockRpc).toHaveBeenCalledWith('claim_username', { p: 'swift_fox' }));
    await type('other_fox');
    await waitFor(() => expect(screen.getByTestId('username-status')).toHaveTextContent(copy.username.available('other_fox')));
    await act(async () => refuse(new RpcError('username is taken', '23505')));
    expect(await screen.findByTestId('username-claim-error')).toHaveTextContent('Someone already has that username. Try another.');
    expect(screen.getByTestId('username-status')).toHaveTextContent(copy.username.available('other_fox'));
    expect(screen.getByTestId('username-claim')).toBeEnabled();
    expect(onNext).not.toHaveBeenCalled();
  });

  it('a claim refused for another reason says why, under the check', async () => {
    answerRpc(mockRpc, {
      check_username: { available: true, reason: null },
      claim_username: new RpcError('too many requests', '42501'),
    });
    const onNext = jest.fn();
    const w = await appWorld();
    await w.render(<UsernameStep ctx={ctx} onNext={onNext} debounceMs={0} />);
    await type('swift_fox');
    await waitFor(() => expect(screen.getByTestId('username-claim')).toBeEnabled());
    await tap('username-claim');
    expect(await screen.findByTestId('username-claim-error')).toHaveTextContent("That's a lot of tries. Wait a minute, then try again.");
    expect(onNext).not.toHaveBeenCalled();
    // Read out as it appears, away from the field VoiceOver is on.
    expect(spoken()).toContain("That's a lot of tries. Wait a minute, then try again.");
  });

  it('iPhone: each answer of the check is read out once as it shows, a taken name too', async () => {
    answerRpc(mockRpc, { check_username: { available: false, reason: 'taken' } });
    const w = await appWorld();
    await w.render(<UsernameStep ctx={ctx} onNext={jest.fn()} debounceMs={0} />);
    await type('ab');
    expect(spoken()).toEqual([copy.username.reasons.length]);
    await type('swift_fox');
    await waitFor(() => expect(screen.getByTestId('username-status')).toHaveTextContent(copy.username.reasons.taken));
    expect(spoken().filter((line) => line === copy.username.reasons.taken)).toHaveLength(1);
    expect(spoken().at(-1)).toBe(copy.username.reasons.taken);
  });

  it('Android: the check’s answers are left to the status line’s live region, and a failed claim is read out', async () => {
    const os = jest.replaceProperty(Platform, 'OS', 'android');
    try {
      answerRpc(mockRpc, {
        check_username: { available: true, reason: null },
        claim_username: new RpcError('too many requests', '42501'),
      });
      const w = await appWorld();
      await w.render(<UsernameStep ctx={{ ...ctx, platform: 'android' }} onNext={jest.fn()} debounceMs={0} />);
      await type('swift_fox');
      await waitFor(() => expect(screen.getByTestId('username-claim')).toBeEnabled());
      expect(screen.getByTestId('username-status').parent?.props.accessibilityLiveRegion).toBe('polite');
      expect(spokenAndroid()).toEqual([]);
      await tap('username-claim');
      expect(await screen.findByTestId('username-claim-error')).toHaveTextContent("That's a lot of tries. Wait a minute, then try again.");
      expect(spokenAndroid()).toEqual(["That's a lot of tries. Wait a minute, then try again."]);
      expect(spoken()).toEqual([]);
    } finally {
      os.restore();
    }
  });

  it('only the latest name’s answer is shown', async () => {
    let release: (v: unknown) => void = () => {};
    mockRpc.mockImplementation((_fn: string, args: { p: string }) =>
      args.p === 'slow_one' ? new Promise((r) => (release = r)) : Promise.resolve({ available: true, reason: null })
    );
    const w = await appWorld();
    await w.render(<UsernameStep ctx={ctx} onNext={jest.fn()} debounceMs={0} />);
    await type('slow_one');
    await waitFor(() => expect(mockRpc).toHaveBeenCalledTimes(1));
    await type('fast_one');
    await waitFor(() => expect(screen.getByTestId('username-status')).toHaveTextContent(copy.username.available('fast_one')));
    await act(async () => release({ available: false, reason: 'taken' }));
    expect(screen.getByTestId('username-status')).toHaveTextContent(copy.username.available('fast_one'));
  });
});

describe('how it works', () => {
  it.each(['ios', 'android'] as const)('%s: one screen of four lines worded for how drives start there', async (platform) => {
    const onNext = jest.fn();
    const w = await appWorld();
    await w.render(<HowStep ctx={{ ...ctx, platform }} onNext={onNext} />);
    expect(await screen.findByText(copy.how.body[platform])).toBeOnTheScreen();
    for (const row of copy.how.rows[platform]) expect(await screen.findByLabelText(`${row.title}. ${row.body}`)).toBeOnTheScreen();
    expect(screen.getByText('Sounds good')).toBeOnTheScreen();
    await tap('how-continue');
    expect(onNext).toHaveBeenCalled();
  });
});

describe('DashPal (optional, last)', () => {
  const secrets = () => {
    const store = new Map<string, string>();
    return createDashpalSecrets(() => ({
      getItemAsync: async (k: string) => store.get(k) ?? null,
      setItemAsync: async (k: string, v: string) => void store.set(k, v),
      deleteItemAsync: async (k: string) => void store.delete(k),
    }));
  };
  const render = async (onNext: () => Promise<boolean>) => {
    const w = await appWorld();
    await w.render(
      <DashcamStep ctx={{ ...ctx, hasUsername: true }} onNext={onNext} deps={{ adapter: fakeAdapter() }} secrets={secrets()} />
    );
  };

  it('Not now leaves once, even pressed twice while finishing runs', async () => {
    let release: (left: boolean) => void = () => {};
    const onNext = jest.fn(() => new Promise<boolean>((r) => (release = r)));
    await render(onNext);
    await tap('dashcam-not-now');
    await tap('dashcam-not-now');
    expect(onNext).toHaveBeenCalledTimes(1);
    await act(async () => release(true));
  });

  it('a failed finish keeps the step, and Not now tries again', async () => {
    const onNext = jest.fn<Promise<boolean>, []>().mockResolvedValueOnce(false).mockResolvedValueOnce(true);
    await render(onNext);
    await tap('dashcam-not-now');
    await waitFor(() => expect(onNext).toHaveBeenCalledTimes(1));
    await tap('dashcam-not-now');
    await waitFor(() => expect(onNext).toHaveBeenCalledTimes(2));
  });
});

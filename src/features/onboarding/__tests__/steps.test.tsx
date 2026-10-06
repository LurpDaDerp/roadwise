/**
 * The v3 steps WP9 builds: username (live check with a friendly reason, then claim), license
 * (kept on the phone so a restart resumes with it), how it works, and the optional clan code that
 * finishes onboarding either way.
 */
import { act, fireEvent, screen, waitFor } from '@testing-library/react-native';

import { RpcError } from '@/data/server/rpc';
import { answerRpc, appWorld, clearQueryClients, tap } from '@/features/permissions/__fixtures__/harness';

import { onboardingCopy } from '../copy';
import type { FlowContext } from '../flow';
import { ONBOARDING_LICENSE_KEY, readLicense } from '../state';
import { ClanStep, normaliseCode } from '../steps/ClanStep';
import { HowStep } from '../steps/HowStep';
import { LicenseStep } from '../steps/LicenseStep';
import { localCheck, normaliseUsername, UsernameStep } from '../steps/UsernameStep';

const mockRpc = jest.fn();
jest.mock('@/data/server/rpc', () => {
  const actual = jest.requireActual('@/data/server/rpc');
  return { ...actual, callRpc: (fn: string, args?: unknown) => mockRpc(fn, args) };
});
jest.mock('@/data/supabase/client', () => ({ supabase: {} }));
const mockSession = {
  session: { user: { id: 'u1' } },
  profile: { username: null as string | null, license_stage: null as string | null },
  refreshProfile: jest.fn(async () => {}),
};
jest.mock('@/data/supabase/session', () => ({ useSession: () => mockSession }));
const mockRouter = { replace: jest.fn(), push: jest.fn(), back: jest.fn(), canGoBack: () => false };
jest.mock('expo-router', () => ({ useRouter: () => mockRouter }));
const mockFinish = jest.fn(async (_deps: unknown, _stage: string) => {});
jest.mock('../finish', () => ({ finishOnboarding: (deps: unknown, stage: string) => mockFinish(deps, stage) }));

const ctx: FlowContext = { platform: 'ios', hasUsername: false };
const copy = onboardingCopy;

beforeEach(() => {
  mockRpc.mockReset();
  mockFinish.mockClear();
  mockRouter.replace.mockClear();
  mockSession.refreshProfile.mockClear();
  mockSession.profile = { username: null, license_stage: null };
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

  it('a name taken at the last moment says so and stays put', async () => {
    answerRpc(mockRpc, {
      check_username: { available: true, reason: null },
      claim_username: new RpcError('username is taken', '23505'),
    });
    const onNext = jest.fn();
    const w = await appWorld();
    await w.render(<UsernameStep ctx={ctx} onNext={onNext} debounceMs={0} />);
    await type('swift_fox');
    await waitFor(() => expect(screen.getByTestId('username-claim')).toBeEnabled());
    await tap('username-claim');
    expect(await screen.findByTestId('username-claim-error')).toHaveTextContent('Someone already has that username. Try another.');
    expect(onNext).not.toHaveBeenCalled();
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

describe('license', () => {
  it('Continue waits for a choice, and the choice is kept for the last step', async () => {
    const onNext = jest.fn();
    const w = await appWorld();
    await w.render(<LicenseStep ctx={ctx} onNext={onNext} />);
    expect(await screen.findByTestId('license-continue')).toBeDisabled();
    await tap('license-intermediate');
    await tap('license-continue');
    await waitFor(() => expect(onNext).toHaveBeenCalled());
    expect(await readLicense(w.settings)).toBe('intermediate');
  });

  it('after a restart the saved choice is still picked', async () => {
    const w = await appWorld({ settings: { [ONBOARDING_LICENSE_KEY]: 'full' } });
    await w.render(<LicenseStep ctx={ctx} onNext={jest.fn()} />);
    await waitFor(() => expect(screen.getByTestId('license-full').props.accessibilityState.checked).toBe(true));
    expect(screen.getByTestId('license-continue')).toBeEnabled();
  });
});

describe('how it works', () => {
  it('is one screen: miles earn, events cost, streaks multiply', async () => {
    const onNext = jest.fn();
    const w = await appWorld();
    await w.render(<HowStep ctx={ctx} onNext={onNext} />);
    for (const row of copy.how.rows) expect(await screen.findByLabelText(`${row.title}. ${row.body}`)).toBeOnTheScreen();
    await tap('how-continue');
    expect(onNext).toHaveBeenCalled();
  });
});

describe('clan (optional, last)', () => {
  it('normalises a typed code to the invite alphabet', () => {
    expect(normaliseCode('abcd-2345')).toBe('ABCD2345');
    expect(normaliseCode('O0I1abcdefgh')).toBe('ABCDEFGH');
  });

  it('Skip finishes with the saved license stage', async () => {
    const w = await appWorld({ settings: { [ONBOARDING_LICENSE_KEY]: 'permit' } });
    await w.render(<ClanStep ctx={{ ...ctx, hasUsername: true }} onNext={jest.fn()} />);
    await tap('clan-skip');
    await waitFor(() => expect(mockFinish).toHaveBeenCalledTimes(1));
    expect(mockFinish.mock.calls[0]?.[1]).toBe('permit');
    expect(mockRpc).not.toHaveBeenCalled();
  });

  it('a code is previewed, then joined, then onboarding finishes', async () => {
    answerRpc(mockRpc, {
      preview_clan: { name: 'Night Owls', banner: 'navy', member_count: 12, full: false },
      join_clan: { id: 'c1', name: 'Night Owls' },
    });
    const w = await appWorld({ settings: { [ONBOARDING_LICENSE_KEY]: 'full' } });
    await w.render(<ClanStep ctx={{ ...ctx, hasUsername: true }} onNext={jest.fn()} />);
    expect(await screen.findByTestId('clan-find')).toBeDisabled();
    await act(async () => {
      fireEvent.changeText(screen.getByTestId('clan-code'), 'abcd2345');
    });
    await tap('clan-find');
    expect(mockRpc).toHaveBeenCalledWith('preview_clan', { p_code: 'ABCD2345' });
    expect(await screen.findByText(copy.clan.members(12))).toBeOnTheScreen();
    await tap('clan-join');
    await waitFor(() => expect(mockFinish).toHaveBeenCalledTimes(1));
    expect(mockRpc).toHaveBeenCalledWith('join_clan', { p_code: 'ABCD2345' });
  });

  it('a full clan can be seen but not joined; a wrong code says so', async () => {
    answerRpc(mockRpc, { preview_clan: { name: 'Packed', banner: 'gold', member_count: 30, full: true } });
    const w = await appWorld({ settings: { [ONBOARDING_LICENSE_KEY]: 'full' } });
    await w.render(<ClanStep ctx={{ ...ctx, hasUsername: true }} onNext={jest.fn()} />);
    await act(async () => {
      fireEvent.changeText(await screen.findByTestId('clan-code'), 'ABCD2345');
    });
    await tap('clan-find');
    expect(await screen.findByTestId('clan-full')).toBeOnTheScreen();
    expect(screen.queryByTestId('clan-join')).toBeNull();

    answerRpc(mockRpc, { preview_clan: new RpcError('clan not found', 'P0002') });
    await act(async () => {
      fireEvent.changeText(screen.getByTestId('clan-code'), 'ZZZZ2345');
    });
    await tap('clan-find');
    expect(await screen.findByTestId('clan-error')).toHaveTextContent('No clan has that code. Check it and try again.');
  });

  it('with no license stage on record it goes back to that step instead of finishing', async () => {
    const w = await appWorld();
    await w.render(<ClanStep ctx={{ ...ctx, hasUsername: true }} onNext={jest.fn()} />);
    await tap('clan-skip');
    await waitFor(() => expect(mockRouter.replace).toHaveBeenCalledWith('/(onboarding)/license'));
    expect(mockFinish).not.toHaveBeenCalled();
  });
});

import { act, fireEvent, render, screen, waitFor } from '@testing-library/react-native';
import { Share } from 'react-native';

import { createSettingsRepo } from '@/data/db/settings';
import { createTestDb } from '@/data/queries/__fixtures__/harness';
import { BANNED_COPY } from '@/notifications/catalog';
import { ThemeProvider } from '@/ui/theme';

import {
  createGuardianInvite,
  GuardianInviteError,
  readGuardianLink,
  type GuardianInviteFailure,
} from '../api';
import { guardianShareMessage, onboardingCopy } from '../copy';
import { stepsFor, type FlowContext } from '../flow';
import { STEP_REGISTRY } from '../stepRegistry';
import { OnboardingStepper, resetSessionPlan } from '../Stepper';
import { GuardianStep } from '../steps/GuardianStep';

const copy = onboardingCopy.guardian;

type RpcReply = { data: unknown; error: unknown };
const mockRpc = jest.fn(async (_fn: string, _args?: unknown): Promise<RpcReply> => ({
  data: null,
  error: null,
}));
jest.mock('@/data/supabase/client', () => ({
  supabase: { rpc: (fn: string, args?: unknown) => mockRpc(fn, args) },
}));
jest.mock('@/data/supabase/session', () => ({
  useSession: () => ({ session: null, profile: null, refreshProfile: async () => {} }),
}));

const mockRouter = { replace: jest.fn(), push: jest.fn(), back: jest.fn() };
jest.mock('expo-router', () => {
  const { Text: MockText } = jest.requireActual<typeof import('react-native')>('react-native');
  const { useEffect } = jest.requireActual<typeof import('react')>('react');
  return {
    useFocusEffect: (effect: () => void | (() => void)) => useEffect(effect, [effect]),
    useRouter: () => mockRouter,
    Redirect: ({ href }: { href: string }) => <MockText testID="redirect">{href}</MockText>,
  };
});

/** Noon UTC, so the printed day is the same in every zone the suite could run in. */
const EXPIRES = '2026-09-29T12:00:00+00:00';
const EXPIRES_WORDS = 'September 29';

function teen(over: Partial<FlowContext> = {}): FlowContext {
  return {
    platform: 'ios',
    ageBand: '13_17',
    drivingStage: 'permit',
    termsCurrent: true,
    termsPublished: true,
    minorConsentMode: 'guardian_link_optional',
    features: { autoDetect: true, guardianInvites: true },
    ...over,
  };
}

/** Route each RPC by name; anything not given answers as an unexpected call would. */
function serve(replies: { invite?: RpcReply | RpcReply[]; link?: RpcReply | RpcReply[] }) {
  const queues = {
    create_guardian_invite: ([] as RpcReply[]).concat(replies.invite ?? []),
    guardian_link_state: ([] as RpcReply[]).concat(replies.link ?? []),
  };
  mockRpc.mockImplementation(async (fn: string) => {
    const q = queues[fn as keyof typeof queues];
    if (!q || q.length === 0) return { data: null, error: { code: 'XX000', message: `unexpected ${fn}` } };
    return q.length > 1 ? q.shift()! : q[0]!;
  });
}

const link = (status: string, expires_at: string | null = null): RpcReply => ({
  data: { status, expires_at },
  error: null,
});
const invite = (code = 'K7QX2M', expires_at = EXPIRES): RpcReply => ({
  data: { code, expires_at },
  error: null,
});
const pgError = (code: string, message: string): RpcReply => ({ data: null, error: { code, message } });

const onNext = jest.fn();
let shareSpy: jest.SpyInstance;

beforeEach(() => {
  onNext.mockClear();
  mockRpc.mockReset();
  mockRouter.replace.mockClear();
  shareSpy = jest.spyOn(Share, 'share').mockResolvedValue({ action: Share.sharedAction });
});

afterEach(() => {
  shareSpy.mockRestore();
});

function renderStep(c: FlowContext = teen()) {
  return render(
    <ThemeProvider>
      <GuardianStep ctx={c} onNext={onNext} />
    </ThemeProvider>
  );
}

// ---------------------------------------------------------------------------------------------

describe('createGuardianInvite', () => {
  it('returns the code and its expiry', async () => {
    serve({ invite: invite('K7QX2M') });
    await expect(createGuardianInvite()).resolves.toEqual({ code: 'K7QX2M', expiresAt: EXPIRES });
    expect(mockRpc).toHaveBeenCalledWith('create_guardian_invite', undefined);
  });

  it.each<[string, RpcReply, GuardianInviteFailure]>([
    ['the 24 h limit', pgError('42501', 'invite limit reached'), 'rate-limited'],
    ['a linked guardian', pgError('22023', 'guardian already linked'), 'already-linked'],
    ['the flag off', pgError('42501', 'guardian invites are not available yet'), 'not-available'],
    ['an adult', pgError('42501', 'guardian invites are for drivers under 18'), 'not-available'],
  ])('maps %s to its reason', async (_name, reply, reason) => {
    serve({ invite: reply });
    const failure = await createGuardianInvite().catch((e: unknown) => e);
    expect(failure).toBeInstanceOf(GuardianInviteError);
    expect((failure as GuardianInviteError).reason).toBe(reason);
  });

  it('rejects anything else as it came, never as a mapped reason', async () => {
    serve({ invite: pgError('XX000', 'boom') });
    const failure = await createGuardianInvite().catch((e: unknown) => e);
    expect(failure).not.toBeInstanceOf(GuardianInviteError);
    // A message that merely contains a known one is not that error.
    serve({ invite: pgError('42501', 'invite limit reached, or not') });
    expect(await createGuardianInvite().catch((e: unknown) => e)).not.toBeInstanceOf(
      GuardianInviteError
    );
  });

  it('rejects a reply without a well-formed code', async () => {
    for (const bad of [invite('abc123'), invite('K7QX2'), invite('K7QX2O'), { data: null, error: null }]) {
      serve({ invite: bad });
      await expect(createGuardianInvite()).rejects.toThrow();
    }
  });
});

describe('readGuardianLink', () => {
  it.each(['none', 'pending', 'linked', 'declined', 'expired'])('reads %s', async (status) => {
    serve({ link: link(status, status === 'pending' ? EXPIRES : null) });
    await expect(readGuardianLink()).resolves.toEqual({
      status,
      expiresAt: status === 'pending' ? EXPIRES : null,
    });
  });

  it('rejects an error and a status it does not know', async () => {
    serve({ link: pgError('42501', 'guardian_link_state requires an authenticated user') });
    await expect(readGuardianLink()).rejects.toBeDefined();
    serve({ link: link('accepted') });
    await expect(readGuardianLink()).rejects.toThrow();
  });
});

// ---------------------------------------------------------------------------------------------

describe('the guardian step is dark while the flag is off (rev1: I6)', () => {
  it('the registry renders the real step for `guardian`', () => {
    expect(STEP_REGISTRY.guardian).toBe(GuardianStep);
  });

  it.each(['guardian_link_optional', 'guardian_consent_required'] as const)(
    'no flow lists it with the flag off (%s)',
    (mode) => {
      const off = teen({ minorConsentMode: mode, features: { autoDetect: true, guardianInvites: false } });
      expect(stepsFor(off)).not.toContain('guardian');
      expect(stepsFor(teen({ minorConsentMode: mode }))).toContain('guardian');
    }
  );

  it('a link straight to the step moves on without rendering it or calling the server', async () => {
    const settings = createSettingsRepo(await createTestDb());
    resetSessionPlan();
    await render(
      <ThemeProvider>
        <OnboardingStepper
          step="guardian"
          ctx={teen({ features: { autoDetect: true, guardianInvites: false } })}
          settings={settings}
        />
      </ThemeProvider>
    );
    expect(screen.getByTestId('redirect')).toHaveTextContent('/(onboarding)/location');
    expect(screen.queryByText(copy.title)).toBeNull();
    await act(async () => {});
    expect(mockRpc).not.toHaveBeenCalled();
  });

  it('with the flag on, the stepper renders the step', async () => {
    serve({ link: link('none') });
    const settings = createSettingsRepo(await createTestDb());
    resetSessionPlan();
    await render(
      <ThemeProvider>
        <OnboardingStepper step="guardian" ctx={teen()} settings={settings} />
      </ThemeProvider>
    );
    expect(await screen.findByText(copy.title)).toBeOnTheScreen();
    expect(screen.queryByTestId('redirect')).toBeNull();
  });
});

// ---------------------------------------------------------------------------------------------

describe('GuardianStep', () => {
  it('explains only what this build can back', async () => {
    serve({ link: link('none') });
    await renderStep();
    expect(screen.getByText(copy.title)).toBeOnTheScreen();
    expect(
      screen.getByText(
        'A guardian sees only what you choose to share. Nothing is shared until you set it up.'
      )
    ).toBeOnTheScreen();
    await waitFor(() => expect(mockRpc).toHaveBeenCalledWith('guardian_link_state', undefined));
  });

  it('Send invite creates one invite and shares a message with the code and no link', async () => {
    serve({ link: link('none'), invite: invite('K7QX2M') });
    await renderStep();
    await act(async () => {});
    await fireEvent.press(screen.getByRole('button', { name: copy.send }));
    await waitFor(() => expect(shareSpy).toHaveBeenCalledTimes(1));
    const [content] = shareSpy.mock.calls[0] as [{ message: string; url?: string }];
    expect(content.message).toContain('K7QX2M');
    expect(content.message).toContain(EXPIRES_WORDS);
    expect(content.url).toBeUndefined();
    expect(content.message).not.toMatch(/https?:|www\.|:\/\/|\/join|roadwise\.\w/i);
    expect(content.message).toBe(guardianShareMessage('K7QX2M', EXPIRES_WORDS));
    // The code is printed on the screen too, and the status is the server's pending.
    expect(await screen.findByText('K7QX2M')).toBeOnTheScreen();
    expect(screen.getByText(copy.status.pending(EXPIRES_WORDS))).toBeOnTheScreen();
    expect(mockRpc.mock.calls.filter(([fn]) => fn === 'create_guardian_invite')).toHaveLength(1);
  });

  it('sending again reshares the same code without a second invite (which would revoke it)', async () => {
    shareSpy.mockResolvedValue({ action: Share.dismissedAction });
    serve({ link: link('none'), invite: invite('K7QX2M') });
    await renderStep();
    await act(async () => {});
    await fireEvent.press(screen.getByRole('button', { name: copy.send }));
    await screen.findByText('K7QX2M');
    await fireEvent.press(screen.getByRole('button', { name: copy.send }));
    await waitFor(() => expect(shareSpy).toHaveBeenCalledTimes(2));
    expect(mockRpc.mock.calls.filter(([fn]) => fn === 'create_guardian_invite')).toHaveLength(1);
  });

  it('a share sheet that fails leaves the code on screen and says so', async () => {
    shareSpy.mockRejectedValue(new Error('no activity'));
    serve({ link: link('none'), invite: invite('K7QX2M') });
    await renderStep();
    await act(async () => {});
    await fireEvent.press(screen.getByRole('button', { name: copy.send }));
    expect(await screen.findByText(copy.errors.shareFailed)).toBeOnTheScreen();
    expect(screen.getByText('K7QX2M')).toBeOnTheScreen();
  });

  describe('status line', () => {
    it.each<[string, RpcReply, string | null]>([
      ['none', link('none'), null],
      ['pending', link('pending', EXPIRES), copy.status.pending(EXPIRES_WORDS)],
      ['linked', link('linked'), copy.status.linked],
      ['declined', link('declined'), copy.status.declined],
      ['expired', link('expired'), copy.status.expired],
    ])('%s', async (status, reply, line) => {
      serve({ link: reply });
      await renderStep();
      await act(async () => {});
      for (const other of [
        copy.status.pending(EXPIRES_WORDS),
        copy.status.linked,
        copy.status.declined,
        copy.status.expired,
        copy.status.loadFailed,
      ]) {
        if (other === line) expect(screen.getByText(other)).toBeOnTheScreen();
        else expect(screen.queryByText(other)).toBeNull();
      }
      if (status === 'pending' || status === 'declined' || status === 'expired') {
        // A new invite replaces the old code, and the button says so.
        expect(screen.getByRole('button', { name: copy.sendNew })).toBeOnTheScreen();
      }
    });

    it('a failed read says so and still lets the teen send one', async () => {
      serve({ link: pgError('XX000', 'offline'), invite: invite() });
      await renderStep();
      expect(await screen.findByText(copy.status.loadFailed)).toBeOnTheScreen();
      await fireEvent.press(screen.getByRole('button', { name: copy.send }));
      await waitFor(() => expect(shareSpy).toHaveBeenCalled());
    });

    it('linked: no invite to send, Continue goes on', async () => {
      serve({ link: link('linked') });
      await renderStep();
      await screen.findByText(copy.status.linked);
      expect(screen.queryByRole('button', { name: copy.send })).toBeNull();
      expect(screen.queryByRole('button', { name: copy.later })).toBeNull();
      await fireEvent.press(screen.getByRole('button', { name: copy.continue }));
      expect(onNext).toHaveBeenCalledTimes(1);
    });
  });

  describe('Later per consent mode', () => {
    it('optional: "I\'ll do this later" moves on and creates nothing', async () => {
      serve({ link: link('none') });
      await renderStep(teen({ minorConsentMode: 'guardian_link_optional' }));
      await act(async () => {});
      await fireEvent.press(screen.getByRole('button', { name: copy.later }));
      expect(onNext).toHaveBeenCalledTimes(1);
      expect(shareSpy).not.toHaveBeenCalled();
      expect(mockRpc.mock.calls.filter(([fn]) => fn === 'create_guardian_invite')).toHaveLength(0);
    });

    it('optional: once an invite is out, the way on is Continue', async () => {
      serve({ link: link('none'), invite: invite() });
      await renderStep(teen({ minorConsentMode: 'guardian_link_optional' }));
      await act(async () => {});
      await fireEvent.press(screen.getByRole('button', { name: copy.send }));
      await screen.findByText(copy.status.pending(EXPIRES_WORDS));
      expect(screen.queryByRole('button', { name: copy.later })).toBeNull();
      await fireEvent.press(screen.getByRole('button', { name: copy.continue }));
      expect(onNext).toHaveBeenCalledTimes(1);
    });

    it('required: no Later and no way on until a guardian is linked', async () => {
      serve({ link: [link('none'), link('pending', EXPIRES), link('linked')], invite: invite() });
      await renderStep(teen({ minorConsentMode: 'guardian_consent_required' }));
      await act(async () => {});
      expect(screen.queryByRole('button', { name: copy.later })).toBeNull();
      expect(screen.queryByRole('button', { name: copy.continue })).toBeNull();
      await fireEvent.press(screen.getByRole('button', { name: copy.send }));
      await screen.findByText(copy.status.pending(EXPIRES_WORDS));
      expect(screen.queryByRole('button', { name: copy.later })).toBeNull();
      expect(screen.queryByRole('button', { name: copy.continue })).toBeNull();
      // Checking again reads the server; still pending, then linked.
      await fireEvent.press(screen.getByRole('button', { name: copy.checkAgain }));
      await act(async () => {});
      await fireEvent.press(screen.getByRole('button', { name: copy.checkAgain }));
      await screen.findByText(copy.status.linked);
      await fireEvent.press(screen.getByRole('button', { name: copy.continue }));
      expect(onNext).toHaveBeenCalledTimes(1);
    });
  });

  describe('invite errors', () => {
    it.each<[string, RpcReply, string]>([
      ['rate-limited', pgError('42501', 'invite limit reached'), copy.errors.rateLimited],
      ['not-available', pgError('42501', 'guardian invites are not available yet'), copy.errors.notAvailable],
      ['anything else', pgError('XX000', 'boom'), copy.errors.failed],
    ])('%s is said plainly and nothing is shared', async (_name, reply, line) => {
      serve({ link: link('none'), invite: reply });
      await renderStep();
      await act(async () => {});
      await fireEvent.press(screen.getByRole('button', { name: copy.send }));
      expect(await screen.findByText(line)).toBeOnTheScreen();
      expect(shareSpy).not.toHaveBeenCalled();
      expect(onNext).not.toHaveBeenCalled();
    });

    it('already-linked re-reads the link and offers Continue', async () => {
      serve({
        link: [link('none'), link('linked')],
        invite: pgError('22023', 'guardian already linked'),
      });
      await renderStep();
      await act(async () => {});
      await fireEvent.press(screen.getByRole('button', { name: copy.send }));
      expect(await screen.findByText(copy.status.linked)).toBeOnTheScreen();
      expect(shareSpy).not.toHaveBeenCalled();
      expect(screen.getByRole('button', { name: copy.continue })).toBeOnTheScreen();
    });
  });
});

describe('guardian copy', () => {
  const strings = (): string[] => {
    const out: string[] = [];
    const walk = (v: unknown) => {
      if (typeof v === 'string') out.push(v);
      else if (typeof v === 'function') out.push(String((v as (d: string) => string)('March 4')));
      else if (v && typeof v === 'object') Object.values(v).forEach(walk);
    };
    walk(copy);
    out.push(guardianShareMessage('K7QX2M', 'March 4'));
    return out;
  };

  it('promises nothing a guardian can see (M6 and G7 do not exist yet)', () => {
    for (const s of strings()) {
      expect(s).not.toMatch(/can see your|see exactly|sees? what you see|your location|your drives|your score|alerts? (them|your)/i);
    }
  });

  it('holds to the app-wide banned copy', () => {
    for (const s of strings()) for (const banned of BANNED_COPY) expect(s).not.toMatch(banned);
  });

  it('the explainer is the briefed text, verbatim', () => {
    expect(copy.explainer).toBe(
      'A guardian sees only what you choose to share. Nothing is shared until you set it up.'
    );
  });
});

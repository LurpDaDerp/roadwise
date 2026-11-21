import {
  CODE_LENGTH,
  EMAIL_SHAPE,
  PASSWORD_MAX,
  PASSWORD_MIN,
  passwordProblem,
  registerWithPassword,
  requestPasswordReset,
  RESEND_COOLDOWN_S,
  resendEmailCode,
  signInWithPassword,
  startEmailConfirmation,
} from '@/features/auth/emailPassword';

const mockSignUp = jest.fn();
const mockSignInWithPassword = jest.fn();
const mockResend = jest.fn();
const mockResetPassword = jest.fn();
const mockSetSession = jest.fn();
// The aside client the code signs in on, out of the app's sight, and the session it holds.
type Held = { access_token: string; refresh_token: string; expires_at: number };
const mockAside: { held: Held | null } = { held: null };
const mockVerifyOtp = jest.fn();
const mockUpdateUser = jest.fn();
const mockAsideSignOut = jest.fn();
const mockAdminSignOut = jest.fn();
const mockGetSession = jest.fn();
const mockRefreshSession = jest.fn();
const mockCreateAside = jest.fn();

jest.mock('@/data/supabase/client', () => ({
  supabase: {
    auth: {
      signUp: (...args: unknown[]) => mockSignUp(...args),
      signInWithPassword: (...args: unknown[]) => mockSignInWithPassword(...args),
      resend: (...args: unknown[]) => mockResend(...args),
      resetPasswordForEmail: (...args: unknown[]) => mockResetPassword(...args),
      setSession: (...args: unknown[]) => mockSetSession(...args),
    },
  },
}));
jest.mock('@/features/auth/asideAuth', () => ({
  createAsideAuth: () => mockCreateAside(),
}));

/** What supabase-js answers when the request never reached Auth (no connection). */
const OFFLINE = { name: 'AuthRetryableFetchError', status: 0, message: 'Network request failed' };
const USER = { id: 'u1' };
/** A session whose access token has `seconds` of life left. */
const sessionFor = (n: number, seconds = 3600): Held => ({
  access_token: `access-${n}`,
  refresh_token: `refresh-${n}`,
  expires_at: Math.floor(Date.now() / 1000) + seconds,
});

beforeEach(() => {
  mockSignUp.mockReset();
  mockSignInWithPassword.mockReset();
  mockResend.mockReset();
  mockResetPassword.mockReset();
  mockSetSession.mockReset().mockResolvedValue({ data: { session: {} }, error: null });
  mockAside.held = null;
  mockVerifyOtp.mockReset().mockImplementation(async () => {
    mockAside.held = sessionFor(1);
    return { data: { session: mockAside.held, user: USER }, error: null };
  });
  mockUpdateUser.mockReset().mockResolvedValue({ data: { user: USER }, error: null });
  mockAsideSignOut.mockReset().mockResolvedValue({ error: null });
  mockAdminSignOut.mockReset().mockResolvedValue({ data: null, error: null });
  mockGetSession.mockReset().mockImplementation(async () => ({ data: { session: mockAside.held }, error: null }));
  mockRefreshSession.mockReset().mockImplementation(async () => {
    mockAside.held = sessionFor(2);
    return { data: { session: mockAside.held, user: USER }, error: null };
  });
  mockCreateAside.mockReset().mockReturnValue({
    verifyOtp: (...args: unknown[]) => mockVerifyOtp(...args),
    updateUser: (...args: unknown[]) => mockUpdateUser(...args),
    signOut: (...args: unknown[]) => mockAsideSignOut(...args),
    getSession: (...args: unknown[]) => mockGetSession(...args),
    refreshSession: (...args: unknown[]) => mockRefreshSession(...args),
    admin: { signOut: (...args: unknown[]) => mockAdminSignOut(...args) },
  });
});

test('passwords need at least 8 characters, as the server is set to require', () => {
  expect(PASSWORD_MIN).toBe(8);
  expect(PASSWORD_MAX).toBe(72);
});

describe('passwordProblem: the server\'s rules (8 code points to 72 bytes, a letter and a digit), then guessability', () => {
  test.each([
    ['', 'short'],
    ['abc1', 'short'],
    ['abcdef1', 'short'],
    // 8 UTF-16 units but 4 code points: Auth counts code points.
    ['😀😀a1', 'short'],
    ['abcdefgh', 'letters_digits'],
    ['12345678', 'letters_digits'],
    ['!!!!!!!!1', 'letters_digits'],
    ['éééééééé1', 'letters_digits'],
    ['correct horse battery 9', null],
    ['Tr4ffic-Light', null],
    ['blue7ocean', null],
    ['zebra crossing 9', null],
    ['Kx9mPq2w', null],
    // A passphrase in another alphabet with one a-to-z letter: its own letters count as letters.
    ['надёжный пароль 7z', null],
    ['b1' + 'x'.repeat(70), null],
    ['b1' + 'x'.repeat(71), 'long'],
    // 72 characters but more than 72 bytes: Auth counts bytes.
    ['b1' + 'é'.repeat(36), 'long'],
  ])('%j is %s', (password, expected) => {
    expect(passwordProblem(password)).toBe(expected);
  });

  test.each([
    'password1',
    'Password123!',
    'P@ssw0rd1',
    'my password 1',
    'Football2026!',
    'summer2026',
    'iloveyou2',
    'welcome1',
    'roadwise9',
    'qwerty123',
    'Qwertyuiop1',
    '1qaz2wsx',
    'abc12345',
    'abcdefg1',
    '1234567A',
    'a1234567',
    'ab123456',
    'aaaa1111',
  ])('%j is too easy to guess', (password) => {
    expect(passwordProblem(password)).toBe('common');
  });

  test("a password holding the email's name is too easy to guess; a short name doesn't count", () => {
    expect(passwordProblem('ava.smith99', 'Ava.Smith@example.com')).toBe('common');
    expect(passwordProblem('xxAvasmith2024', 'ava.smith@example.com')).toBe('common');
    expect(passwordProblem('blue7ocean', 'ava.smith@example.com')).toBeNull();
    expect(passwordProblem('blue7ocean ava', 'ava@example.com')).toBeNull();
  });
});

test('an address must look like one before it is sent', () => {
  expect(EMAIL_SHAPE.test('ava@example.com')).toBe(true);
  for (const bad of ['ava', 'ava@', '@example.com', 'ava@example', 'a va@example.com']) expect(EMAIL_SHAPE.test(bad)).toBe(false);
});

test("the code is 8 digits and Resend waits a minute, as the server's otp_length and max_frequency say", () => {
  expect(CODE_LENGTH).toBe(8);
  expect(RESEND_COOLDOWN_S).toBe(60);
});

describe('registerWithPassword', () => {
  test('sends the address trimmed and lower-cased, and the password untouched', async () => {
    mockSignUp.mockResolvedValue({ data: { session: { access_token: 'x' } }, error: null });
    expect(await registerWithPassword('  Ava@Example.COM ', ' Pass Word 1 ')).toBe('ok');
    expect(mockSignUp).toHaveBeenCalledWith({ email: 'ava@example.com', password: ' Pass Word 1 ' });
  });

  test('an answer with no session is an address to confirm with the mailed code', async () => {
    mockSignUp.mockResolvedValue({ data: { session: null }, error: null });
    expect(await registerWithPassword('ava@example.com', 'correct horse')).toBe('confirm_email');
    mockSignUp.mockResolvedValue({
      data: { session: null, user: { id: 'u1', identities: [{ provider: 'email' }] } },
      error: null,
    });
    expect(await registerWithPassword('ava@example.com', 'correct horse')).toBe('confirm_email');
  });

  test('a stand-in user with no identities is an address that already has a confirmed account', async () => {
    mockSignUp.mockResolvedValue({ data: { session: null, user: { id: 'fake', identities: [] } }, error: null });
    expect(await registerWithPassword('ava@example.com', 'correct horse')).toBe('exists');
  });

  test.each([
    [{ status: 422, code: 'user_already_exists' }, 'exists'],
    [{ status: 422, code: 'email_exists' }, 'exists'],
    [{ status: 422, code: 'weak_password' }, 'weak_password'],
    [{ status: 429, code: 'over_request_rate_limit' }, 'rate_limited'],
    [{ status: 429, code: 'over_email_send_rate_limit' }, 'rate_limited'],
    [{ status: 429, code: 'over_email_send_rate_limit', message: 'Email rate limit exceeded' }, 'rate_limited'],
    // A sign-up to this address within the minute mailed a code that still works.
    [{ status: 429, code: 'over_email_send_rate_limit', message: 'For security purposes, you can only request this after 42 seconds.' }, 'confirm_email'],
    [{ status: 429 }, 'rate_limited'],
    [{ status: 400, code: 'email_address_invalid' }, 'invalid_email'],
    [{ status: 400, code: 'validation_failed' }, 'invalid_email'],
    [OFFLINE, 'offline'],
    [{ status: 500, code: 'unexpected_failure' }, 'error'],
    [new Error('Network request failed'), 'error'],
  ])('maps %j to %s', async (error, expected) => {
    mockSignUp.mockResolvedValue({ data: { session: null }, error });
    expect(await registerWithPassword('ava@example.com', 'correct horse')).toBe(expected);
  });

  test('a throw is an error', async () => {
    mockSignUp.mockRejectedValue(new Error('storage'));
    expect(await registerWithPassword('ava@example.com', 'correct horse 1')).toBe('error');
  });
});

describe('signInWithPassword', () => {
  test('sends the address trimmed and lower-cased', async () => {
    mockSignInWithPassword.mockResolvedValue({ error: null });
    expect(await signInWithPassword(' Ava@Example.com', 'correct horse')).toBe('ok');
    expect(mockSignInWithPassword).toHaveBeenCalledWith({ email: 'ava@example.com', password: 'correct horse' });
  });

  test.each([
    [{ status: 400, code: 'invalid_credentials' }, 'invalid'],
    [{ status: 429, code: 'over_request_rate_limit' }, 'rate_limited'],
    [{ status: 400, code: 'email_not_confirmed' }, 'unconfirmed'],
    [OFFLINE, 'offline'],
    [new Error('Network request failed'), 'error'],
  ])('maps %j to %s', async (error, expected) => {
    mockSignInWithPassword.mockResolvedValue({ error });
    expect(await signInWithPassword('ava@example.com', 'wrong')).toBe(expected);
  });

  test('a throw is an error', async () => {
    mockSignInWithPassword.mockRejectedValue(new Error('storage'));
    expect(await signInWithPassword('ava@example.com', 'wrong')).toBe('error');
  });
});

describe('startEmailConfirmation', () => {
  const handedOver = (n: number) => ({ access_token: `access-${n}`, refresh_token: `refresh-${n}` });
  const order = (fn: jest.Mock): number => fn.mock.invocationCallOrder[0] ?? Number.NaN;
  const failPassword = () =>
    mockUpdateUser.mockResolvedValue({ data: { user: null }, error: { status: 500, code: 'unexpected_failure' } });

  afterEach(() => {
    jest.useRealTimers();
  });

  test('a sign-up: the right code, then the chosen password, then no other session, then the app signs in', async () => {
    const c = startEmailConfirmation(' Ava@Example.com ', 'correct horse');
    expect(await c.verify('12345678')).toBe('ok');
    expect(mockVerifyOtp).toHaveBeenCalledWith({ email: 'ava@example.com', token: '12345678', type: 'signup' });
    expect(mockUpdateUser).toHaveBeenCalledWith({ password: 'correct horse' });
    // Through Auth's own answer to the logout, so a refusal can't pass as done.
    expect(mockAdminSignOut).toHaveBeenCalledWith('access-1', 'others');
    expect(mockSetSession).toHaveBeenCalledWith(handedOver(1));
    expect(order(mockVerifyOtp)).toBeLessThan(order(mockUpdateUser));
    expect(order(mockUpdateUser)).toBeLessThan(order(mockAdminSignOut));
    expect(order(mockAdminSignOut)).toBeLessThan(order(mockSetSession));
    // A session with an hour left needs no refresh.
    expect(mockRefreshSession).not.toHaveBeenCalled();
    expect(mockAsideSignOut).not.toHaveBeenCalled();
  });

  test('the same password refused is the usual answer: the account was already the driver’s', async () => {
    mockUpdateUser.mockResolvedValue({ data: { user: null }, error: { status: 422, code: 'same_password' } });
    expect(await startEmailConfirmation('ava@example.com', 'correct horse').verify('12345678')).toBe('ok');
    expect(mockSetSession).toHaveBeenCalledWith(handedOver(1));
  });

  test.each([
    ['refused', failPassword],
    ['offline', () => mockUpdateUser.mockResolvedValue({ data: { user: null }, error: OFFLINE })],
    ['a throw', () => mockUpdateUser.mockRejectedValue(new Error('boom'))],
    ['too many requests', () => mockUpdateUser.mockResolvedValue({ data: { user: null }, error: { status: 429, code: 'over_request_rate_limit' } })],
  ])('a password that could not be set (%s) fails closed: never signed in, and Try again finishes', async (_label, fail) => {
    fail();
    const c = startEmailConfirmation('ava@example.com', 'correct horse');
    expect(await c.verify('12345678')).toBe('unfinished');
    expect(mockSetSession).not.toHaveBeenCalled();
    expect(mockAdminSignOut).not.toHaveBeenCalled();

    mockUpdateUser.mockReset().mockResolvedValue({ data: { user: USER }, error: null });
    expect(await c.finish()).toBe('ok');
    expect(mockVerifyOtp).toHaveBeenCalledTimes(1);
    expect(mockUpdateUser).toHaveBeenCalledWith({ password: 'correct horse' });
    expect(mockSetSession).toHaveBeenCalledWith(handedOver(1));
  });

  test.each([
    ['weak', { status: 422, code: 'weak_password' }],
    ['current password asked for', { status: 400, code: 'current_password_required' }],
    ['reauthentication asked for', { status: 400, code: 'reauthentication_needed' }],
    ['session gone', { status: 403, code: 'session_not_found' }],
  ])('a password Auth refuses for good (%s) is an error, never signed in, and the session goes', async (_label, error) => {
    mockUpdateUser.mockResolvedValue({ data: { user: null }, error });
    const c = startEmailConfirmation('ava@example.com', 'correct horse');
    expect(await c.verify('12345678')).toBe('error');
    expect(mockSetSession).not.toHaveBeenCalled();
    expect(mockAdminSignOut).not.toHaveBeenCalled();
    expect(mockAsideSignOut).toHaveBeenCalledWith({ scope: 'local' });
    // Nothing is held any more: Try again has nothing to finish.
    expect(await c.finish()).toBe('error');
    expect(mockUpdateUser).toHaveBeenCalledTimes(1);
  });

  test.each([
    ['a server error', { status: 500, code: 'unexpected_failure' }],
    // The answers supabase-js's own signOut would let pass as done.
    ['401', { status: 401, code: 'bad_jwt' }],
    ['403', { status: 403, code: 'session_not_found' }],
    ['404', { status: 404, code: 'user_not_found' }],
    ['offline', OFFLINE],
  ])('other sessions not certainly signed out (%s) fail closed', async (_label, error) => {
    mockAdminSignOut.mockResolvedValue({ data: null, error });
    expect(await startEmailConfirmation('ava@example.com', 'correct horse').verify('12345678')).toBe('unfinished');
    expect(mockSetSession).not.toHaveBeenCalled();
  });

  test('a session close to running out is refreshed first, and the refreshed one is used and handed over', async () => {
    mockVerifyOtp.mockImplementation(async () => {
      mockAside.held = sessionFor(1, 120);
      return { data: { session: mockAside.held, user: USER }, error: null };
    });
    expect(await startEmailConfirmation('ava@example.com', 'correct horse').verify('12345678')).toBe('ok');
    expect(mockRefreshSession).toHaveBeenCalledTimes(1);
    expect(order(mockRefreshSession)).toBeLessThan(order(mockUpdateUser));
    expect(mockAdminSignOut).toHaveBeenCalledWith('access-2', 'others');
    expect(mockSetSession).toHaveBeenCalledWith(handedOver(2));
  });

  test.each([
    ['refused', () => mockRefreshSession.mockResolvedValue({ data: { session: null, user: null }, error: { status: 400, code: 'refresh_token_not_found' } })],
    ['offline', () => mockRefreshSession.mockResolvedValue({ data: { session: null, user: null }, error: OFFLINE })],
    ['no session held', () => mockGetSession.mockResolvedValue({ data: { session: null }, error: null })],
  ])('a session that cannot be made fresh (%s) fails closed', async (_label, fail) => {
    mockVerifyOtp.mockImplementation(async () => {
      mockAside.held = sessionFor(1, 30);
      return { data: { session: mockAside.held, user: USER }, error: null };
    });
    fail();
    expect(await startEmailConfirmation('ava@example.com', 'correct horse').verify('12345678')).toBe('unfinished');
    expect(mockUpdateUser).not.toHaveBeenCalled();
    expect(mockAdminSignOut).not.toHaveBeenCalled();
    expect(mockSetSession).not.toHaveBeenCalled();
  });

  test.each([['the password'], ['the other sessions']])(
    'Try again more than an hour later (%s failed) refreshes, then finishes with the new session',
    async (failed) => {
      jest.useFakeTimers({ now: new Date('2026-10-27T12:00:00Z') });
      if (failed === 'the other sessions') mockAdminSignOut.mockResolvedValueOnce({ data: null, error: OFFLINE });
      else failPassword();
      const c = startEmailConfirmation('ava@example.com', 'correct horse');
      expect(await c.verify('12345678')).toBe('unfinished');

      jest.setSystemTime(new Date('2026-10-27T13:30:00Z'));
      mockUpdateUser.mockReset().mockResolvedValue({ data: { user: USER }, error: null });
      expect(await c.finish()).toBe('ok');
      expect(mockRefreshSession).toHaveBeenCalledTimes(1);
      expect(mockAdminSignOut).toHaveBeenLastCalledWith('access-2', 'others');
      expect(mockSetSession).toHaveBeenCalledWith(handedOver(2));
    }
  );

  test('a handover the app could not take is unfinished, and a second code check only finishes', async () => {
    mockSetSession.mockResolvedValueOnce({ data: { session: null }, error: OFFLINE });
    const c = startEmailConfirmation('ava@example.com', 'correct horse');
    expect(await c.verify('12345678')).toBe('unfinished');
    expect(await c.verify('12345678')).toBe('ok');
    expect(mockVerifyOtp).toHaveBeenCalledTimes(1);
    expect(mockSetSession).toHaveBeenCalledTimes(2);
  });

  test('a sign-in to an unconfirmed account sets the typed password again (the server cleared it at confirmation)', async () => {
    expect(await startEmailConfirmation('ava@example.com', 'typed at sign in 1').verify('12345678')).toBe('ok');
    expect(mockUpdateUser).toHaveBeenCalledWith({ password: 'typed at sign in 1' });
    expect(mockAdminSignOut).toHaveBeenCalledWith('access-1', 'others');
    expect(mockSetSession).toHaveBeenCalledWith(handedOver(1));
  });

  test.each([
    [{ status: 403, code: 'otp_expired' }, 'wrong_code'],
    [{ status: 429, code: 'over_request_rate_limit' }, 'rate_limited'],
    [OFFLINE, 'offline'],
    [{ name: 'AuthRetryableFetchError', status: 503 }, 'error'],
    [{ status: 500, code: 'unexpected_failure' }, 'error'],
  ])('a refused code %j is %s, and nothing else happens', async (error, expected) => {
    mockVerifyOtp.mockResolvedValue({ data: { session: null, user: null }, error });
    expect(await startEmailConfirmation('ava@example.com', 'correct horse').verify('12345678')).toBe(expected);
    expect(mockUpdateUser).not.toHaveBeenCalled();
    expect(mockSetSession).not.toHaveBeenCalled();
  });

  test('an answer with no session, or a throw, is an error rather than a sign-in', async () => {
    mockVerifyOtp.mockResolvedValue({ data: { session: null, user: null }, error: null });
    expect(await startEmailConfirmation('ava@example.com', 'x').verify('12345678')).toBe('error');
    mockVerifyOtp.mockRejectedValue(new Error('boom'));
    expect(await startEmailConfirmation('ava@example.com', 'x').verify('12345678')).toBe('error');
    expect(mockSetSession).not.toHaveBeenCalled();
  });

  test('leaving after a right code that could not finish signs that session out; before one, nothing', async () => {
    const early = startEmailConfirmation('ava@example.com', 'correct horse');
    await early.abandon();
    expect(mockAsideSignOut).not.toHaveBeenCalled();
    expect(await early.verify('12345678')).toBe('error');
    expect(mockVerifyOtp).not.toHaveBeenCalled();

    mockAdminSignOut.mockResolvedValueOnce({ data: null, error: OFFLINE });
    const c = startEmailConfirmation('ava@example.com', 'correct horse');
    expect(await c.verify('12345678')).toBe('unfinished');
    await c.abandon();
    expect(mockAsideSignOut).toHaveBeenCalledWith({ scope: 'local' });
    expect(await c.finish()).toBe('error');
    expect(mockSetSession).not.toHaveBeenCalled();
  });

  test('a sign-up left unfinished tries once more to set the chosen password and sign out the rest, then signs out', async () => {
    failPassword();
    const c = startEmailConfirmation('ava@example.com', 'correct horse');
    expect(await c.verify('12345678')).toBe('unfinished');
    mockUpdateUser.mockReset().mockResolvedValue({ data: { user: USER }, error: null });
    await c.abandon();
    expect(mockUpdateUser).toHaveBeenCalledWith({ password: 'correct horse' });
    expect(mockAdminSignOut).toHaveBeenCalledWith('access-1', 'others');
    expect(order(mockUpdateUser)).toBeLessThan(order(mockAdminSignOut));
    expect(mockAsideSignOut).toHaveBeenCalledWith({ scope: 'local' });
    expect(order(mockAdminSignOut)).toBeLessThan(order(mockAsideSignOut));
    expect(mockSetSession).not.toHaveBeenCalled();
  });

  test('that last try failing (offline) still signs the session out', async () => {
    failPassword();
    const c = startEmailConfirmation('ava@example.com', 'correct horse');
    expect(await c.verify('12345678')).toBe('unfinished');
    mockUpdateUser.mockReset().mockRejectedValue(new Error('offline'));
    await c.abandon();
    expect(mockAsideSignOut).toHaveBeenCalledWith({ scope: 'local' });
  });

  test('a sign-up left while the code is being checked: the now-confirmed account gets the chosen password and no other session, then its session goes', async () => {
    const c = startEmailConfirmation('ava@example.com', 'correct horse');
    mockVerifyOtp.mockImplementationOnce(async () => {
      await c.abandon();
      mockAside.held = sessionFor(1);
      return { data: { session: mockAside.held, user: USER }, error: null };
    });
    expect(await c.verify('12345678')).toBe('error');
    expect(mockUpdateUser).toHaveBeenCalledWith({ password: 'correct horse' });
    expect(mockAdminSignOut).toHaveBeenCalledWith('access-1', 'others');
    expect(mockAsideSignOut).toHaveBeenCalledWith({ scope: 'local' });
    expect(order(mockUpdateUser)).toBeLessThan(order(mockAsideSignOut));
    expect(order(mockAdminSignOut)).toBeLessThan(order(mockAsideSignOut));
    expect(mockSetSession).not.toHaveBeenCalled();
  });

  test('leaving while the app takes the session over (the screen goes as the driver signs in) signs nothing out', async () => {
    const c = startEmailConfirmation('ava@example.com', 'correct horse');
    mockSetSession.mockImplementationOnce(async () => {
      await c.abandon();
      return { data: { session: {} }, error: null };
    });
    expect(await c.verify('12345678')).toBe('ok');
    expect(mockAsideSignOut).not.toHaveBeenCalled();
  });

  test('a handover that fails after the screen went signs the session out', async () => {
    const c = startEmailConfirmation('ava@example.com', 'correct horse');
    mockSetSession.mockImplementationOnce(async () => {
      await c.abandon();
      return { data: { session: null }, error: OFFLINE };
    });
    expect(await c.verify('12345678')).toBe('unfinished');
    expect(mockAsideSignOut).toHaveBeenCalledWith({ scope: 'local' });
    expect(await c.finish()).toBe('error');
  });
});

describe('resendEmailCode', () => {
  test('asks for a fresh sign-up code for the trimmed, lower-cased address', async () => {
    mockResend.mockResolvedValue({ data: { user: null, session: null }, error: null });
    expect(await resendEmailCode(' Ava@Example.com')).toBe('sent');
    expect(mockResend).toHaveBeenCalledWith({ type: 'signup', email: 'ava@example.com' });
  });

  test.each([
    // Auth's one-mail-a-minute refusal: a code went out within the minute.
    [{ status: 429, code: 'over_email_send_rate_limit', message: 'For security purposes, you can only request this after 42 seconds.' }, 'too_soon'],
    [{ status: 429, code: 'over_email_send_rate_limit', message: 'For security purposes, you can only request this after 1 second.' }, 'too_soon'],
    // The project's hourly cap shares the code but sent nothing.
    [{ status: 429, code: 'over_email_send_rate_limit', message: 'Email rate limit exceeded' }, 'rate_limited'],
    [{ status: 429, code: 'over_email_send_rate_limit' }, 'rate_limited'],
    // The send-email hook's per-address cap.
    [{ status: 429, message: 'Too many codes for this address. Try again later.' }, 'rate_limited'],
    [{ status: 429, code: 'over_request_rate_limit' }, 'rate_limited'],
    [OFFLINE, 'offline'],
    [{ status: 500, code: 'unexpected_failure' }, 'error'],
  ])('maps %j to %s', async (error, expected) => {
    mockResend.mockResolvedValue({ data: { user: null, session: null }, error });
    expect(await resendEmailCode('ava@example.com')).toBe(expected);
  });

  test('a throw is an error', async () => {
    mockResend.mockRejectedValue(new Error('boom'));
    expect(await resendEmailCode('ava@example.com')).toBe('error');
  });
});

describe('requestPasswordReset (Forgot password)', () => {
  test('asks Auth for a reset code for the trimmed, lower-cased address, with no link to follow', async () => {
    mockResetPassword.mockResolvedValue({ data: {}, error: null });
    expect(await requestPasswordReset(' Ava@Example.com ')).toBe('sent');
    expect(mockResetPassword).toHaveBeenCalledWith('ava@example.com');
  });

  test.each([
    [{ status: 429, code: 'over_email_send_rate_limit', message: 'For security purposes, you can only request this after 30 seconds.' }, 'too_soon'],
    [{ status: 429, code: 'over_email_send_rate_limit', message: 'Email rate limit exceeded' }, 'rate_limited'],
    [{ status: 429, message: 'Too many codes for this address. Try again later.' }, 'rate_limited'],
    [OFFLINE, 'offline'],
    [{ status: 500, code: 'unexpected_failure' }, 'error'],
  ])('maps %j to %s', async (error, expected) => {
    mockResetPassword.mockResolvedValue({ data: null, error });
    expect(await requestPasswordReset('ava@example.com')).toBe(expected);
  });

  test('a throw is an error', async () => {
    mockResetPassword.mockRejectedValue(new Error('boom'));
    expect(await requestPasswordReset('ava@example.com')).toBe('error');
  });
});

describe('startEmailConfirmation for a reset code (recovery)', () => {
  const order = (fn: jest.Mock): number => fn.mock.invocationCallOrder[0] ?? Number.NaN;

  test('checks the code as a recovery code, sets the new password, signs out every other session, then signs in', async () => {
    const c = startEmailConfirmation(' Ava@Example.com ', 'new password 1', 'recovery');
    expect(await c.verify('87654321')).toBe('ok');
    expect(mockVerifyOtp).toHaveBeenCalledWith({ email: 'ava@example.com', token: '87654321', type: 'recovery' });
    expect(mockUpdateUser).toHaveBeenCalledWith({ password: 'new password 1' });
    expect(mockAdminSignOut).toHaveBeenCalledWith('access-1', 'others');
    expect(mockSetSession).toHaveBeenCalledWith({ access_token: 'access-1', refresh_token: 'refresh-1' });
    expect(order(mockUpdateUser)).toBeLessThan(order(mockAdminSignOut));
    expect(order(mockAdminSignOut)).toBeLessThan(order(mockSetSession));
  });

  test('the new password the same as the old is fine: the driver knows it', async () => {
    mockUpdateUser.mockResolvedValue({ data: { user: null }, error: { status: 422, code: 'same_password' } });
    expect(await startEmailConfirmation('ava@example.com', 'new password 1', 'recovery').verify('87654321')).toBe('ok');
  });

  test('a new password Auth refuses for good leaves the driver signed out with an error, the session gone', async () => {
    mockUpdateUser.mockResolvedValue({ data: { user: null }, error: { status: 422, code: 'weak_password' } });
    const c = startEmailConfirmation('ava@example.com', 'new password 1', 'recovery');
    expect(await c.verify('87654321')).toBe('error');
    expect(mockSetSession).not.toHaveBeenCalled();
    expect(mockAdminSignOut).not.toHaveBeenCalled();
    expect(mockAsideSignOut).toHaveBeenCalledWith({ scope: 'local' });
  });

  test('a new password that could not be set for now (no connection) leaves Try again', async () => {
    mockUpdateUser.mockResolvedValueOnce({ data: { user: null }, error: OFFLINE });
    const c = startEmailConfirmation('ava@example.com', 'new password 1', 'recovery');
    expect(await c.verify('87654321')).toBe('unfinished');
    expect(await c.finish()).toBe('ok');
  });

  test('a wrong or expired reset code is wrong_code, and nothing else happens', async () => {
    mockVerifyOtp.mockResolvedValue({ data: { session: null, user: null }, error: { status: 403, code: 'otp_expired' } });
    expect(await startEmailConfirmation('ava@example.com', 'new password 1', 'recovery').verify('87654321')).toBe('wrong_code');
    expect(mockUpdateUser).not.toHaveBeenCalled();
    expect(mockSetSession).not.toHaveBeenCalled();
  });

  test('left before it finished, it still tries to set the new password and sign out the rest, then signs out', async () => {
    mockAdminSignOut.mockResolvedValueOnce({ data: null, error: OFFLINE });
    const c = startEmailConfirmation('ava@example.com', 'new password 1', 'recovery');
    expect(await c.verify('87654321')).toBe('unfinished');
    mockUpdateUser.mockClear();
    await c.abandon();
    expect(mockUpdateUser).toHaveBeenCalledWith({ password: 'new password 1' });
    expect(mockAsideSignOut).toHaveBeenCalledWith({ scope: 'local' });
    expect(mockSetSession).not.toHaveBeenCalled();
  });
});

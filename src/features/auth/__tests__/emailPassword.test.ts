import {
  claimChosenUsername,
  CODE_LENGTH,
  keepChosenPassword,
  PASSWORD_MIN,
  registerWithPassword,
  RESEND_COOLDOWN_S,
  resendEmailCode,
  signInWithPassword,
  verifyEmailCode,
} from '@/features/auth/emailPassword';

const mockSignUp = jest.fn();
const mockSignInWithPassword = jest.fn();
const mockVerifyOtp = jest.fn();
const mockResend = jest.fn();
const mockUpdateUser = jest.fn();
const mockRpc = jest.fn();

jest.mock('@/data/supabase/client', () => ({
  supabase: {
    auth: {
      signUp: (...args: unknown[]) => mockSignUp(...args),
      signInWithPassword: (...args: unknown[]) => mockSignInWithPassword(...args),
      verifyOtp: (...args: unknown[]) => mockVerifyOtp(...args),
      resend: (...args: unknown[]) => mockResend(...args),
      updateUser: (...args: unknown[]) => mockUpdateUser(...args),
    },
    rpc: (...args: unknown[]) => mockRpc(...args),
  },
}));

/** What supabase-js answers when the request never reached Auth (no connection). */
const OFFLINE = { name: 'AuthRetryableFetchError', status: 0, message: 'Network request failed' };

beforeEach(() => {
  mockSignUp.mockReset();
  mockSignInWithPassword.mockReset();
  mockVerifyOtp.mockReset();
  mockResend.mockReset();
  mockUpdateUser.mockReset();
  mockRpc.mockReset();
});

test('passwords need at least 8 characters, as the server is set to require', () => {
  expect(PASSWORD_MIN).toBe(8);
});

test("the code is 6 digits and Resend waits a minute, as the server's otp_length and max_frequency say", () => {
  expect(CODE_LENGTH).toBe(6);
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
    [{ status: 429 }, 'rate_limited'],
    [{ status: 500, code: 'unexpected_failure' }, 'error'],
    [new Error('Network request failed'), 'error'],
  ])('maps %j to %s', async (error, expected) => {
    mockSignUp.mockResolvedValue({ data: { session: null }, error });
    expect(await registerWithPassword('ava@example.com', 'correct horse')).toBe(expected);
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
    [new Error('Network request failed'), 'error'],
  ])('maps %j to %s', async (error, expected) => {
    mockSignInWithPassword.mockResolvedValue({ error });
    expect(await signInWithPassword('ava@example.com', 'wrong')).toBe(expected);
  });
});

describe('verifyEmailCode', () => {
  test('checks the code as a sign-up confirmation for the trimmed, lower-cased address', async () => {
    mockVerifyOtp.mockResolvedValue({ data: { session: { access_token: 'x' }, user: { id: 'u1' } }, error: null });
    expect(await verifyEmailCode(' Ava@Example.com ', '123456')).toBe('ok');
    expect(mockVerifyOtp).toHaveBeenCalledWith({ email: 'ava@example.com', token: '123456', type: 'signup' });
  });

  test.each([
    [{ status: 403, code: 'otp_expired' }, 'wrong_code'],
    [{ status: 429, code: 'over_request_rate_limit' }, 'rate_limited'],
    [OFFLINE, 'offline'],
    [{ name: 'AuthRetryableFetchError', status: 503 }, 'error'],
    [{ status: 500, code: 'unexpected_failure' }, 'error'],
  ])('maps %j to %s', async (error, expected) => {
    mockVerifyOtp.mockResolvedValue({ data: { session: null, user: null }, error });
    expect(await verifyEmailCode('ava@example.com', '123456')).toBe(expected);
  });

  test('an answer with no session, or a throw, is an error rather than a sign-in', async () => {
    mockVerifyOtp.mockResolvedValue({ data: { session: null, user: null }, error: null });
    expect(await verifyEmailCode('ava@example.com', '123456')).toBe('error');
    mockVerifyOtp.mockRejectedValue(new Error('boom'));
    expect(await verifyEmailCode('ava@example.com', '123456')).toBe('error');
  });
});

describe('resendEmailCode', () => {
  test('asks for a fresh sign-up code for the trimmed, lower-cased address', async () => {
    mockResend.mockResolvedValue({ data: { user: null, session: null }, error: null });
    expect(await resendEmailCode(' Ava@Example.com')).toBe('sent');
    expect(mockResend).toHaveBeenCalledWith({ type: 'signup', email: 'ava@example.com' });
  });

  test.each([
    [{ status: 429, code: 'over_email_send_rate_limit' }, 'rate_limited'],
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

describe('keepChosenPassword', () => {
  test('sets the password chosen on the form', async () => {
    mockUpdateUser.mockResolvedValue({ data: { user: { id: 'u1' } }, error: null });
    await keepChosenPassword('correct horse');
    expect(mockUpdateUser).toHaveBeenCalledWith({ password: 'correct horse' });
  });

  test('the same password refused, or any failure, is not an error', async () => {
    mockUpdateUser.mockResolvedValue({ data: { user: null }, error: { status: 422, code: 'same_password' } });
    await expect(keepChosenPassword('correct horse')).resolves.toBeUndefined();
    mockUpdateUser.mockRejectedValue(new Error('offline'));
    await expect(keepChosenPassword('correct horse')).resolves.toBeUndefined();
  });
});

describe('claimChosenUsername', () => {
  test('claims the name through claim_username', async () => {
    mockRpc.mockResolvedValue({ data: null, error: null });
    expect(await claimChosenUsername('ava_01')).toBe(true);
    expect(mockRpc).toHaveBeenCalledWith('claim_username', { p: 'ava_01' });
  });

  test('a name that is taken, or any failure, is false rather than a throw', async () => {
    mockRpc.mockResolvedValue({ data: null, error: { message: 'username is taken', code: '23505' } });
    expect(await claimChosenUsername('ava_01')).toBe(false);
    mockRpc.mockRejectedValue(new Error('offline'));
    expect(await claimChosenUsername('ava_01')).toBe(false);
  });
});

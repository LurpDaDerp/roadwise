import {
  claimChosenUsername,
  PASSWORD_MIN,
  registerWithPassword,
  signInWithPassword,
} from '@/features/auth/emailPassword';

const mockSignUp = jest.fn();
const mockSignInWithPassword = jest.fn();
const mockRpc = jest.fn();

jest.mock('@/data/supabase/client', () => ({
  supabase: {
    auth: {
      signUp: (...args: unknown[]) => mockSignUp(...args),
      signInWithPassword: (...args: unknown[]) => mockSignInWithPassword(...args),
    },
    rpc: (...args: unknown[]) => mockRpc(...args),
  },
}));

beforeEach(() => {
  mockSignUp.mockReset();
  mockSignInWithPassword.mockReset();
  mockRpc.mockReset();
});

test('passwords need at least 8 characters, as the server is set to require', () => {
  expect(PASSWORD_MIN).toBe(8);
});

describe('registerWithPassword', () => {
  test('sends the address trimmed and lower-cased, and the password untouched', async () => {
    mockSignUp.mockResolvedValue({ data: { session: { access_token: 'x' } }, error: null });
    expect(await registerWithPassword('  Ava@Example.COM ', ' Pass Word 1 ')).toBe('ok');
    expect(mockSignUp).toHaveBeenCalledWith({ email: 'ava@example.com', password: ' Pass Word 1 ' });
  });

  test('an answer with no session is a project that wants the address confirmed first', async () => {
    mockSignUp.mockResolvedValue({ data: { session: null }, error: null });
    expect(await registerWithPassword('ava@example.com', 'correct horse')).toBe('confirm_email');
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
    [{ status: 400, code: 'email_not_confirmed' }, 'error'],
    [new Error('Network request failed'), 'error'],
  ])('maps %j to %s', async (error, expected) => {
    mockSignInWithPassword.mockResolvedValue({ error });
    expect(await signInWithPassword('ava@example.com', 'wrong')).toBe(expected);
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

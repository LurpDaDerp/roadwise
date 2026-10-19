import { sendEmailCode, verifyEmailCode } from '@/features/auth/emailCode';

// The real client reads `.env` and AsyncStorage at import time, neither of which exists under Jest.
// The arrow bodies run at call time, by which point the mocks are initialised.
const mockSignInWithOtp = jest.fn();
const mockVerifyOtp = jest.fn();
jest.mock('@/data/supabase/client', () => ({
  supabase: {
    auth: {
      signInWithOtp: (...a: unknown[]) => mockSignInWithOtp(...a),
      verifyOtp: (...a: unknown[]) => mockVerifyOtp(...a),
    },
  },
}));

beforeEach(() => {
  mockSignInWithOtp.mockReset();
  mockVerifyOtp.mockReset();
});

describe('sending the code', () => {
  test('asks Auth to email a code to the trimmed, lower-cased address, with no redirect link', async () => {
    mockSignInWithOtp.mockResolvedValue({ error: null });
    await expect(sendEmailCode('  Ava@Example.com ')).resolves.toBe('sent');
    expect(mockSignInWithOtp).toHaveBeenCalledWith({ email: 'ava@example.com' });
  });

  test.each([
    [{ status: 429, message: 'Too Many Requests' }],
    [{ status: 400, code: 'over_email_send_rate_limit', message: 'rate limit' }],
  ])('a refused burst (%j) says to wait', async (error) => {
    mockSignInWithOtp.mockResolvedValue({ error });
    await expect(sendEmailCode('x@example.com')).resolves.toBe('rate_limited');
  });

  test.each([
    [{ status: 400, code: 'validation_failed', message: 'bad email' }],
    [{ status: 400, code: 'email_address_not_authorized', message: 'not allowed' }],
    [{ status: 500, message: 'boom' }],
    [{ code: 'over_sms_send_rate_limit' }],
    ['a string'],
  ])('any other refusal (%j) is a plain error', async (error) => {
    mockSignInWithOtp.mockResolvedValue({ error });
    await expect(sendEmailCode('x@example.com')).resolves.toBe('error');
  });
});

describe('verifying the code', () => {
  test('exchanges the address and the typed code for a session', async () => {
    mockVerifyOtp.mockResolvedValue({ data: { session: {} }, error: null });
    await expect(verifyEmailCode(' Ava@Example.com', '123456')).resolves.toBe('ok');
    expect(mockVerifyOtp).toHaveBeenCalledWith({ email: 'ava@example.com', token: '123456', type: 'email' });
  });

  test('a wrong, spent or expired code (otp_expired) is invalid', async () => {
    mockVerifyOtp.mockResolvedValue({
      error: { status: 403, code: 'otp_expired', message: 'Token has expired or is invalid' },
    });
    await expect(verifyEmailCode('x@example.com', '000000')).resolves.toBe('invalid');
  });

  test('too many tries says to wait', async () => {
    mockVerifyOtp.mockResolvedValue({ error: { status: 429, code: 'over_request_rate_limit' } });
    await expect(verifyEmailCode('x@example.com', '000000')).resolves.toBe('rate_limited');
  });

  test.each([[{ status: 500, message: 'boom' }], [{ status: 403, code: 'user_banned' }], ['a string']])(
    'anything else (%j) is a plain error',
    async (error) => {
      mockVerifyOtp.mockResolvedValue({ error });
      await expect(verifyEmailCode('x@example.com', '123456')).resolves.toBe('error');
    }
  );
});

import { act, renderHook } from '@testing-library/react-native';

import { useMagicLink } from '@/features/auth/useMagicLink';

// The real client reads `.env` and AsyncStorage at import time, neither of which exists under Jest.
// The arrow body below runs at call time, by which point `mockSignInWithOtp` is initialised.
const mockSignInWithOtp = jest.fn();
jest.mock('@/data/supabase/client', () => ({
  supabase: { auth: { signInWithOtp: (...a: unknown[]) => mockSignInWithOtp(...a) } },
}));

test('sends a magic link with the app redirect and reports sent', async () => {
  mockSignInWithOtp.mockResolvedValue({ error: null });
  const { result } = await renderHook(() => useMagicLink());
  await act(async () => {
    await result.current.send('ava@example.com');
  });
  expect(mockSignInWithOtp).toHaveBeenCalledWith({
    email: 'ava@example.com',
    options: { emailRedirectTo: 'roadwise://auth/callback' },
  });
  expect(result.current.state).toBe('sent');
});

test('reports error', async () => {
  mockSignInWithOtp.mockResolvedValue({ error: new Error('nope') });
  const { result } = await renderHook(() => useMagicLink());
  await act(async () => {
    await result.current.send('x@example.com');
  });
  expect(result.current.state).toBe('error');
});

describe('a refused burst of emails', () => {
  const sendWith = async (error: unknown) => {
    mockSignInWithOtp.mockResolvedValue({ error });
    const { result } = await renderHook(() => useMagicLink());
    let returned: unknown;
    await act(async () => {
      returned = await result.current.send('x@example.com');
    });
    return { state: result.current.state, returned };
  };

  test('HTTP 429 is rate_limited', async () => {
    await expect(sendWith({ status: 429, message: 'Too Many Requests' })).resolves.toEqual({
      state: 'rate_limited',
      returned: 'rate_limited',
    });
  });

  test('the over_email_send_rate_limit code is rate_limited', async () => {
    await expect(
      sendWith({ status: 400, code: 'over_email_send_rate_limit', message: 'rate limit' })
    ).resolves.toEqual({ state: 'rate_limited', returned: 'rate_limited' });
  });

  test('any other refusal is still a plain error', async () => {
    for (const error of [
      { status: 400, code: 'validation_failed', message: 'bad email' },
      { status: 500, message: 'boom' },
      { code: 'over_sms_send_rate_limit' },
      'a string',
    ]) {
      await expect(sendWith(error)).resolves.toEqual({ state: 'error', returned: 'error' });
    }
  });
});

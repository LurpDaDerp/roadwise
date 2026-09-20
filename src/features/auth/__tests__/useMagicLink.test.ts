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

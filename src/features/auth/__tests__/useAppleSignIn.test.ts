import { act, renderHook } from '@testing-library/react-native';

import { useAppleSignIn } from '@/features/auth/useAppleSignIn';

const mockSignInAsync = jest.fn();
jest.mock('expo-apple-authentication', () => ({
  isAvailableAsync: () => Promise.resolve(true),
  signInAsync: (...a: unknown[]) => mockSignInAsync(...a),
  AppleAuthenticationScope: { FULL_NAME: 0, EMAIL: 1 },
}));

const mockSignInWithIdToken = jest.fn();
const mockUpdateUser = jest.fn();
jest.mock('@/data/supabase/client', () => ({
  supabase: {
    auth: {
      signInWithIdToken: (...a: unknown[]) => mockSignInWithIdToken(...a),
      updateUser: (...a: unknown[]) => mockUpdateUser(...a),
    },
  },
}));

test('asks Apple for the email only and never stores a name', async () => {
  mockSignInAsync.mockResolvedValue({
    identityToken: 'tok',
    fullName: { givenName: 'Ava', familyName: 'Lee' },
  });
  mockSignInWithIdToken.mockResolvedValue({ error: null });
  const { result } = await renderHook(() => useAppleSignIn());
  await act(async () => {
    await result.current.signIn();
  });
  expect(mockSignInAsync).toHaveBeenCalledWith({ requestedScopes: [1] });
  expect(mockSignInWithIdToken).toHaveBeenCalledWith({ provider: 'apple', token: 'tok' });
  expect(mockUpdateUser).not.toHaveBeenCalled();
});

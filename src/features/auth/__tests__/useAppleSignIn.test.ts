import { sha256 } from '@noble/hashes/sha2';
import { bytesToHex, utf8ToBytes } from '@noble/hashes/utils';
import { act, renderHook } from '@testing-library/react-native';

import { useAppleSignIn } from '@/features/auth/useAppleSignIn';

const mockSignInAsync = jest.fn();
jest.mock('expo-apple-authentication', () => ({
  isAvailableAsync: () => Promise.resolve(true),
  signInAsync: (...a: unknown[]) => mockSignInAsync(...a),
  AppleAuthenticationScope: { FULL_NAME: 0, EMAIL: 1 },
}));

let mockSeed = 0;
jest.mock('expo-crypto', () => ({
  getRandomBytes: (n: number) => Uint8Array.from({ length: n }, (_, i) => (i + mockSeed++) % 256),
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

beforeEach(() => {
  jest.clearAllMocks();
});

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
  expect(mockSignInAsync).toHaveBeenCalledWith({ requestedScopes: [1], nonce: expect.any(String) });
  expect(mockSignInWithIdToken).toHaveBeenCalledWith({ provider: 'apple', token: 'tok', nonce: expect.any(String) });
  expect(mockUpdateUser).not.toHaveBeenCalled();
});

async function signInOnce(): Promise<{ raw: string; hashed: string }> {
  mockSignInAsync.mockResolvedValue({ identityToken: 'tok' });
  mockSignInWithIdToken.mockResolvedValue({ error: null });
  const { result } = await renderHook(() => useAppleSignIn());
  await act(async () => {
    await result.current.signIn();
  });
  const sent = mockSignInWithIdToken.mock.calls[mockSignInWithIdToken.mock.calls.length - 1][0] as { nonce: string };
  const requested = mockSignInAsync.mock.calls[mockSignInAsync.mock.calls.length - 1][0] as { nonce: string };
  return { raw: sent.nonce, hashed: requested.nonce };
}

test('Apple gets the hashed nonce and Supabase the raw one, so the nonce check can stay on', async () => {
  const { raw, hashed } = await signInOnce();
  expect(raw).toMatch(/^[0-9a-f]{64}$/);
  expect(hashed).toBe(bytesToHex(sha256(utf8ToBytes(raw))));
});

test('every sign-in gets a fresh nonce', async () => {
  const first = await signInOnce();
  const second = await signInOnce();
  expect(second.raw).not.toBe(first.raw);
});

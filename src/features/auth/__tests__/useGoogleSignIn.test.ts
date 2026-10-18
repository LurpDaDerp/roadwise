import { sha256 } from '@noble/hashes/sha2';
import { bytesToHex, utf8ToBytes } from '@noble/hashes/utils';
import { act, renderHook } from '@testing-library/react-native';

import { useGoogleSignIn } from '@/features/auth/useGoogleSignIn';

const mockUseIdTokenAuthRequest = jest.fn();
const mockPromptAsync = jest.fn();
jest.mock('expo-auth-session/providers/google', () => ({
  useIdTokenAuthRequest: (...a: unknown[]) => mockUseIdTokenAuthRequest(...a),
  discovery: {},
}));
jest.mock('expo-auth-session', () => ({ exchangeCodeAsync: jest.fn() }));
jest.mock('expo-web-browser', () => ({ maybeCompleteAuthSession: jest.fn() }));
jest.mock('expo-crypto', () => ({
  getRandomBytes: (n: number) => Uint8Array.from({ length: n }, (_, i) => i),
}));
jest.mock('@/lib/env', () => ({
  env: { googleIosClientId: 'ios-id', googleAndroidClientId: 'android-id', googleWebClientId: 'web-id' },
}));

const mockSignInWithIdToken = jest.fn();
jest.mock('@/data/supabase/client', () => ({
  supabase: { auth: { signInWithIdToken: (...a: unknown[]) => mockSignInWithIdToken(...a) } },
}));

beforeEach(() => {
  jest.clearAllMocks();
  mockUseIdTokenAuthRequest.mockReturnValue([{ redirectUri: 'r', codeVerifier: 'v' }, null, mockPromptAsync]);
});

test('Google gets the hashed nonce and Supabase the raw one, so the nonce check can stay on', async () => {
  mockPromptAsync.mockResolvedValue({ type: 'success', params: { id_token: 'tok' } });
  mockSignInWithIdToken.mockResolvedValue({ error: null });
  const { result } = await renderHook(() => useGoogleSignIn());
  await act(async () => {
    await result.current.signIn();
  });

  const sent = mockSignInWithIdToken.mock.calls[0][0] as { provider: string; token: string; nonce: string };
  expect(sent).toMatchObject({ provider: 'google', token: 'tok' });
  expect(sent.nonce).toMatch(/^[0-9a-f]{64}$/);
  const requested = mockUseIdTokenAuthRequest.mock.calls[0][0] as { extraParams: { nonce: string } };
  expect(requested.extraParams.nonce).toBe(bytesToHex(sha256(utf8ToBytes(sent.nonce))));
});

test('the nonce holds across re-renders, so the request Google answers is the one it was asked', async () => {
  const { rerender } = await renderHook(() => useGoogleSignIn());
  await rerender({});
  const nonces = mockUseIdTokenAuthRequest.mock.calls.map((c) => (c[0] as { extraParams: { nonce: string } }).extraParams.nonce);
  expect(nonces.length).toBeGreaterThan(1);
  expect(new Set(nonces).size).toBe(1);
});

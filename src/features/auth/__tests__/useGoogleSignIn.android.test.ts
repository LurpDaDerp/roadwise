import { sha256 } from '@noble/hashes/sha2';
import { bytesToHex, utf8ToBytes } from '@noble/hashes/utils';
import { act, renderHook } from '@testing-library/react-native';

import { GOOGLE_CREDENTIAL_CANCELLED } from '@/features/auth/googleCredential';
import { useGoogleSignInAndroid } from '@/features/auth/useGoogleSignIn';

const mockSignInAsync = jest.fn();
const mockWorld: { module: boolean } = { module: true };
jest.mock('@/features/auth/googleCredential', () => ({
  GOOGLE_CREDENTIAL_CANCELLED: 'ERR_GOOGLE_CREDENTIAL_CANCELLED',
  googleCredentialModule: () => (mockWorld.module ? { signInAsync: (...a: unknown[]) => mockSignInAsync(...a) } : null),
}));
jest.mock('expo-auth-session/providers/google', () => ({ useIdTokenAuthRequest: jest.fn(() => [null, null, jest.fn()]), discovery: {} }));
jest.mock('expo-auth-session', () => ({ exchangeCodeAsync: jest.fn() }));
jest.mock('expo-web-browser', () => ({ maybeCompleteAuthSession: jest.fn() }));
let mockSeed = 0;
jest.mock('expo-crypto', () => ({
  getRandomBytes: (n: number) => Uint8Array.from({ length: n }, (_, i) => (i + mockSeed++) % 256),
}));
const mockEnv: { googleWebClientId: string | undefined } = { googleWebClientId: 'web-id' };
jest.mock('@/lib/env', () => ({
  get env() {
    return mockEnv;
  },
}));

const mockSignInWithIdToken = jest.fn();
jest.mock('@/data/supabase/client', () => ({
  supabase: { auth: { signInWithIdToken: (...a: unknown[]) => mockSignInWithIdToken(...a) } },
}));

beforeEach(() => {
  jest.clearAllMocks();
  mockWorld.module = true;
  mockEnv.googleWebClientId = 'web-id';
  mockSignInWithIdToken.mockResolvedValue({ error: null });
});

test('Credential Manager gets the web client id and the hashed nonce, Supabase the token and the raw nonce', async () => {
  mockSignInAsync.mockResolvedValue('google-id-token');
  const { result } = await renderHook(() => useGoogleSignInAndroid());
  expect(result.current.ready).toBe(true);
  await act(async () => {
    await result.current.signIn();
  });
  const [clientId, hashed] = mockSignInAsync.mock.calls[0] as [string, string];
  expect(clientId).toBe('web-id');
  const sent = mockSignInWithIdToken.mock.calls[0][0] as { provider: string; token: string; nonce: string };
  expect(sent).toMatchObject({ provider: 'google', token: 'google-id-token' });
  expect(sent.nonce).toMatch(/^[0-9a-f]{64}$/);
  expect(hashed).toBe(bytesToHex(sha256(utf8ToBytes(sent.nonce))));
});

test('every sign-in gets a fresh nonce', async () => {
  mockSignInAsync.mockResolvedValue('t');
  const { result } = await renderHook(() => useGoogleSignInAndroid());
  await act(async () => {
    await result.current.signIn();
    await result.current.signIn();
  });
  const nonces = mockSignInWithIdToken.mock.calls.map((c) => (c[0] as { nonce: string }).nonce);
  expect(new Set(nonces).size).toBe(2);
});

test('backing out of the sheet leaves everything as it was, with no error', async () => {
  mockSignInAsync.mockRejectedValue(Object.assign(new Error('closed'), { code: GOOGLE_CREDENTIAL_CANCELLED }));
  const { result } = await renderHook(() => useGoogleSignInAndroid());
  await act(async () => {
    await expect(result.current.signIn()).resolves.toBeUndefined();
  });
  expect(mockSignInWithIdToken).not.toHaveBeenCalled();
});

test('any other failure, and a Supabase refusal, reach the screen', async () => {
  mockSignInAsync.mockRejectedValueOnce(Object.assign(new Error('no provider'), { code: 'ERR_GOOGLE_CREDENTIAL_UNAVAILABLE' }));
  const { result } = await renderHook(() => useGoogleSignInAndroid());
  await act(async () => {
    await expect(result.current.signIn()).rejects.toThrow('no provider');
  });
  mockSignInAsync.mockResolvedValue('t');
  mockSignInWithIdToken.mockResolvedValue({ error: new Error('provider off') });
  await act(async () => {
    await expect(result.current.signIn()).rejects.toThrow('provider off');
  });
});

test('no module in the binary, or no web client id: the button is not armed and a tap does nothing', async () => {
  mockWorld.module = false;
  const noModule = await renderHook(() => useGoogleSignInAndroid());
  expect(noModule.result.current.ready).toBe(false);
  mockWorld.module = true;
  mockEnv.googleWebClientId = undefined;
  const noClient = await renderHook(() => useGoogleSignInAndroid());
  expect(noClient.result.current.ready).toBe(false);
  await act(async () => {
    await noClient.result.current.signIn();
  });
  expect(mockSignInAsync).not.toHaveBeenCalled();
});

test('the hook is Credential Manager on Android and expo-auth-session elsewhere', () => {
  const pick = (os: string) => {
    let picked = '';
    jest.isolateModules(() => {
      jest.doMock('react-native', () => ({ Platform: { OS: os, select: (o: Record<string, unknown>) => o[os] ?? o.default } }));
      // eslint-disable-next-line @typescript-eslint/no-require-imports -- isolated module registry
      const m = require('@/features/auth/useGoogleSignIn') as typeof import('@/features/auth/useGoogleSignIn');
      picked = m.useGoogleSignIn === m.useGoogleSignInAndroid ? 'credential manager' : m.useGoogleSignIn === m.useGoogleSignInAuthSession ? 'auth session' : '?';
    });
    return picked;
  };
  expect(pick('android')).toBe('credential manager');
  expect(pick('ios')).toBe('auth session');
});

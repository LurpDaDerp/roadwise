import { act, renderHook } from '@testing-library/react-native';
import { Platform } from 'react-native';

import { APPLE_WEB_REDIRECT, callbackParams, useAppleSignIn } from '@/features/auth/useAppleSignIn';

const mockNativeSignIn = jest.fn();
jest.mock('expo-apple-authentication', () => ({
  isAvailableAsync: () => Promise.resolve(false),
  signInAsync: (...a: unknown[]) => mockNativeSignIn(...a),
  AppleAuthenticationScope: { FULL_NAME: 0, EMAIL: 1 },
}));
jest.mock('expo-crypto', () => ({ getRandomBytes: (n: number) => new Uint8Array(n) }));
const mockOpenAuthSession = jest.fn();
jest.mock('expo-web-browser', () => ({ openAuthSessionAsync: (...a: unknown[]) => mockOpenAuthSession(...a) }));
const mockEnv = { appleWebSignIn: true };
jest.mock('@/lib/env', () => ({ env: mockEnv }));

const mockSignInWithOAuth = jest.fn();
const mockExchange = jest.fn();
const mockUpdateUser = jest.fn();
jest.mock('@/data/supabase/client', () => ({
  supabase: {
    auth: {
      signInWithOAuth: (...a: unknown[]) => mockSignInWithOAuth(...a),
      exchangeCodeForSession: (...a: unknown[]) => mockExchange(...a),
      updateUser: (...a: unknown[]) => mockUpdateUser(...a),
    },
  },
}));

let restoreOS: () => void;
beforeEach(() => {
  jest.clearAllMocks();
  restoreOS = jest.replaceProperty(Platform, 'OS', 'android').restore;
  mockEnv.appleWebSignIn = true;
  mockSignInWithOAuth.mockResolvedValue({ data: { url: 'https://ref.supabase.co/auth/v1/authorize?provider=apple' }, error: null });
  mockExchange.mockResolvedValue({ data: { user: { user_metadata: { email: 'a@privaterelay.appleid.com' } } }, error: null });
  mockUpdateUser.mockResolvedValue({ error: null });
});
afterEach(() => restoreOS());

const run = async () => {
  const { result } = await renderHook(() => useAppleSignIn());
  await act(async () => {
    await result.current.signIn();
  });
};

test('shown on Android only when the build turns Apple web sign-in on', async () => {
  expect((await renderHook(() => useAppleSignIn())).result.current.available).toBe(true);
  mockEnv.appleWebSignIn = false;
  expect((await renderHook(() => useAppleSignIn())).result.current.available).toBe(false);
});

test('Supabase web sign-in in a Custom Tab, back to the app, the code traded for the session', async () => {
  mockOpenAuthSession.mockResolvedValue({ type: 'success', url: `${APPLE_WEB_REDIRECT}?code=one-time` });
  await run();
  expect(mockSignInWithOAuth).toHaveBeenCalledWith({ provider: 'apple', options: { redirectTo: 'roadwise://auth-callback', skipBrowserRedirect: true } });
  expect(mockOpenAuthSession).toHaveBeenCalledWith('https://ref.supabase.co/auth/v1/authorize?provider=apple', 'roadwise://auth-callback');
  expect(mockExchange).toHaveBeenCalledWith('one-time');
  // no name came: nothing to clear; the native sheet is never used on Android
  expect(mockUpdateUser).not.toHaveBeenCalled();
  expect(mockNativeSignIn).not.toHaveBeenCalled();
});

test('a name Apple shared is cleared from the account at once', async () => {
  mockOpenAuthSession.mockResolvedValue({ type: 'success', url: `${APPLE_WEB_REDIRECT}?code=c` });
  mockExchange.mockResolvedValue({ data: { user: { user_metadata: { full_name: 'Ava Lee', name: 'Ava Lee' } } }, error: null });
  await run();
  expect(mockUpdateUser).toHaveBeenCalledWith({ data: { full_name: null, name: null } });
});

test('closing the tab, or Apple’s Cancel, leaves the screen as it was', async () => {
  for (const answer of [
    { type: 'cancel' },
    { type: 'dismiss' },
    { type: 'success', url: `${APPLE_WEB_REDIRECT}?error=access_denied&error_description=cancelled` },
    { type: 'success', url: `${APPLE_WEB_REDIRECT}#error=server_error&error_code=user_cancelled_authorize` },
  ]) {
    mockOpenAuthSession.mockResolvedValueOnce(answer);
    await run();
  }
  expect(mockExchange).not.toHaveBeenCalled();
});

test('a failure reaches the screen', async () => {
  mockOpenAuthSession.mockResolvedValueOnce({ type: 'success', url: `${APPLE_WEB_REDIRECT}?error=server_error&error_code=bad_oauth_state` });
  const { result } = await renderHook(() => useAppleSignIn());
  await act(async () => {
    await expect(result.current.signIn()).rejects.toThrow('bad_oauth_state');
  });
  mockSignInWithOAuth.mockResolvedValueOnce({ data: { url: null }, error: new Error('provider is not enabled') });
  await act(async () => {
    await expect(result.current.signIn()).rejects.toThrow('provider is not enabled');
  });
  mockOpenAuthSession.mockResolvedValueOnce({ type: 'success', url: `${APPLE_WEB_REDIRECT}?code=c` });
  mockExchange.mockResolvedValueOnce({ data: {}, error: new Error('invalid flow state') });
  await act(async () => {
    await expect(result.current.signIn()).rejects.toThrow('invalid flow state');
  });
});

test('the callback link is read by hand: query and fragment, escapes decoded', () => {
  expect(callbackParams('roadwise://auth-callback?code=a%2Bb&x=1#error=e')).toEqual({ code: 'a+b', x: '1', error: 'e' });
  expect(callbackParams('roadwise://auth-callback')).toEqual({});
  expect(callbackParams('roadwise://auth-callback?bad=%E0%A4%A&code=ok')).toEqual({ code: 'ok' });
});

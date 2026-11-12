import { Platform } from 'react-native';

import { appleDeletionCode, hasAppleSignIn } from '@/features/auth/appleDeletionCode';

const mockSignInAsync = jest.fn();
jest.mock('expo-apple-authentication', () => ({
  signInAsync: (...a: unknown[]) => mockSignInAsync(...a),
}));

const realOS = Platform.OS;
beforeEach(() => {
  mockSignInAsync.mockReset();
  Platform.OS = 'ios';
});
afterAll(() => {
  Platform.OS = realOS;
});

test('hasAppleSignIn reads the provider and the providers list', () => {
  expect(hasAppleSignIn({ provider: 'apple' })).toBe(true);
  expect(hasAppleSignIn({ provider: 'google', providers: ['google', 'apple'] })).toBe(true);
  expect(hasAppleSignIn({ provider: 'google', providers: ['google'] })).toBe(false);
  expect(hasAppleSignIn({})).toBe(false);
  expect(hasAppleSignIn(undefined)).toBe(false);
});

test("asks Apple for nothing but a code, and hands it back", async () => {
  mockSignInAsync.mockResolvedValue({ authorizationCode: 'c0de', identityToken: 'tok' });
  expect(await appleDeletionCode()).toEqual({ kind: 'code', code: 'c0de' });
  expect(mockSignInAsync).toHaveBeenCalledWith({ requestedScopes: [] });
});

test('backing out is cancelled; an Apple error or no code is none', async () => {
  mockSignInAsync.mockRejectedValueOnce(Object.assign(new Error('x'), { code: 'ERR_REQUEST_CANCELED' }));
  expect(await appleDeletionCode()).toEqual({ kind: 'cancelled' });
  mockSignInAsync.mockRejectedValueOnce(Object.assign(new Error('x'), { code: 'ERR_REQUEST_UNKNOWN' }));
  expect(await appleDeletionCode()).toEqual({ kind: 'none' });
  mockSignInAsync.mockResolvedValueOnce({ authorizationCode: null });
  expect(await appleDeletionCode()).toEqual({ kind: 'none' });
});

test('off iOS there is no sheet', async () => {
  Platform.OS = 'android';
  expect(await appleDeletionCode()).toEqual({ kind: 'none' });
  expect(mockSignInAsync).not.toHaveBeenCalled();
});

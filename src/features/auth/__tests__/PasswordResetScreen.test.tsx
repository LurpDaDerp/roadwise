import { act, fireEvent, render, screen } from '@testing-library/react-native';
import { AccessibilityInfo, BackHandler } from 'react-native';

import type { ResendResult, VerifyResult } from '@/features/auth/emailPassword';
import { PasswordResetScreen, resetCopy } from '@/features/auth/PasswordResetScreen';
import { ThemeProvider } from '@/ui/theme';

const mockRequestReset = jest.fn(async (_email: string): Promise<ResendResult> => 'sent');
const mockStart = jest.fn((_email: string, _password: string | null, _kind?: string) => {});
const mockVerify = jest.fn(async (_code: string): Promise<VerifyResult> => 'ok');
const mockFinish = jest.fn(async (): Promise<VerifyResult> => 'ok');
const mockAbandon = jest.fn(async () => {});

jest.mock('@/features/auth/emailPassword', () => ({
  ...jest.requireActual('@/features/auth/emailPassword'),
  requestPasswordReset: (email: string) => mockRequestReset(email),
  startEmailConfirmation: (email: string, password: string | null, kind?: string) => {
    mockStart(email, password, kind);
    return { verify: mockVerify, finish: mockFinish, abandon: mockAbandon };
  },
}));
jest.mock('@/data/supabase/client', () => ({ supabase: {} }));
jest.mock('@/features/auth/asideAuth', () => ({ createAsideAuth: jest.fn() }));

type BackListener = Parameters<typeof BackHandler.addEventListener>[1];
let backHandlers: BackListener[] = [];
const onBack = jest.fn();

beforeEach(() => {
  jest.useFakeTimers();
  jest.setSystemTime(new Date('2026-11-20T12:00:00Z'));
  mockRequestReset.mockReset().mockResolvedValue('sent');
  mockStart.mockReset();
  mockVerify.mockReset().mockResolvedValue('ok');
  mockFinish.mockReset().mockResolvedValue('ok');
  mockAbandon.mockReset().mockResolvedValue(undefined);
  onBack.mockReset();
  jest.mocked(AccessibilityInfo.announceForAccessibilityWithOptions).mockClear();
  backHandlers = [];
  jest.spyOn(BackHandler, 'addEventListener').mockImplementation((_e, fn) => {
    backHandlers.push(fn);
    return {
      remove: () => {
        backHandlers = backHandlers.filter((h) => h !== fn);
      },
    };
  });
});

afterEach(() => {
  jest.useRealTimers();
  jest.restoreAllMocks();
});

const mount = (initialEmail = 'ava@example.com') =>
  render(
    <ThemeProvider>
      <PasswordResetScreen initialEmail={initialEmail} onBack={onBack} />
    </ThemeProvider>
  );

/** What the screen asked VoiceOver to read out (the tests run as an iPhone), in order. */
const spoken = () => jest.mocked(AccessibilityInfo.announceForAccessibilityWithOptions).mock.calls.map(([text]) => text);

const SEND = { name: resetCopy.send };
const SET = { name: resetCopy.setPassword };
const PASSWORD = 'Tr4ffic lights 9';

const toCodeStep = async () => {
  await mount();
  await fireEvent.press(screen.getByRole('button', SEND));
  await screen.findByText(resetCopy.codeTitle);
};
const fillCode = async (over: Partial<Record<'code' | 'password' | 'confirm', string>> = {}) => {
  const v = { code: '87654321', password: PASSWORD, confirm: PASSWORD, ...over };
  await fireEvent.changeText(screen.getByLabelText(resetCopy.codeLabel), v.code);
  await fireEvent.changeText(screen.getByLabelText(resetCopy.newPassword), v.password);
  await fireEvent.changeText(screen.getByLabelText(resetCopy.confirmPassword), v.confirm);
};
const pressBack = async () => {
  let handled: boolean | null | undefined;
  await act(async () => {
    handled = backHandlers[backHandlers.length - 1]?.({ type: 'hardwareBackPress', timeStamp: 0 });
  });
  return handled;
};

test('starts on the email, taken from the sign-in form, with Send code', async () => {
  await mount(' ava@example.com ');
  expect(screen.getByRole('header')).toHaveTextContent('Reset your password');
  expect(screen.getByLabelText('Email').props.value).toBe('ava@example.com');
  expect(screen.getByRole('button', SEND)).toBeEnabled();
  await fireEvent.changeText(screen.getByLabelText('Email'), 'ava@example');
  expect(screen.getByRole('button', SEND)).toBeDisabled();
});

test('Send code asks for a reset code, and the next step never says whether the address has an account', async () => {
  await toCodeStep();
  expect(mockRequestReset).toHaveBeenCalledWith('ava@example.com');
  expect(screen.getByText('If ava@example.com has a RoadWise password, RoadWise sent an 8-digit code to it. If you sign in with Apple or Google, the email says so instead.')).toBeOnTheScreen();
  expect(screen.getByLabelText(resetCopy.codeLabel).props.textContentType).toBe('oneTimeCode');
  expect(screen.getByLabelText(resetCopy.newPassword).props.secureTextEntry).toBe(true);
  expect(screen.getByLabelText(resetCopy.newPassword).props.textContentType).toBe('newPassword');
  expect(screen.getByRole('button', { name: 'Resend code in 60 s' })).toBeDisabled();
});

test('a code sent within the minute (too soon) still goes on to the code step', async () => {
  mockRequestReset.mockResolvedValueOnce('too_soon');
  await toCodeStep();
  expect(screen.queryByRole('alert')).toBeNull();
});

test.each([
  ['rate_limited', 'Too many tries. Try again later.'],
  ['offline', "You're offline. Check your connection and try again."],
  ['error', "Couldn't send a code. Try again."],
] as const)('a send that went nowhere (%s) stays on the email and says why', async (result, words) => {
  mockRequestReset.mockResolvedValueOnce(result);
  await mount();
  await fireEvent.press(screen.getByRole('button', SEND));
  expect(await screen.findByRole('alert')).toHaveTextContent(words);
  expect(screen.queryByText(resetCopy.codeTitle)).toBeNull();
  // Read out once as it appears, with no live region to say it again on Android.
  expect(spoken()).toEqual([words]);
  expect(screen.getByRole('alert').props.accessibilityLiveRegion).toBeUndefined();
});

test('Set new password waits for 8 digits and a new password that meets the rules, typed twice alike', async () => {
  await toCodeStep();
  expect(screen.getByRole('button', SET)).toBeDisabled();
  await fillCode();
  expect(screen.getByRole('button', SET)).toBeEnabled();
  for (const bad of [
    { code: '8765432' },
    { password: 'short1', confirm: 'short1' },
    { password: 'no digits here', confirm: 'no digits here' },
    { password: 'qwerty123', confirm: 'qwerty123' },
    { confirm: 'Tr4ffic lights 8' },
  ]) {
    await fillCode(bad);
    expect(screen.getByRole('button', SET)).toBeDisabled();
  }
  await fillCode({ confirm: 'Tr4ffic lights 8' });
  expect(screen.getByText("The passwords don't match.")).toBeOnTheScreen();
});

test('the right code with a new password: the code is checked as a reset code carrying that password', async () => {
  await toCodeStep();
  await fillCode({ code: '8765 4321' });
  await fireEvent.press(screen.getByRole('button', SET));
  expect(mockStart).toHaveBeenCalledWith('ava@example.com', PASSWORD, 'recovery');
  expect(mockVerify).toHaveBeenCalledWith('87654321');
  expect(screen.queryByRole('alert')).toBeNull();
});

test('a wrong code says so; trying again checks again with the password as typed then', async () => {
  mockVerify.mockResolvedValueOnce('wrong_code');
  await toCodeStep();
  await fillCode();
  await fireEvent.press(screen.getByRole('button', SET));
  expect(await screen.findByRole('alert')).toHaveTextContent('That code is wrong or has expired. Check it, or send a new one.');
  expect(spoken()).toEqual(['That code is wrong or has expired. Check it, or send a new one.']);
  await fillCode({ password: 'Blue7ocean river', confirm: 'Blue7ocean river' });
  await fireEvent.press(screen.getByRole('button', SET));
  expect(mockStart).toHaveBeenLastCalledWith('ava@example.com', 'Blue7ocean river', 'recovery');
  // The first try held nothing; it is given up before the next one.
  expect(mockAbandon).toHaveBeenCalledTimes(1);
});

test('a right code whose account could not be finished leaves only Try again, which finishes', async () => {
  mockVerify.mockResolvedValueOnce('unfinished');
  await toCodeStep();
  await fillCode();
  await fireEvent.press(screen.getByRole('button', SET));
  expect(await screen.findByRole('alert')).toHaveTextContent(resetCopy.unfinished);
  expect(screen.queryByLabelText(resetCopy.codeLabel)).toBeNull();
  await fireEvent.press(screen.getByRole('button', { name: resetCopy.tryAgain }));
  expect(mockFinish).toHaveBeenCalledTimes(1);
  expect(mockStart).toHaveBeenCalledTimes(1);
});

test('Resend code waits the minute, then sends a fresh code and clears the old one', async () => {
  await toCodeStep();
  await fireEvent.changeText(screen.getByLabelText(resetCopy.codeLabel), '1111');
  await act(async () => {
    jest.advanceTimersByTime(60_000);
  });
  await fireEvent.press(screen.getByRole('button', { name: resetCopy.resend }));
  expect(mockRequestReset).toHaveBeenCalledTimes(2);
  expect(await screen.findByText(resetCopy.resent)).toBeOnTheScreen();
  expect(screen.getByLabelText(resetCopy.codeLabel).props.value).toBe('');
  expect(spoken()).toEqual([resetCopy.resent]);
});

test('"Use a different email" goes back to the email step and gives up what was held', async () => {
  mockVerify.mockResolvedValueOnce('unfinished');
  await toCodeStep();
  await fillCode();
  await fireEvent.press(screen.getByRole('button', SET));
  await screen.findByRole('button', { name: resetCopy.tryAgain });
  await fireEvent.press(screen.getByRole('button', { name: resetCopy.changeEmail }));
  expect(mockAbandon).toHaveBeenCalledTimes(1);
  expect(screen.getByRole('header')).toHaveTextContent('Reset your password');
});

test('leaving the screen gives up a session a right code signed in', async () => {
  mockVerify.mockResolvedValueOnce('unfinished');
  await toCodeStep();
  await fillCode();
  await fireEvent.press(screen.getByRole('button', SET));
  await screen.findByRole('button', { name: resetCopy.tryAgain });
  await screen.unmount();
  expect(mockAbandon).toHaveBeenCalledTimes(1);
});

test("Android's back button goes back a step, then back to sign in, never out of the app", async () => {
  await toCodeStep();
  expect(await pressBack()).toBe(true);
  expect(screen.getByRole('header')).toHaveTextContent('Reset your password');
  expect(onBack).not.toHaveBeenCalled();
  expect(await pressBack()).toBe(true);
  expect(onBack).toHaveBeenCalledTimes(1);
});

test('Back to sign in leaves', async () => {
  await mount();
  await fireEvent.press(screen.getByRole('button', { name: resetCopy.back }));
  expect(onBack).toHaveBeenCalledTimes(1);
});

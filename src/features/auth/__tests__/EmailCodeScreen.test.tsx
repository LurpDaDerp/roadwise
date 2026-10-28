import { act, fireEvent, render, screen } from '@testing-library/react-native';

import { EmailCodeScreen, emailCodeCopy, resendWait } from '@/features/auth/EmailCodeScreen';
import type { ResendResult, VerifyResult } from '@/features/auth/emailPassword';
import { ThemeProvider } from '@/ui/theme';

// The screen's constants live beside the calls, which import the app client; nothing here reaches it.
jest.mock('@/data/supabase/client', () => ({ supabase: {} }));

const onVerify = jest.fn(async (_code: string): Promise<VerifyResult> => 'ok');
const onResend = jest.fn(async (): Promise<ResendResult> => 'sent');
const onBack = jest.fn();

const CODE = { name: '6-digit code' };
const CONFIRM = { name: 'Confirm' };

beforeEach(() => {
  jest.useFakeTimers();
  jest.setSystemTime(new Date('2026-10-27T12:00:00Z'));
  onVerify.mockReset().mockResolvedValue('ok');
  onResend.mockReset().mockResolvedValue('sent');
  onBack.mockReset();
});

afterEach(() => {
  jest.useRealTimers();
});

const mount = (props: { codeSent?: boolean; initialError?: string | null } = {}) =>
  render(
    <ThemeProvider>
      <EmailCodeScreen
        email="ava@example.com"
        codeSent={props.codeSent ?? true}
        initialError={props.initialError ?? null}
        onVerify={onVerify}
        onResend={onResend}
        onBack={onBack}
      />
    </ThemeProvider>
  );

const seconds = async (n: number) => {
  await act(async () => {
    jest.advanceTimersByTime(n * 1000);
  });
};

test('a title, the line naming the address, and a one-time-code field iOS can fill from the mail', async () => {
  await mount();
  expect(screen.getByRole('header')).toHaveTextContent('Check your email');
  expect(screen.getByText('We sent a 6-digit code to ava@example.com.')).toBeOnTheScreen();
  const field = screen.getByLabelText(CODE.name);
  expect(field.props.textContentType).toBe('oneTimeCode');
  expect(field.props.autoComplete).toBe('one-time-code');
  expect(field.props.keyboardType).toBe('number-pad');
  expect(field.props.maxLength).toBe(6);
});

test('takes digits only, and checks the code once all 6 are in', async () => {
  await mount();
  await fireEvent.changeText(screen.getByLabelText(CODE.name), '12 3-4');
  expect(screen.getByLabelText(CODE.name).props.value).toBe('1234');
  expect(screen.getByRole('button', CONFIRM)).toBeDisabled();
  expect(onVerify).not.toHaveBeenCalled();
  await fireEvent.changeText(screen.getByLabelText(CODE.name), '123456');
  expect(onVerify).toHaveBeenCalledTimes(1);
  expect(onVerify).toHaveBeenCalledWith('123456');
});

test('a code pasted or filled in whole is checked at once', async () => {
  await mount();
  await fireEvent.changeText(screen.getByLabelText(CODE.name), 'Your code: 654321');
  expect(onVerify).toHaveBeenCalledWith('654321');
});

test.each([
  ['wrong_code', 'That code is wrong or has expired. Check it, or send a new one.'],
  ['rate_limited', 'Too many tries. Try again in a minute.'],
  ['offline', "You're offline. Check your connection and try again."],
  ['error', "Couldn't confirm your email. Try again."],
] as const)('a refused code (%s) says so in plain words, and Confirm tries again', async (result, words) => {
  onVerify.mockResolvedValueOnce(result);
  await mount();
  await fireEvent.changeText(screen.getByLabelText(CODE.name), '123456');
  const alert = await screen.findByRole('alert');
  expect(alert).toHaveTextContent(words);
  expect(alert.props.accessibilityLiveRegion).toBe('polite');
  expect(screen.getByRole('button', CONFIRM)).toBeEnabled();
  await fireEvent.press(screen.getByRole('button', CONFIRM));
  expect(onVerify).toHaveBeenCalledTimes(2);
  expect(screen.queryByRole('alert')).toBeNull();
});

test('Resend code waits out the minute since the code was sent, counting down', async () => {
  await mount();
  expect(screen.getByRole('button', { name: 'Resend code in 60 s' })).toBeDisabled();
  await seconds(1);
  expect(screen.getByRole('button', { name: 'Resend code in 59 s' })).toBeDisabled();
  await fireEvent.press(screen.getByRole('button', { name: 'Resend code in 59 s' }));
  expect(onResend).not.toHaveBeenCalled();
  await seconds(59);
  expect(screen.getByRole('button', { name: 'Resend code' })).toBeEnabled();
});

test('a resend clears the old code, says a new one went out, and waits another minute', async () => {
  await mount({ codeSent: false });
  await fireEvent.changeText(screen.getByLabelText(CODE.name), '12');
  await fireEvent.press(screen.getByRole('button', { name: 'Resend code' }));
  expect(onResend).toHaveBeenCalledTimes(1);
  expect(await screen.findByText('We sent a new code.')).toBeOnTheScreen();
  expect(screen.getByLabelText(CODE.name).props.value).toBe('');
  expect(screen.getByRole('button', { name: 'Resend code in 60 s' })).toBeDisabled();
});

test.each([
  ['rate_limited', 'Too many tries. Try again in a minute.', 'Resend code in 60 s'],
  ['offline', "You're offline. Check your connection and try again.", 'Resend code'],
  ['error', "Couldn't send a new code. Try again.", 'Resend code'],
] as const)('a resend that fails (%s) says so; only a refusal waits again', async (result, words, button) => {
  onResend.mockResolvedValueOnce(result);
  await mount({ codeSent: false });
  await fireEvent.press(screen.getByRole('button', { name: 'Resend code' }));
  expect(await screen.findByRole('alert')).toHaveTextContent(words);
  expect(screen.getByRole('button', { name: button })).toBeTruthy();
});

test('with no code known to have gone out, Resend code is ready at once and the reason shows', async () => {
  await mount({ codeSent: false, initialError: emailCodeCopy.offline });
  expect(screen.getByRole('button', { name: 'Resend code' })).toBeEnabled();
  expect(screen.getByRole('alert')).toHaveTextContent("You're offline. Check your connection and try again.");
});

test('"Use a different email" goes back to the form', async () => {
  await mount();
  await fireEvent.press(screen.getByRole('button', { name: 'Use a different email' }));
  expect(onBack).toHaveBeenCalledTimes(1);
});

test('while the right code signs in, nothing more can be pressed', async () => {
  let finish: (r: VerifyResult) => void = () => {};
  onVerify.mockImplementationOnce(() => new Promise((resolve) => (finish = resolve)));
  await mount({ codeSent: false });
  await fireEvent.changeText(screen.getByLabelText(CODE.name), '123456');
  expect(screen.getByRole('button', { name: 'Use a different email' })).toBeDisabled();
  expect(screen.getByRole('button', { name: 'Resend code' })).toBeDisabled();
  await act(async () => finish('ok'));
  expect(screen.getByRole('button', { name: 'Use a different email' })).toBeDisabled();
  expect(screen.queryByRole('alert')).toBeNull();
});

test('resendWait counts whole seconds down from the send, never below 0', () => {
  expect(resendWait(null, 5_000)).toBe(0);
  expect(resendWait(0, 0)).toBe(60);
  expect(resendWait(0, 500)).toBe(60);
  expect(resendWait(0, 59_001)).toBe(1);
  expect(resendWait(0, 60_000)).toBe(0);
  expect(resendWait(0, 90_000)).toBe(0);
});

import { fireEvent, render, screen } from '@testing-library/react-native';
import { useState } from 'react';

import { SignInScreen } from '@/features/auth/SignInScreen';
import { ThemeProvider } from '@/ui/theme';

// Everything below is read from inside a mock factory, so each name is `mock`-prefixed and every
// reference sits in a function body that only runs once the module has finished evaluating.
const mockUseState = useState;
const mockAppleSignIn = jest.fn(async () => {});
const mockGoogleSignIn = jest.fn(async () => {});
const mockSend = jest.fn(async (_email: string) => 'sent' as 'sent' | 'error');
const mockWorld = { googleReady: true };

jest.mock('@/features/auth/useAppleSignIn', () => ({
  useAppleSignIn: () => ({ signIn: mockAppleSignIn, available: true }),
}));
jest.mock('@/features/auth/useGoogleSignIn', () => ({
  useGoogleSignIn: () => ({ signIn: mockGoogleSignIn, ready: mockWorld.googleReady }),
}));
// A real hook rather than a frozen value: the screen has to see `state` move the way it does in
// the app, or the confirmation line can never be asserted.
jest.mock('@/features/auth/useMagicLink', () => ({
  useMagicLink: () => {
    const [state, setState] = mockUseState<'idle' | 'sending' | 'sent' | 'error'>('idle');
    return {
      state,
      send: async (email: string) => {
        setState('sending');
        const result = await mockSend(email);
        setState(result);
        return result;
      },
    };
  },
}));

beforeEach(() => {
  mockWorld.googleReady = true;
  mockAppleSignIn.mockReset().mockResolvedValue(undefined);
  mockGoogleSignIn.mockReset().mockResolvedValue(undefined);
  mockSend.mockReset().mockResolvedValue('sent');
});

const mount = () =>
  render(
    <ThemeProvider>
      <SignInScreen />
    </ThemeProvider>
  );

test('shows Apple, Google and email options and sends a magic link', async () => {
  await mount();
  expect(screen.getByRole('button', { name: 'Continue with Apple' })).toBeTruthy();
  expect(screen.getByRole('button', { name: 'Continue with Google' })).toBeTruthy();
  await fireEvent.changeText(screen.getByLabelText('Email'), 'ava@example.com');
  await fireEvent.press(screen.getByRole('button', { name: 'Email me a sign-in link' }));
  expect(mockSend).toHaveBeenCalledWith('ava@example.com');
});

test('confirms in place once the link is on its way', async () => {
  await mount();
  await fireEvent.changeText(screen.getByLabelText('Email'), 'ava@example.com');
  await fireEvent.press(screen.getByRole('button', { name: 'Email me a sign-in link' }));
  expect(await screen.findByText('Check your email for a sign-in link.')).toBeOnTheScreen();
});

test('answers a rejected sign-in in place, in a live region', async () => {
  mockAppleSignIn.mockRejectedValueOnce(new Error('no identity token'));
  await mount();
  await fireEvent.press(screen.getByRole('button', { name: 'Continue with Apple' }));

  const alert = await screen.findByRole('alert');
  expect(alert).toHaveTextContent('Sign-in did not work. Try again.');
  // Announced without stealing focus: the driver is still in the middle of the form.
  expect(alert.props.accessibilityLiveRegion).toBe('polite');
});

test('leaves Google unarmed until its client id is configured', async () => {
  mockWorld.googleReady = false;
  await mount();
  expect(screen.getByRole('button', { name: 'Continue with Google' })).toBeDisabled();
  await fireEvent.press(screen.getByRole('button', { name: 'Continue with Google' }));
  expect(mockGoogleSignIn).not.toHaveBeenCalled();
});

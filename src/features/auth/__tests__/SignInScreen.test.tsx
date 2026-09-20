import { fireEvent, render, screen } from '@testing-library/react-native';

import { SignInScreen } from '@/features/auth/SignInScreen';
import { ThemeProvider } from '@/ui/theme';

jest.mock('@/features/auth/useAppleSignIn', () => ({
  useAppleSignIn: () => ({ signIn: jest.fn(), available: true }),
}));
jest.mock('@/features/auth/useGoogleSignIn', () => ({
  useGoogleSignIn: () => ({ signIn: jest.fn(), ready: true }),
}));
const mockSend = jest.fn(async () => 'sent');
jest.mock('@/features/auth/useMagicLink', () => ({
  useMagicLink: () => ({ send: mockSend, state: 'idle' }),
}));

test('shows Apple, Google and email options and sends a magic link', async () => {
  await render(
    <ThemeProvider>
      <SignInScreen />
    </ThemeProvider>
  );
  expect(screen.getByRole('button', { name: 'Continue with Apple' })).toBeTruthy();
  expect(screen.getByRole('button', { name: 'Continue with Google' })).toBeTruthy();
  await fireEvent.changeText(screen.getByLabelText('Email'), 'ava@example.com');
  await fireEvent.press(screen.getByRole('button', { name: 'Email me a sign-in link' }));
  expect(mockSend).toHaveBeenCalledWith('ava@example.com');
});

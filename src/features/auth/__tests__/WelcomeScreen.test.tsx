import { fireEvent, render, screen } from '@testing-library/react-native';

import { WelcomeScreen } from '@/features/auth/WelcomeScreen';
import { ThemeProvider } from '@/ui/theme';

const mockPush = jest.fn();
jest.mock('expo-router', () => ({ useRouter: () => ({ push: mockPush }) }));

beforeEach(() => {
  mockPush.mockClear();
});

const mount = () =>
  render(
    <ThemeProvider>
      <WelcomeScreen />
    </ThemeProvider>
  );

test('shows the headline, what the app does, and the privacy line', async () => {
  await mount();
  expect(screen.getByRole('header', { name: 'Build safer driving habits.' })).toBeTruthy();
  expect(
    screen.getByText(
      'RoadWise records your drives, gives short alerts while you drive, and shows what to work on after each trip.'
    )
  ).toBeTruthy();
  expect(screen.getByText('No video is stored, and nothing is shared unless you choose to.')).toBeTruthy();
});

test('says nothing about deletion, export, rewards or points, and promises no safety outcome', async () => {
  await mount();
  // The whole rendered tree: visible text, accessibility labels and hints.
  const everything = JSON.stringify(screen.toJSON());
  expect(everything).toContain('Build safer driving habits.');
  expect(everything).not.toMatch(/delete|export|reward|points/i);
  expect(everything).not.toMatch(/a score|keeps? you safe|prevent|guarantee/i);
});

test('Get started goes to sign-in', async () => {
  await mount();
  await fireEvent.press(screen.getByRole('button', { name: 'Get started' }));
  expect(mockPush).toHaveBeenCalledWith('/(auth)/sign-in');
});

test('a returning driver goes to the same sign-in screen', async () => {
  await mount();
  await fireEvent.press(screen.getByRole('button', { name: 'I already have an account' }));
  expect(mockPush).toHaveBeenCalledWith('/(auth)/sign-in');
});

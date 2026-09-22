import { act, fireEvent, render, screen } from '@testing-library/react-native';
import { ScrollView } from 'react-native';

import { WelcomeScreen } from '@/features/auth/WelcomeScreen';
import { ThemeProvider } from '@/ui/theme';

const mockPush = jest.fn();
jest.mock('expo-router', () => ({ useRouter: () => ({ push: mockPush }) }));

const mockReduceMotion = jest.fn(() => false);
jest.mock('@/ui/theme', () => {
  const actual = jest.requireActual<typeof import('@/ui/theme')>('@/ui/theme');
  return {
    ...actual,
    useTheme: () => ({ ...actual.useTheme(), reduceMotion: mockReduceMotion() }),
  };
});

const scrollTo = jest.fn();

beforeEach(() => {
  mockPush.mockClear();
  mockReduceMotion.mockReturnValue(false);
  scrollTo.mockClear();
  jest.spyOn(ScrollView.prototype, 'scrollTo').mockImplementation(scrollTo);
});

afterEach(() => {
  jest.restoreAllMocks();
});

const mount = () =>
  render(
    <ThemeProvider>
      <WelcomeScreen />
    </ThemeProvider>
  );

const TITLES = ['Drives record themselves', 'Quiet coaching, fair scores', "You control what's shared"];

test('shows the three cards, the page position and the footer lines', async () => {
  await mount();
  for (const title of TITLES) expect(screen.getByText(title)).toBeTruthy();
  expect(screen.getByLabelText('Page 1 of 3')).toBeTruthy();
  expect(screen.getByText('No video is stored.')).toBeTruthy();
  expect(screen.getByText('Your drives are yours. Nothing is shared unless you choose to.')).toBeTruthy();
});

test('says nothing about deletion, export, rewards or points, which this build cannot deliver', async () => {
  await mount();
  // The whole rendered tree, every page included: visible text, accessibility labels and hints.
  const everything = JSON.stringify(screen.toJSON());
  expect(everything).toContain('Drives record themselves');
  expect(everything).not.toMatch(/delete|export|reward|points/i);
});

test('card copy promises nothing that is not true of every drive', async () => {
  await mount();
  // Too-short, grade-C, passenger and unanswered role-unknown drives carry no score, so the
  // coaching card names what every drive has: what counted, why, and a way to flag it.
  expect(
    screen.getByText(
      'Short, calm cues while you drive. Afterwards, see what counted and why, and flag anything that looks wrong.'
    )
  ).toBeTruthy();
  expect(JSON.stringify(screen.toJSON())).not.toMatch(/a score/i);
  // The footer already carries the privacy promise; the sharing card says only what the footer does not.
  expect(screen.getByText("Sharing starts off, and turning it on is your call.")).toBeTruthy();
});

test('a width change (rotation, split screen) keeps the current page whole', async () => {
  await mount();
  const pager = screen.getByTestId('welcome-pager');
  await fireEvent(pager, 'layout', { nativeEvent: { layout: { width: 300, height: 200, x: 0, y: 0 } } });
  await fireEvent.press(screen.getByRole('button', { name: 'Next' }));
  await fireEvent(pager, 'layout', { nativeEvent: { layout: { width: 700, height: 200, x: 0, y: 0 } } });
  expect(scrollTo).toHaveBeenLastCalledWith({ x: 700, y: 0, animated: false });
  expect(screen.getByLabelText('Page 2 of 3')).toBeTruthy();
});

test('Next moves one page at a time, and the last page offers Get started', async () => {
  await mount();
  expect(screen.queryByRole('button', { name: 'Get started' })).toBeNull();

  await fireEvent.press(screen.getByRole('button', { name: 'Next' }));
  expect(screen.getByLabelText('Page 2 of 3')).toBeTruthy();

  await fireEvent.press(screen.getByRole('button', { name: 'Next' }));
  expect(screen.getByLabelText('Page 3 of 3')).toBeTruthy();
  expect(screen.queryByRole('button', { name: 'Next' })).toBeNull();
  expect(screen.queryByRole('button', { name: 'Skip' })).toBeNull();

  await fireEvent.press(screen.getByRole('button', { name: 'Get started' }));
  expect(mockPush).toHaveBeenCalledWith('/(auth)/sign-in');
});

test('Skip goes straight to sign-in', async () => {
  await mount();
  await fireEvent.press(screen.getByRole('button', { name: 'Skip' }));
  expect(mockPush).toHaveBeenCalledWith('/(auth)/sign-in');
});

test('a returning driver can sign in from any page', async () => {
  await mount();
  await fireEvent.press(screen.getByRole('button', { name: 'I already have an account' }));
  expect(mockPush).toHaveBeenCalledWith('/(auth)/sign-in');
});

test('never advances by itself', async () => {
  jest.useFakeTimers();
  try {
    await mount();
    await act(async () => {
      jest.advanceTimersByTime(60_000);
    });
    expect(screen.getByLabelText('Page 1 of 3')).toBeTruthy();
    expect(scrollTo).not.toHaveBeenCalled();
  } finally {
    jest.useRealTimers();
  }
});

test('a swipe that settles on a page updates the position', async () => {
  await mount();
  const pager = screen.getByTestId('welcome-pager');
  await fireEvent(pager, 'layout', { nativeEvent: { layout: { width: 300, height: 200, x: 0, y: 0 } } });
  await fireEvent(pager, 'momentumScrollEnd', { nativeEvent: { contentOffset: { x: 600, y: 0 } } });
  expect(screen.getByLabelText('Page 3 of 3')).toBeTruthy();
});

test('pages slide with motion on, and jump without it under reduce motion', async () => {
  const first = await mount();
  await fireEvent(screen.getByTestId('welcome-pager'), 'layout', {
    nativeEvent: { layout: { width: 300, height: 200, x: 0, y: 0 } },
  });
  await fireEvent.press(screen.getByRole('button', { name: 'Next' }));
  expect(scrollTo).toHaveBeenLastCalledWith({ x: 300, y: 0, animated: true });
  await first.unmount();

  mockReduceMotion.mockReturnValue(true);
  await mount();
  await fireEvent(screen.getByTestId('welcome-pager'), 'layout', {
    nativeEvent: { layout: { width: 300, height: 200, x: 0, y: 0 } },
  });
  await fireEvent.press(screen.getByRole('button', { name: 'Next' }));
  expect(scrollTo).toHaveBeenLastCalledWith({ x: 300, y: 0, animated: false });
});

test('the page dots show position by shape as well as colour', async () => {
  await mount();
  const dots = screen.getAllByTestId(/^welcome-dot-/, { includeHiddenElements: true });
  expect(dots).toHaveLength(3);
  const width = (i: number) => {
    const style = [dots[i]!.props.style].flat() as { width?: number }[];
    return style.reduce<number | undefined>((w, s) => s?.width ?? w, undefined);
  };
  expect(width(0)).toBeGreaterThan(width(1)!);
  expect(width(1)).toBe(width(2));
});

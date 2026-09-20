import { render, screen } from '@testing-library/react-native';
import type { ReactElement } from 'react';
import { SafeAreaProvider } from 'react-native-safe-area-context';

import { Banner } from '@/ui/primitives/Banner';
import { Card } from '@/ui/primitives/Card';
import { Screen } from '@/ui/primitives/Screen';
import { Skeleton } from '@/ui/primitives/Skeleton';
import { Text } from '@/ui/primitives/Text';
import { ThemeProvider } from '@/ui/theme';
import { tokens } from '@/ui/tokens';

const wrap = (ui: ReactElement) => render(<ThemeProvider>{ui}</ThemeProvider>);

test('a licence card face still renders its children over the laminate sheen', async () => {
  await wrap(
    <Card variant="license">
      <Text>CLASS 1</Text>
    </Card>
  );
  expect(screen.getByText('CLASS 1')).toBeOnTheScreen();
});

test('a banner exposes its message as text, not colour alone', async () => {
  await wrap(<Banner tone="warning" message="Location permission is off" />);
  expect(screen.getByText('Location permission is off')).toBeOnTheScreen();
});

test('a skeleton field mounts its pulse and stays out of the accessibility tree', async () => {
  await wrap(<Skeleton width={120} height={16} testID="field" />);
  expect(screen.queryByTestId('field')).toBeNull();
  expect(screen.getByTestId('field', { includeHiddenElements: true })).toBeOnTheScreen();
});

// A Face ID phone: the 34 pt home indicator is the inset a bottom-anchored action has to clear.
const faceId = {
  insets: { top: 47, bottom: 34, left: 0, right: 0 },
  frame: { x: 0, y: 0, width: 390, height: 844 },
};
const wrapOnPhone = (ui: ReactElement) =>
  render(
    <SafeAreaProvider initialMetrics={faceId}>
      <ThemeProvider>{ui}</ThemeProvider>
    </SafeAreaProvider>
  );

test('a screen pads its content above the home indicator by default', async () => {
  await wrapOnPhone(
    <Screen testID="screen">
      <Text>body</Text>
    </Screen>
  );
  expect(screen.getByTestId('screen')).toHaveStyle({
    paddingTop: tokens.space.lg,
    paddingBottom: 34 + tokens.space.lg,
  });
});

test('a scrolling screen keeps the inset in its content, so it still scrolls beneath the indicator', async () => {
  await wrapOnPhone(
    <Screen scroll testID="screen">
      <Text>body</Text>
    </Screen>
  );
  expect(screen.getByTestId('screen').props.contentContainerStyle).toMatchObject({
    paddingBottom: 34 + tokens.space.lg,
  });
});

test('a tab screen opts out of the bottom inset because the tab bar owns it', async () => {
  await wrapOnPhone(
    <Screen bottomInset={false} testID="screen">
      <Text>body</Text>
    </Screen>
  );
  expect(screen.getByTestId('screen')).toHaveStyle({ paddingBottom: tokens.space.lg });
});

import { render, screen } from '@testing-library/react-native';
import type { ReactElement } from 'react';
import { SafeAreaProvider } from 'react-native-safe-area-context';

import { Banner } from '@/ui/primitives/Banner';
import { Card } from '@/ui/primitives/Card';
import { Screen, ScreenTitle } from '@/ui/primitives/Screen';
import { Skeleton } from '@/ui/primitives/Skeleton';
import { Text } from '@/ui/primitives/Text';
import { plainBundle } from '@/ui/sky/palette';
import { SkyScope, ThemeProvider } from '@/ui/theme';
import { tokens } from '@/ui/tokens';

const wrap = (ui: ReactElement) => render(<ThemeProvider>{ui}</ThemeProvider>);

test('a hero card renders its children over the navy gradient, and the legacy license alias still works', async () => {
  await wrap(
    <>
      <Card variant="hero">
        <Text>Safety Rating</Text>
      </Card>
      <Card variant="license">
        <Text>Legacy</Text>
      </Card>
    </>
  );
  expect(screen.getByText('Safety Rating')).toBeOnTheScreen();
  expect(screen.getByText('Legacy')).toBeOnTheScreen();
});

test('children of a hero (scene) card draw with the scene palette, white ink, even in light mode', async () => {
  await render(
    <ThemeProvider scheme="light">
      <Card variant="hero">
        <Text>On the scene</Text>
      </Card>
    </ThemeProvider>
  );
  expect(screen.getByText('On the scene')).toHaveStyle({ color: plainBundle('light').onScene.text });
  expect(plainBundle('light').onScene.text).toBe('#FFFFFF');
});

test('a banner exposes its message as text, not colour alone', async () => {
  await wrap(<Banner tone="warning" message="Location permission is off" />);
  expect(screen.getByText('Location permission is off')).toBeOnTheScreen();
});

test('a skeleton placeholder mounts its pulse and stays out of the accessibility tree', async () => {
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

test('a sky screen title draws in the white sky ink; a plain screen title in the page ink', async () => {
  const sky = plainBundle('light').onSky;
  await wrapOnPhone(
    <>
      <Screen sky bottomInset={false} title="Analytics">
        <Text>body</Text>
      </Screen>
      <Screen>
        <ScreenTitle>Settings</ScreenTitle>
      </Screen>
    </>
  );
  expect(screen.getByRole('header', { name: 'Analytics' })).toHaveStyle({ color: '#FFFFFF' });
  expect(sky.text).toBe('#FFFFFF');
  expect(screen.getByRole('header', { name: 'Settings' })).toHaveStyle({ color: tokens.color.light.text });
});

test('text on the sky outside a sky screen: ScreenTitle onSky, the onSky tones and a SkyScope', async () => {
  const sky = plainBundle('light').onSky;
  await render(
    <ThemeProvider scheme="light">
      <ScreenTitle onSky trailing={<Text>avatar</Text>}>
        Profile
      </ScreenTitle>
      <Text tone="onSky">Hey, maya</Text>
      <Text tone="onSkyMuted">3-day streak</Text>
      <SkyScope>
        <Text tone="muted">In scope</Text>
      </SkyScope>
    </ThemeProvider>
  );
  expect(screen.getByRole('header', { name: 'Profile' })).toHaveStyle({ color: sky.text });
  expect(screen.getByText('avatar')).toBeOnTheScreen();
  expect(screen.getByText('Hey, maya')).toHaveStyle({ color: sky.text });
  expect(screen.getByText('3-day streak')).toHaveStyle({ color: sky.textMuted });
  expect(screen.getByText('In scope')).toHaveStyle({ color: sky.textMuted });
});

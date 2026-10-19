import { act, fireEvent, render, screen } from '@testing-library/react-native';
import { Text } from 'react-native';
import { getAnimatedStyle } from 'react-native-reanimated';
import { SafeAreaProvider } from 'react-native-safe-area-context';
import { StyleSheet } from 'react-native';

import { Screen } from '@/ui/primitives/Screen';
import { SkyBackdrop } from '@/ui/sky/SkyBackdrop';
import { SkyScrollProvider, SkyScrollScope, useSkyFocus } from '@/ui/sky/scroll';
import { ThemeProvider } from '@/ui/theme';

const hidden = { includeHiddenElements: true };
const metrics = { frame: { x: 0, y: 0, width: 390, height: 844 }, insets: { top: 47, left: 0, right: 0, bottom: 34 } };

let focus: (name: string) => void = () => {};
function Focus() {
  focus = useSkyFocus();
  return null;
}

const shell = () =>
  render(
    <SafeAreaProvider initialMetrics={metrics}>
      <ThemeProvider mood={{ phase: 'day', glow: 0, weather: { kind: 'clear', intensity: 'moderate' } }} reduceMotion>
        <SkyScrollProvider>
          <Focus />
          <SkyBackdrop active={false} front={false} />
          <SkyScrollScope name="home">
            <Screen sky scroll testID="home-scroll">
              <Text>Home</Text>
            </Screen>
          </SkyScrollScope>
          <SkyScrollScope name="profile">
            <Screen sky scroll testID="profile-scroll">
              <Text>Profile</Text>
            </Screen>
          </SkyScrollScope>
        </SkyScrollProvider>
      </ThemeProvider>
    </SafeAreaProvider>
  );

const shift = () => {
  const t = (getAnimatedStyle(screen.getByTestId('sky-band', hidden)) as { transform?: { translateY: number }[] }).transform;
  return (t?.[0]?.translateY ?? 0) + 0;
};
const scroll = (id: string, y: number) =>
  act(() => {
    fireEvent.scroll(screen.getByTestId(id), { nativeEvent: { contentOffset: { x: 0, y }, contentSize: { width: 390, height: 2000 }, layoutMeasurement: { width: 390, height: 844 } } });
  });

test('the sky band moves up with the tab in front, so content resting below the fade stays below it', async () => {
  await shell();
  await act(() => focus('home'));
  expect(shift()).toBe(0);
  await scroll('home-scroll', 120);
  expect(shift()).toBe(-120);
  // a tab not in front remembers its own scroll but leaves the sky alone
  await scroll('profile-scroll', 40);
  expect(shift()).toBe(-120);
  // switching tabs puts the sky where that tab is scrolled
  await act(() => focus('profile'));
  expect(shift()).toBe(-40);
  await act(() => focus('leagues'));
  expect(shift()).toBe(0);
  // pulling past the top never drags the band down off the status bar
  await act(() => focus('home'));
  await scroll('home-scroll', -60);
  expect(shift()).toBe(0);
});

test('a fixed strip of the sky stays under the status bar, so its light icons never sit on the page', async () => {
  await shell();
  const strip = screen.getByTestId('sky-status-strip', hidden);
  expect(StyleSheet.flatten(strip.props.style)).toMatchObject({ top: 0, height: 47, overflow: 'hidden' });
});

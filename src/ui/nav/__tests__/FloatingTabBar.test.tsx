import { fireEvent, render, screen } from '@testing-library/react-native';
import { StyleSheet, Text } from 'react-native';

import { FloatingTabBar, type FloatingTabBarProps } from '@/ui/nav/FloatingTabBar';
import { ThemeProvider } from '@/ui/theme';

function props(index: number, emit = jest.fn(() => ({ defaultPrevented: false }))) {
  // The shell's tabs: Home · Analytics · Friends (route `leagues`) · Profile.
  const TITLES: Record<string, string> = { home: 'Home', analytics: 'Analytics', leagues: 'Friends', profile: 'Profile' };
  const routes = Object.keys(TITLES).map((name) => ({ key: `${name}-k`, name }));
  const descriptors = Object.fromEntries(
    routes.map((r) => [
      r.key,
      { options: { title: TITLES[r.name], tabBarIcon: ({ focused }: { focused: boolean }) => <Text>{focused ? '●' : '○'}</Text> } },
    ])
  );
  const navigate = jest.fn();
  const p: FloatingTabBarProps = { state: { index, routes }, descriptors, navigation: { emit, navigate }, insets: { bottom: 34 } };
  return { p, navigate, emit };
}

test('four tabs, each spoken by name with its selected state', async () => {
  const { p } = props(2);
  await render(
    <ThemeProvider scheme="light" reduceMotion>
      <FloatingTabBar {...p} />
    </ThemeProvider>
  );
  expect(screen.getAllByRole('tab')).toHaveLength(4);
  expect(screen.getAllByRole('tab').map((t) => t.props.accessibilityLabel)).toEqual(['Home', 'Analytics', 'Friends', 'Profile']);
  expect(screen.getByRole('tab', { name: 'Friends' })).toBeSelected();
  expect(screen.getByRole('tab', { name: 'Home' })).not.toBeSelected();
});

test('a tap moves to another tab; a tap on the current tab only emits the press (scroll to top)', async () => {
  const { p, navigate, emit } = props(0);
  await render(
    <ThemeProvider scheme="dark" reduceMotion>
      <FloatingTabBar {...p} />
    </ThemeProvider>
  );
  await fireEvent.press(screen.getByRole('tab', { name: 'Analytics' }));
  expect(navigate).toHaveBeenCalledWith('analytics', undefined);
  await fireEvent.press(screen.getByRole('tab', { name: 'Home' }));
  expect(navigate).toHaveBeenCalledTimes(1);
  expect(emit).toHaveBeenCalledWith({ type: 'tabPress', target: 'home-k', canPreventDefault: true });
});

test('every tab keeps a touch target of at least 44 pt', async () => {
  const { p } = props(0);
  await render(
    <ThemeProvider scheme="light" reduceMotion>
      <FloatingTabBar {...p} />
    </ThemeProvider>
  );
  for (const tab of screen.getAllByRole('tab')) {
    const style = (tab.props.style as { height?: number }) ?? {};
    expect(style.height ?? 0).toBeGreaterThanOrEqual(44);
  }
});

test('the disc sits under the current tab from the render that selects it, with no animation to wait on', async () => {
  const view = await render(
    <ThemeProvider scheme="light" reduceMotion={false}>
      <FloatingTabBar {...props(0).p} />
    </ThemeProvider>
  );
  // The pill is 336 wide: 8 pt padding each side, four 80 pt slots, the 48 pt disc centred in its slot.
  await fireEvent(screen.getByTestId('tab-bar'), 'layout', { nativeEvent: { layout: { width: 336 } } });
  expect(StyleSheet.flatten(screen.getByTestId('tab-disc').props.style)).toMatchObject({ left: 24 });
  await view.rerender(
    <ThemeProvider scheme="light" reduceMotion={false}>
      <FloatingTabBar {...props(2).p} />
    </ThemeProvider>
  );
  expect(StyleSheet.flatten(screen.getByTestId('tab-disc').props.style)).toMatchObject({ left: 8 + 2 * 80 + 16 });
});

test('dark: the disc is centred on its icon inside the pill’s 1 pt hairline, across and down', async () => {
  const view = await render(
    <ThemeProvider scheme="dark" reduceMotion={false}>
      <FloatingTabBar {...props(0).p} />
    </ThemeProvider>
  );
  // A 338 pt frame: the 1 pt hairline and 8 pt padding each side leave four 80 pt tabs. The disc is
  // placed from inside the hairline, so it sits 16 pt into its 80 pt tab and 7 pt down the 62 pt inside.
  await fireEvent(screen.getByTestId('tab-bar'), 'layout', { nativeEvent: { layout: { width: 338 } } });
  expect(StyleSheet.flatten(screen.getByTestId('tab-bar').props.style)).toMatchObject({ borderWidth: 1 });
  expect(StyleSheet.flatten(screen.getByTestId('tab-disc').props.style)).toMatchObject({ left: 24, top: 7 });
  await view.rerender(
    <ThemeProvider scheme="dark" reduceMotion={false}>
      <FloatingTabBar {...props(3).p} />
    </ThemeProvider>
  );
  expect(StyleSheet.flatten(screen.getByTestId('tab-disc').props.style)).toMatchObject({ left: 8 + 3 * 80 + 16, top: 7 });
});

test('light has no hairline: the disc is 8 pt down; a switch of look moves it with no new layout', async () => {
  const view = await render(
    <ThemeProvider scheme="light" reduceMotion>
      <FloatingTabBar {...props(3).p} />
    </ThemeProvider>
  );
  await fireEvent(screen.getByTestId('tab-bar'), 'layout', { nativeEvent: { layout: { width: 336 } } });
  expect(StyleSheet.flatten(screen.getByTestId('tab-disc').props.style)).toMatchObject({ left: 8 + 3 * 80 + 16, top: 8 });
  // The same 336 pt frame in dark: the hairline takes 2 pt, so each tab is 79.5 pt.
  await view.rerender(
    <ThemeProvider scheme="dark" reduceMotion>
      <FloatingTabBar {...props(3).p} />
    </ThemeProvider>
  );
  expect(StyleSheet.flatten(screen.getByTestId('tab-disc').props.style)).toMatchObject({ left: 8 + 3 * 79.5 + (79.5 - 48) / 2, top: 7 });
});

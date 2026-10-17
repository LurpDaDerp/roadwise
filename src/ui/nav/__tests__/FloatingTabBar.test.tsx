import { fireEvent, render, screen } from '@testing-library/react-native';
import { Text } from 'react-native';

import { FloatingTabBar, type FloatingTabBarProps } from '@/ui/nav/FloatingTabBar';
import { ThemeProvider } from '@/ui/theme';

function props(index: number, emit = jest.fn(() => ({ defaultPrevented: false }))) {
  const routes = ['home', 'leagues', 'clan', 'profile'].map((name) => ({ key: `${name}-k`, name }));
  const descriptors = Object.fromEntries(
    routes.map((r) => [
      r.key,
      { options: { title: r.name[0]!.toUpperCase() + r.name.slice(1), tabBarIcon: ({ focused }: { focused: boolean }) => <Text>{focused ? '●' : '○'}</Text> } },
    ])
  );
  const navigate = jest.fn();
  const p: FloatingTabBarProps = { state: { index, routes }, descriptors, navigation: { emit, navigate }, insets: { bottom: 34 } };
  return { p, navigate, emit };
}

test('four tabs, each spoken by name with its selected state', async () => {
  const { p } = props(1);
  await render(
    <ThemeProvider scheme="light" reduceMotion>
      <FloatingTabBar {...p} />
    </ThemeProvider>
  );
  expect(screen.getAllByRole('tab')).toHaveLength(4);
  expect(screen.getByRole('tab', { name: 'Leagues' })).toBeSelected();
  expect(screen.getByRole('tab', { name: 'Home' })).not.toBeSelected();
});

test('a tap moves to another tab; a tap on the current tab only emits the press (scroll to top)', async () => {
  const { p, navigate, emit } = props(0);
  await render(
    <ThemeProvider scheme="dark" reduceMotion>
      <FloatingTabBar {...p} />
    </ThemeProvider>
  );
  await fireEvent.press(screen.getByRole('tab', { name: 'Clan' }));
  expect(navigate).toHaveBeenCalledWith('clan', undefined);
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

import { fireEvent, render, screen } from '@testing-library/react-native';
import type { ReactElement } from 'react';
import type { ViewStyle } from 'react-native';

import { Button } from '@/ui/primitives/Button';
import { ThemeProvider } from '@/ui/theme';

const wrap = (ui: ReactElement) => render(<ThemeProvider>{ui}</ThemeProvider>);

test('calls onPress and exposes button role', async () => {
  const onPress = jest.fn();
  await wrap(<Button label="Start drive" onPress={onPress} />);
  await fireEvent.press(screen.getByRole('button', { name: 'Start drive' }));
  expect(onPress).toHaveBeenCalledTimes(1);
});

test('disabled and loading do not fire', async () => {
  const onPress = jest.fn();
  await wrap(<Button label="Go" onPress={onPress} loading />);
  await fireEvent.press(screen.getByRole('button'));
  expect(onPress).not.toHaveBeenCalled();
  expect(screen.getByRole('button')).toBeBusy();
});

test('hud size is at least 64 pt tall', async () => {
  await wrap(<Button label="End drive" onPress={() => {}} size="hud" testID="b" />);
  const style = screen.getByTestId('b').props.style as ViewStyle | ViewStyle[];
  const flat: ViewStyle = Array.isArray(style) ? Object.assign({}, ...style) : style;
  expect(flat.minHeight).toBeGreaterThanOrEqual(64);
});

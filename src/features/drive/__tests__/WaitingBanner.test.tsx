// The Start-swipe waiting band: its two lines never scale themselves (a fixed line on a frame a hair
// short collapsed such text to 4 pt on iOS) and sit on whole points in the 40 pt bar and the 56 pt band.
import { render, screen } from '@testing-library/react-native';
import { StyleSheet } from 'react-native';

import { HUD } from '@/ui/drive';

import { WaitingBanner } from '../WaitingBanner';

const flat = (id: string) => StyleSheet.flatten(screen.getByTestId(id).props.style) as Record<'lineHeight' | 'paddingVertical', number>;

test.each([false, true])('no self-scaling text (adjustsFontSizeToFit, minimumFontScale); one line each, tail-ellipsized (compact %s)', async (compact) => {
  await render(<WaitingBanner palette={HUD.day} compact={compact} />);
  for (const el of [screen.getByText('Ready to roll'), screen.getByTestId('hud-waiting-line')]) {
    expect(el.props.adjustsFontSizeToFit).toBeUndefined();
    expect(el.props.minimumFontScale).toBeUndefined();
    expect(el.props.allowFontScaling).toBe(false);
    expect(el.props.numberOfLines).toBe(1);
  }
});

test('the compact lines add up to the bar’s 36 pt content box (40 less its 2 pt outlines), so both tops are whole points', async () => {
  await render(<WaitingBanner palette={HUD.day} compact />);
  const title = StyleSheet.flatten(screen.getByText('Ready to roll').props.style) as Record<'lineHeight' | 'paddingVertical', number>;
  expect(title.lineHeight + flat('hud-waiting-line').lineHeight).toBe(36);
});

test('the full lines and padding make a bar whose top in the 56 pt band is a whole number of points', async () => {
  await render(<WaitingBanner palette={HUD.day} compact={false} />);
  const title = StyleSheet.flatten(screen.getByText('Ready to roll').props.style) as Record<'lineHeight' | 'paddingVertical', number>;
  const bar = Math.max(40, title.lineHeight + flat('hud-waiting-line').lineHeight + 2 * flat('hud-waiting').paddingVertical + 4);
  expect(Number.isInteger((56 - bar) / 2)).toBe(true);
});

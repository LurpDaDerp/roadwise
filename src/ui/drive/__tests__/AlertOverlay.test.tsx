import { render, screen } from '@testing-library/react-native';
import { Animated, StyleSheet, type ViewStyle } from 'react-native';

import type { AlertDecision, AlertKind, AlertLevel } from '@/core/alerts/types';
import { AlertOverlay } from '@/ui/drive/AlertOverlay';
import { countWords } from '@/ui/drive/hudSelectors';
import { HUD } from '@/ui/drive/hudTokens';

const decision = (
  level: AlertLevel,
  kind: AlertKind = 'speeding',
  voice?: AlertDecision['voice'],
  id = `d-${level}-${kind}`
): AlertDecision => ({ id, level, kind, ts: 1, ...(voice ? { voice } : null) });

const flat = (style: unknown): ViewStyle => StyleSheet.flatten(style as ViewStyle);

afterEach(() => jest.restoreAllMocks());

test('no decision draws nothing', async () => {
  await render(<AlertOverlay decision={null} night={false} reduceMotion={false} />);
  expect(screen.queryByTestId(/hud-alert/)).toBeNull();
});

test('L1 is a border tint and an icon, with no words', async () => {
  await render(
    <AlertOverlay decision={decision(1, 'speeding', 'alert.easeOff')} night={false} reduceMotion />
  );
  const frame = screen.getByTestId('hud-alert-l1');
  expect(flat(frame.props.style).borderWidth).toBeGreaterThanOrEqual(8);
  expect(flat(frame.props.style).borderColor).toBe(HUD.day.attention);
  expect(screen.getByTestId('hud-alert-icon')).toBeOnTheScreen();
  expect(screen.queryByText('Ease off')).toBeNull();
});

test('L2 is a full-width band with an icon and two words', async () => {
  await render(
    <AlertOverlay decision={decision(2, 'phone', 'alert.phoneDown')} night={false} reduceMotion />
  );
  const band = screen.getByTestId('hud-alert-l2');
  expect(flat(band.props.style)).toMatchObject({
    left: 0,
    right: 0,
    backgroundColor: HUD.day.attention,
  });
  expect(screen.getByTestId('hud-alert-icon')).toBeOnTheScreen();
  expect(screen.getByText('Phone down')).toBeOnTheScreen();
});

test('L3 is a full-screen high-contrast panel', async () => {
  await render(
    <AlertOverlay decision={decision(3, 'drowsy', 'alert.drowsy')} night={false} reduceMotion />
  );
  const panel = screen.getByTestId('hud-alert-l3');
  expect(flat(panel.props.style)).toMatchObject({
    top: 0,
    bottom: 0,
    left: 0,
    right: 0,
    backgroundColor: HUD.day.critical,
  });
  expect(screen.getByText('Take a break')).toBeOnTheScreen();
});

test('the levels differ by shape and position, not colour alone', async () => {
  const shapes: string[] = [];
  for (const level of [1, 2, 3] as AlertLevel[]) {
    const { unmount } = await render(
      <AlertOverlay decision={decision(level)} night={false} reduceMotion />
    );
    const s = flat(screen.getByTestId(`hud-alert-l${level}`).props.style);
    shapes.push(
      JSON.stringify({
        top: s.top,
        bottom: s.bottom,
        border: s.borderWidth ?? 0,
      })
    );
    await unmount();
  }
  expect(new Set(shapes).size).toBe(3);
});

const kinds: AlertKind[] = ['speeding', 'phone', 'eyes_off', 'drowsy', 'break'];
test('every overlay shows at most three words (SR3)', async () => {
  for (const kind of kinds)
    for (const level of [2, 3] as AlertLevel[]) {
      const voice = kind === 'break' ? 'alert.takeABreak' : undefined;
      const { unmount } = await render(
        <AlertOverlay decision={decision(level, kind, voice)} night={false} reduceMotion />
      );
      const words = screen.getByTestId('hud-alert-words');
      expect(countWords(String(words.props.children))).toBeLessThanOrEqual(3);
      await unmount();
    }
});

test('the overlay never takes a touch, so the long-press mute beneath it still works', async () => {
  for (const level of [1, 2, 3] as AlertLevel[]) {
    const { unmount } = await render(
      <AlertOverlay decision={decision(level)} night={false} reduceMotion />
    );
    expect(screen.getByTestId('hud-alert')).toHaveProp('pointerEvents', 'none');
    await unmount();
  }
});

test('announced to a screen reader as an alert with its words', async () => {
  await render(
    <AlertOverlay decision={decision(2, 'eyes_off', 'alert.eyesUp')} night={false} reduceMotion />
  );
  const band = screen.getByTestId('hud-alert-l2');
  expect(band).toHaveProp('accessibilityRole', 'alert');
  expect(band).toHaveProp('accessibilityLabel', 'Eyes up');
});

test('with reduce motion the overlay appears at full opacity with no animation', async () => {
  const timing = jest.spyOn(Animated, 'timing');
  await render(<AlertOverlay decision={decision(2)} night={false} reduceMotion />);
  expect(timing).not.toHaveBeenCalled();
  expect(flat(screen.getByTestId('hud-alert').props.style).opacity).toBe(1);
});

test('without reduce motion it fades in once, inside the 300 ms state-transition limit', async () => {
  const timing = jest.spyOn(Animated, 'timing');
  await render(<AlertOverlay decision={decision(2)} night={false} reduceMotion={false} />);
  expect(timing).toHaveBeenCalledTimes(1);
  const config = timing.mock.calls[0]![1] as Animated.TimingAnimationConfig;
  expect(config.duration).toBeLessThanOrEqual(300);
  expect(config.toValue).toBe(1);
  expect(config.useNativeDriver).toBe(true);
});

test('the same decision re-rendered at 1 Hz does not animate again', async () => {
  const timing = jest.spyOn(Animated, 'timing');
  const d = decision(2);
  const { rerender } = await render(
    <AlertOverlay decision={d} night={false} reduceMotion={false} />
  );
  await rerender(<AlertOverlay decision={{ ...d }} night={false} reduceMotion={false} />);
  expect(timing).toHaveBeenCalledTimes(1);
});

test('night mode uses the night palette', async () => {
  await render(<AlertOverlay decision={decision(3)} night reduceMotion />);
  expect(flat(screen.getByTestId('hud-alert-l3').props.style).backgroundColor).toBe(
    HUD.night.critical
  );
});

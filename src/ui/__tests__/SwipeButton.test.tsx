import { act, fireEvent, render, screen } from '@testing-library/react-native';
import * as Haptics from 'expo-haptics';
import { Text } from 'react-native';
import { State } from 'react-native-gesture-handler';
import { fireGestureHandler, getByGestureTestId } from 'react-native-gesture-handler/jest-utils';

import { SWIPE_COMMIT, SWIPE_SETTLE_MS, SwipeButton } from '@/ui/primitives/SwipeButton';

jest.mock('expo-haptics', () => ({
  impactAsync: jest.fn(async () => {}),
  notificationAsync: jest.fn(async () => {}),
  ImpactFeedbackStyle: { Light: 'light', Medium: 'medium', Heavy: 'heavy' },
  NotificationFeedbackType: { Success: 'success', Warning: 'warning', Error: 'error' },
}));

const onSwipe = jest.fn();
const COLORS = { track: '#111113', fill: '#1F5AD6', knob: '#FFFFFF', knobInk: '#111113', hint: '#FFFFFF' };
/** A 300 pt capsule, 64 tall: the knob (52) travels 300 − 52 − 12 = 236 pt. */
const TRAVEL = 236;

async function renderSwipe(props: { busy?: boolean; disabled?: boolean } = {}) {
  const r = await render(
    <SwipeButton
      testID="swipe"
      label={<Text>Start drive</Text>}
      accessibilityLabel="Start drive"
      icon="car-sport"
      colors={COLORS}
      onSwipe={onSwipe}
      {...props}
    />
  );
  await fireEvent(screen.getByTestId('swipe'), 'layout', { nativeEvent: { layout: { x: 0, y: 0, width: 300, height: 64 } } });
  return r;
}

async function swipe(to: number) {
  await act(() =>
    fireGestureHandler(getByGestureTestId('swipe-pan'), [
      { state: State.BEGAN, translationX: 0 },
      { state: State.ACTIVE, translationX: to / 2 },
      { state: State.ACTIVE, translationX: to },
      { state: State.END, translationX: to },
    ])
  );
  // The worklet hands the commit and the tick back to JS on the next frame.
  await act(() => jest.advanceTimersByTime(20));
}

beforeEach(() => {
  jest.useFakeTimers();
  jest.clearAllMocks();
});
afterEach(() => jest.useRealTimers());

test('a swipe past the commit point fires once, with a tick as it arms and a success haptic', async () => {
  await renderSwipe();
  await swipe(TRAVEL);
  expect(onSwipe).toHaveBeenCalledTimes(1);
  expect(Haptics.impactAsync).toHaveBeenCalledTimes(1);
  expect(Haptics.notificationAsync).toHaveBeenCalledWith('success');
});

test('a swipe short of the commit point does nothing', async () => {
  await renderSwipe();
  await swipe(TRAVEL * SWIPE_COMMIT - 10);
  expect(onSwipe).not.toHaveBeenCalled();
  expect(Haptics.notificationAsync).not.toHaveBeenCalled();
});

test('a swipe to the left does nothing', async () => {
  await renderSwipe();
  await swipe(-TRAVEL);
  expect(onSwipe).not.toHaveBeenCalled();
});

test('busy or disabled, it takes no swipe and says so', async () => {
  await renderSwipe({ busy: true });
  await swipe(TRAVEL);
  expect(onSwipe).not.toHaveBeenCalled();
  expect(screen.getByTestId('swipe')).toBeDisabled();
  await renderSwipe({ disabled: true });
  await swipe(TRAVEL);
  expect(onSwipe).not.toHaveBeenCalled();
});

test('a screen reader’s activate fires it straight away', async () => {
  await renderSwipe();
  await fireEvent(screen.getByRole('button', { name: 'Start drive' }), 'accessibilityAction', { nativeEvent: { actionName: 'activate' } });
  expect(onSwipe).toHaveBeenCalledTimes(1);
  expect(Haptics.notificationAsync).toHaveBeenCalledTimes(1);
});

test('a swipe whose action never goes busy settles, and the next swipe fires again', async () => {
  await renderSwipe();
  await swipe(TRAVEL);
  await act(() => jest.advanceTimersByTime(SWIPE_SETTLE_MS));
  await swipe(TRAVEL);
  expect(onSwipe).toHaveBeenCalledTimes(2);
});

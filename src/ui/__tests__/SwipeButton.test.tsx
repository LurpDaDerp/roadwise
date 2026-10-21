import { act, fireEvent, render, screen } from '@testing-library/react-native';
import * as Haptics from 'expo-haptics';
import { Text } from 'react-native';
import { State } from 'react-native-gesture-handler';
import { fireGestureHandler, getByGestureTestId } from 'react-native-gesture-handler/jest-utils';
import { getAnimatedStyle } from 'react-native-reanimated';

import {
  SWIPE_CATCH_MS,
  SWIPE_COMMIT,
  SWIPE_DISARM_PT,
  SWIPE_SETTLE_MS,
  SwipeButton,
  swipeCommitAt,
  swipeFlingFrom,
} from '@/ui/primitives/SwipeButton';

jest.mock('expo-haptics', () => ({
  impactAsync: jest.fn(async () => {}),
  notificationAsync: jest.fn(async () => {}),
  ImpactFeedbackStyle: { Light: 'light', Medium: 'medium', Heavy: 'heavy' },
  NotificationFeedbackType: { Success: 'success', Warning: 'warning', Error: 'error' },
}));

const mockSpring = jest.fn();
jest.mock('react-native-reanimated', () => {
  const actual = jest.requireActual('react-native-reanimated');
  return {
    ...actual,
    __esModule: true,
    default: actual.default,
    withSpring: (...a: unknown[]) => {
      mockSpring(...a);
      return actual.withSpring(...a);
    },
  };
});

const onSwipe = jest.fn();
const COLORS = { track: '#111113', fill: '#1F5AD6', knob: '#FFFFFF', knobInk: '#111113', hint: '#FFFFFF' };
/** A 300 pt capsule, 64 tall: the knob (52) travels 300 − 52 − 12 = 236 pt. */
const TRAVEL = 236;

async function renderSwipe(props: { busy?: boolean; disabled?: boolean; verticalSlop?: number } = {}, width = 300) {
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
  await fireEvent(screen.getByTestId('swipe'), 'layout', { nativeEvent: { layout: { x: 0, y: 0, width, height: 64 } } });
  return r;
}

/** A drag through `path` (translationX at each move), let go at its last point at `velocityX`. */
async function drag(path: number[], velocityX = 0) {
  const last = path[path.length - 1]!;
  await act(() =>
    fireGestureHandler(getByGestureTestId('swipe-pan'), [
      { state: State.BEGAN, translationX: 0, velocityX: 0 },
      // activation (8 pt): the move that starts the drag
      { state: State.ACTIVE, translationX: 8, velocityX },
      ...path.map((t) => ({ state: State.ACTIVE, translationX: t, velocityX })),
      { state: State.END, translationX: last, velocityX },
    ])
  );
  await act(() => jest.advanceTimersByTime(20));
}

const knobX = () => {
  const t = (getAnimatedStyle(screen.getByTestId('swipe-knob')) as { transform?: { translateX: number }[] }).transform;
  return t?.[0]?.translateX ?? 0;
};

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

test('the commit point: 60 % of the travel, at least 72 pt, never past the end', () => {
  expect(SWIPE_COMMIT).toBe(0.6);
  expect(swipeCommitAt(TRAVEL)).toBeCloseTo(141.6, 6);
  expect(swipeCommitAt(100)).toBe(72);
  expect(swipeCommitAt(60)).toBe(60);
  expect(swipeFlingFrom(TRAVEL)).toBeCloseTo(94.4, 6);
  expect(swipeFlingFrom(100)).toBe(56);
  expect(swipeFlingFrom(40)).toBe(40);
});

test('a swipe short of the commit point does nothing', async () => {
  await renderSwipe();
  await swipe(TRAVEL * SWIPE_COMMIT - 10);
  expect(onSwipe).not.toHaveBeenCalled();
  expect(Haptics.notificationAsync).not.toHaveBeenCalled();
  expect(Haptics.impactAsync).not.toHaveBeenCalled();
});

test('just past the commit point it arms with a tick and the knob springs on to the end by itself; letting go fires it', async () => {
  await renderSwipe();
  await drag([150]);
  // the magnet: a spring to the very end (the travel) as it arms, before the finger lets go
  expect(mockSpring.mock.calls.some(([to]) => to === TRAVEL)).toBe(true);
  expect(Haptics.impactAsync).toHaveBeenCalledTimes(1);
  expect(onSwipe).toHaveBeenCalledTimes(1);
  // at the end until the action settles (it never went busy here), then home
  await act(() => jest.advanceTimersByTime(400));
  expect(knobX()).toBeCloseTo(TRAVEL, 0);
  await act(() => jest.advanceTimersByTime(SWIPE_SETTLE_MS + 1000));
  expect(knobX()).toBeCloseTo(0, 0);
});

test('a drag that never reaches the commit point never springs toward the end', async () => {
  await renderSwipe();
  await drag([100, 130]);
  expect(mockSpring.mock.calls.every(([to]) => to === 0)).toBe(true);
  expect(onSwipe).not.toHaveBeenCalled();
});

test('dragged back well under the commit point it lets go of the end and lands nowhere', async () => {
  await renderSwipe();
  await drag([TRAVEL, swipeCommitAt(TRAVEL) - SWIPE_DISARM_PT - 6]);
  expect(onSwipe).not.toHaveBeenCalled();
  expect(Haptics.impactAsync).toHaveBeenCalledTimes(1);
});

/** The pan's own callbacks, to hold a drag between frames (a finger position at a time). */
type Pan = {
  handlers: {
    onUpdate(e: { translationX: number }): void;
    onEnd(e: { translationX: number; velocityX: number }, success: boolean): void;
  };
};

test('let go of the end, the knob slides back to the finger instead of jumping to it, then follows it', async () => {
  await renderSwipe();
  const pan = getByGestureTestId('swipe-pan') as unknown as Pan;
  const move = (translationX: number) => act(() => pan.handlers.onUpdate({ translationX }));
  await move(TRAVEL);
  await act(() => jest.advanceTimersByTime(1000));
  expect(knobX()).toBeCloseTo(TRAVEL, 0);
  // well back under the point (about 78 pt): it lets go of the end…
  const back = swipeCommitAt(TRAVEL) - SWIPE_DISARM_PT - 40;
  await move(back);
  await act(() => jest.advanceTimersByTime(32));
  // …and two frames on the knob is on its way back, not already there (no 158 pt jump)
  expect(knobX()).toBeLessThan(TRAVEL - 1);
  expect(knobX()).toBeGreaterThan(back + 20);
  await act(() => jest.advanceTimersByTime(SWIPE_CATCH_MS));
  expect(knobX()).toBeCloseTo(back, 0);
  // caught up, it is under the finger again
  await move(back - 20);
  await act(() => jest.advanceTimersByTime(20));
  expect(knobX()).toBeCloseTo(back - 20, 0);
  expect(onSwipe).not.toHaveBeenCalled();
});

test('a finger that keeps moving while the knob catches up: the knob never jumps, and ends under the finger', async () => {
  await renderSwipe();
  const pan = getByGestureTestId('swipe-pan') as unknown as Pan;
  await act(() => pan.handlers.onUpdate({ translationX: TRAVEL }));
  await act(() => jest.advanceTimersByTime(1000));
  let prev = knobX();
  // a fast drag back, a move each frame (16 ms): the knob slides after the finger, never 60 pt in one frame
  for (const t of [100, 80, 60, 40, 30, 20, 20, 20, 20, 20, 20, 20]) {
    await act(() => pan.handlers.onUpdate({ translationX: t }));
    await act(() => jest.advanceTimersByTime(16));
    const now = knobX();
    expect(prev - now).toBeLessThan(60);
    prev = now;
  }
  expect(knobX()).toBeCloseTo(20, 0);
});

test('armed again while the knob is still sliding back: it turns for the end from where it shows, never dipping back', async () => {
  await renderSwipe();
  const pan = getByGestureTestId('swipe-pan') as unknown as Pan;
  await act(() => pan.handlers.onUpdate({ translationX: TRAVEL }));
  await act(() => jest.advanceTimersByTime(1000));
  await act(() => pan.handlers.onUpdate({ translationX: 70 }));
  await act(() => jest.advanceTimersByTime(32));
  const shown = knobX();
  expect(shown).toBeLessThan(TRAVEL - 1);
  await act(() => pan.handlers.onUpdate({ translationX: TRAVEL }));
  for (let f = 0; f < 30; f += 1) {
    await act(() => jest.advanceTimersByTime(16));
    expect(knobX()).toBeGreaterThan(shown - 1);
  }
  expect(knobX()).toBeCloseTo(TRAVEL, 0);
  // a tick each time it arms
  expect(Haptics.impactAsync).toHaveBeenCalledTimes(2);
});

test('a flick while the knob is still sliding back fires it, and the knob slides on to the end from where it shows, never past it', async () => {
  await renderSwipe();
  const pan = getByGestureTestId('swipe-pan') as unknown as Pan;
  await act(() => pan.handlers.onUpdate({ translationX: TRAVEL }));
  await act(() => jest.advanceTimersByTime(1000));
  await act(() => pan.handlers.onUpdate({ translationX: 100 }));
  await act(() => jest.advanceTimersByTime(16));
  // a flick from 100 pt: it fires, and the knob slides on to the end without overshooting it
  await act(() => pan.handlers.onEnd({ translationX: 100, velocityX: 1200 }, true));
  for (let f = 0; f < 20; f += 1) {
    await act(() => jest.advanceTimersByTime(16));
    expect(knobX()).toBeLessThanOrEqual(TRAVEL + 0.5);
  }
  expect(knobX()).toBeCloseTo(TRAVEL, 0);
  await act(() => jest.advanceTimersByTime(20));
  expect(onSwipe).toHaveBeenCalledTimes(1);
});

test('dragged back a little (inside 24 pt of the point) it stays armed and fires on release', async () => {
  await renderSwipe();
  await drag([TRAVEL, swipeCommitAt(TRAVEL) - SWIPE_DISARM_PT + 4]);
  expect(onSwipe).toHaveBeenCalledTimes(1);
});

test('armed again after a drag back: a second tick, still one swipe', async () => {
  await renderSwipe();
  await drag([TRAVEL, 60, TRAVEL]);
  expect(Haptics.impactAsync).toHaveBeenCalledTimes(2);
  expect(onSwipe).toHaveBeenCalledTimes(1);
});

test('a quick flick past 40 % fires it without arming; slower, or shorter, does nothing', async () => {
  await renderSwipe();
  await drag([50, 100], 1200);
  expect(onSwipe).toHaveBeenCalledTimes(1);
  expect(Haptics.impactAsync).not.toHaveBeenCalled();
  await act(() => jest.advanceTimersByTime(SWIPE_SETTLE_MS));
  await drag([50, 90], 1200);
  await drag([60, 120], 500);
  expect(onSwipe).toHaveBeenCalledTimes(1);
});

test('a short track keeps a deliberate drag: 72 pt at least to arm', async () => {
  // 150 wide: the knob travels 150 − 52 − 12 = 86 pt, so 60 % (52 pt) would be too little.
  await renderSwipe({}, 150);
  await drag([30, 65]);
  expect(onSwipe).not.toHaveBeenCalled();
  await drag([30, 75]);
  expect(onSwipe).toHaveBeenCalledTimes(1);
});

test('the vertical slop: 16 pt by default, wider when asked', async () => {
  const cfg = () => (getByGestureTestId('swipe-pan') as unknown as { config: { failOffsetYStart: number; failOffsetYEnd: number } }).config;
  const r = await renderSwipe();
  expect([cfg().failOffsetYStart, cfg().failOffsetYEnd]).toEqual([-16, 16]);
  await r.unmount();
  await renderSwipe({ verticalSlop: 24 });
  expect([cfg().failOffsetYStart, cfg().failOffsetYEnd]).toEqual([-24, 24]);
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

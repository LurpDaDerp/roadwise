import { act, fireEvent, render, screen } from '@testing-library/react-native';
import { AccessibilityInfo, Dimensions, Text } from 'react-native';

import { ThemeProvider } from '@/ui';

import { CLOSE_SWIPE_DY, SLIDE_MS, WrappedStory } from '../WrappedStory';

const STOPS = ['#04684A', '#065440', '#022A20'] as const;
const SLIDES = ['one', 'two', 'three'].map((id) => ({ id, node: <Text>{`slide ${id}`}</Text> }));
const WIDTH = Dimensions.get('window').width;

async function show(opts: { still?: boolean; onClose?: () => void } = {}) {
  const onClose = opts.onClose ?? jest.fn();
  await render(
    <ThemeProvider scheme="light" reduceMotion={opts.still ?? false}>
      <WrappedStory slides={SLIDES} stops={STOPS} header="Your October" onClose={onClose} />
    </ThemeProvider>
  );
  return onClose;
}

const tapAt = (x: number) => fireEvent.press(screen.getByTestId('wrapped-story-slide'), { nativeEvent: { pageX: x, pageY: 400 } });
const showing = () => screen.getByTestId(/^wrapped-slide-/).props.testID as string;

let reader = false;
beforeEach(() => {
  jest.useFakeTimers();
  reader = false;
  jest.spyOn(AccessibilityInfo, 'isScreenReaderEnabled').mockImplementation(async () => reader);
});
afterEach(() => {
  jest.useRealTimers();
  jest.restoreAllMocks();
});

test('a tap on the right half goes on, on the left half back; never past either end', async () => {
  await show({ still: true });
  expect(showing()).toBe('wrapped-slide-one');
  expect(screen.getByLabelText('Slide 1 of 3')).toBeOnTheScreen();
  expect(screen.getByTestId('wrapped-story-header')).toHaveTextContent('Your October');
  await tapAt(WIDTH - 20);
  expect(showing()).toBe('wrapped-slide-two');
  expect(screen.getByLabelText('Slide 2 of 3')).toBeOnTheScreen();
  await tapAt(WIDTH - 20);
  await tapAt(WIDTH - 20);
  expect(showing()).toBe('wrapped-slide-three');
  await tapAt(20);
  expect(showing()).toBe('wrapped-slide-two');
  await tapAt(20);
  await tapAt(20);
  expect(showing()).toBe('wrapped-slide-one');
});

test('it plays on its own, a slide every 6 s, and stays on the last', async () => {
  await show();
  await act(async () => {
    await jest.advanceTimersByTimeAsync(SLIDE_MS - 100);
  });
  expect(showing()).toBe('wrapped-slide-one');
  await act(async () => {
    await jest.advanceTimersByTimeAsync(200);
  });
  expect(showing()).toBe('wrapped-slide-two');
  // The next slide gets its own full 6 s.
  await act(async () => {
    await jest.advanceTimersByTimeAsync(SLIDE_MS - 300);
  });
  expect(showing()).toBe('wrapped-slide-two');
  await act(async () => {
    await jest.advanceTimersByTimeAsync(SLIDE_MS * 3);
  });
  expect(showing()).toBe('wrapped-slide-three');
});

test('a tap gives the slide it lands on a full 6 s', async () => {
  await show();
  await act(async () => {
    await jest.advanceTimersByTimeAsync(SLIDE_MS - 1000);
  });
  await tapAt(WIDTH - 20);
  expect(showing()).toBe('wrapped-slide-two');
  await act(async () => {
    await jest.advanceTimersByTimeAsync(SLIDE_MS - 300);
  });
  expect(showing()).toBe('wrapped-slide-two');
  await act(async () => {
    await jest.advanceTimersByTimeAsync(400);
  });
  expect(showing()).toBe('wrapped-slide-three');
});

test('holding pauses it; letting go plays on from where it was, and the release is not a tap', async () => {
  await show();
  await act(async () => {
    await jest.advanceTimersByTimeAsync(SLIDE_MS / 2);
  });
  await fireEvent(screen.getByTestId('wrapped-story-slide'), 'longPress');
  await act(async () => {
    await jest.advanceTimersByTimeAsync(SLIDE_MS * 2);
  });
  expect(showing()).toBe('wrapped-slide-one');
  await fireEvent(screen.getByTestId('wrapped-story-slide'), 'pressOut');
  await fireEvent.press(screen.getByTestId('wrapped-story-slide'), { nativeEvent: { pageX: 20, pageY: 400 } });
  expect(showing()).toBe('wrapped-slide-one');
  await act(async () => {
    await jest.advanceTimersByTimeAsync(SLIDE_MS / 2 + 100);
  });
  expect(showing()).toBe('wrapped-slide-two');
});

test('under Reduce Motion it never moves on its own', async () => {
  await show({ still: true });
  await act(async () => {
    await jest.advanceTimersByTimeAsync(SLIDE_MS * 3);
  });
  expect(showing()).toBe('wrapped-slide-one');
});

test('with a screen reader on: no playing on its own, and Back and Next buttons', async () => {
  reader = true;
  await show();
  await act(async () => {
    await jest.advanceTimersByTimeAsync(0);
  });
  expect(screen.getByTestId('wrapped-story-back')).toBeDisabled();
  await act(async () => {
    await jest.advanceTimersByTimeAsync(SLIDE_MS * 2);
  });
  expect(showing()).toBe('wrapped-slide-one');
  await fireEvent.press(screen.getByTestId('wrapped-story-next'));
  expect(showing()).toBe('wrapped-slide-two');
  await fireEvent.press(screen.getByTestId('wrapped-story-back'));
  expect(showing()).toBe('wrapped-slide-one');
});

test('✕ closes it, and so does a swipe down (a short one does not)', async () => {
  const onClose = await show({ still: true });
  await fireEvent.press(screen.getByTestId('wrapped-story-close'));
  expect(onClose).toHaveBeenCalledTimes(1);

  const root = screen.getByTestId('wrapped-story');
  const at = (y: number, x = 200) => ({ nativeEvent: { pageX: x, pageY: y } });
  const swipe = async (dy: number, dx = 0) => {
    await act(async () => {
      root.props.onStartShouldSetResponderCapture(at(100));
      expect(root.props.onMoveShouldSetResponderCapture(at(100 + dy, 200 + dx))).toBe(dy > 12 && dy > 2 * Math.abs(dx));
      root.props.onResponderRelease(at(100 + dy, 200 + dx));
    });
  };
  await swipe(CLOSE_SWIPE_DY + 10);
  expect(onClose).toHaveBeenCalledTimes(2);
  await swipe(40);
  expect(onClose).toHaveBeenCalledTimes(2);
  // Sideways is not a swipe down.
  expect(root.props.onMoveShouldSetResponderCapture(at(160, 400))).toBe(false);
});

test('while it plays, a back-tap on the first slide leaves it running: its time so far still counts', async () => {
  await show();
  const wait = async (ms: number) => {
    await act(async () => {
      await jest.advanceTimersByTimeAsync(ms);
    });
  };
  const hold = async () => {
    await fireEvent(screen.getByTestId('wrapped-story-slide'), 'longPress');
    await wait(SLIDE_MS);
    await fireEvent(screen.getByTestId('wrapped-story-slide'), 'pressOut');
    await wait(0);
  };
  // 2 s, a pause, 1 s, a back-tap, 1 s, a pause: 4 s shown, 2 s left.
  await wait(2000);
  await hold();
  await wait(1000);
  await tapAt(20);
  expect(showing()).toBe('wrapped-slide-one');
  await wait(1000);
  await hold();
  await wait(1900);
  expect(showing()).toBe('wrapped-slide-one');
  await wait(200);
  expect(showing()).toBe('wrapped-slide-two');
});

/**
 * Screen readers on the driving screen's parts: the waiting panel's countdown is read once per
 * phase on both platforms, and "Not driving?" acts on a screen reader's first double-tap even
 * while the screen is dimmed.
 */
import { act, fireEvent, render, screen } from '@testing-library/react-native';
import { AccessibilityInfo, Platform } from 'react-native';

import { hudPalette } from '@/ui/drive';

import { hudCopy } from '../hudCopy';
import { NotDrivingLink } from '../NotDrivingLink';
import { WaitPanel } from '../WaitPanel';

const COLORS = { surface: '#FFFFFF', ink: '#111113', muted: '#5C5C66', edge: '#D9D9DE' };
/** 4:30 into a 5-minute wait: the countdown's 30 s. */
const COUNTDOWN_AT = 270_000;

describe('the waiting panel’s countdown', () => {
  let say: jest.SpyInstance;
  beforeEach(() => {
    jest.useFakeTimers();
    jest.clearAllMocks();
    say = jest.spyOn(AccessibilityInfo, 'announceForAccessibility').mockImplementation(() => {});
  });
  afterEach(() => {
    jest.useRealTimers();
    jest.restoreAllMocks();
  });

  async function countdown() {
    const now = Date.now();
    await render(
      <WaitPanel
        waiting={{ phase: 'countdown', since: now - COUNTDOWN_AT, deadlineAt: now + 30_000 }}
        colors={COLORS}
        height={320}
        onKeep={jest.fn()}
        onCancel={jest.fn()}
      />
    );
  }

  for (const os of ['ios', 'android'] as const) {
    it(`${os}: read once as it opens, not every second; the block still says the time left when a screen reader moves onto it`, async () => {
      const restore = jest.replaceProperty(Platform, 'OS', os);
      try {
        await countdown();
        const block = screen.getByLabelText(hudCopy.countdown.spoken(30));
        // A live region would have TalkBack read the label again each time it changes, every second.
        expect(block.props.accessibilityLiveRegion).toBeUndefined();
        await act(async () => {
          jest.advanceTimersByTime(3000);
        });
        expect(screen.getByLabelText(hudCopy.countdown.spoken(27))).toBeOnTheScreen();
        expect(screen.getByLabelText(hudCopy.countdown.spoken(27)).props.accessibilityLiveRegion).toBeUndefined();
        expect(say).toHaveBeenCalledTimes(1);
        expect(say).toHaveBeenCalledWith(hudCopy.countdown.spoken(30));
      } finally {
        restore.restore();
      }
    });
  }
});

describe('"Not driving?"', () => {
  const link = () => screen.getByTestId('hud-not-driving');

  it('a screen reader’s double-tap (VoiceOver’s accessibilityTap) acts at once, even on a dimmed screen', async () => {
    const onPress = jest.fn();
    await render(<NotDrivingLink palette={hudPalette(false)} dimmed onPress={onPress} />);
    await fireEvent(link(), 'accessibilityTap');
    expect(onPress).toHaveBeenCalledTimes(1);
  });

  it('a touch that starts on a dimmed screen still only wakes it; awake, a touch counts', async () => {
    const onPress = jest.fn();
    const view = await render(<NotDrivingLink palette={hudPalette(false)} dimmed onPress={onPress} />);
    await fireEvent(link(), 'pressIn');
    await fireEvent.press(link());
    expect(onPress).not.toHaveBeenCalled();
    await view.rerender(<NotDrivingLink palette={hudPalette(false)} dimmed={false} onPress={onPress} />);
    await fireEvent(link(), 'pressIn');
    await fireEvent.press(link());
    expect(onPress).toHaveBeenCalledTimes(1);
  });
});

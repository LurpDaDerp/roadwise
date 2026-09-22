import { act, fireEvent, render, screen } from '@testing-library/react-native';
import { AccessibilityInfo, StyleSheet } from 'react-native';

import { hudCopy } from '../hudCopy';
import { STOPPED_ACTION_DELAY_MS, StoppedPanel, type StoppedPanelProps } from '../StoppedPanel';

function props(over: Partial<StoppedPanelProps> = {}): StoppedPanelProps {
  return {
    visible: true,
    passenger: false,
    mutedForDrive: false,
    night: false,
    reduceMotion: true,
    onEnd: jest.fn(),
    onMuteForDrive: jest.fn(),
    onSetPassenger: jest.fn(),
    ...over,
  };
}

beforeEach(() => {
  jest.useFakeTimers();
});
afterEach(() => {
  jest.useRealTimers();
  jest.restoreAllMocks();
});

describe('StoppedPanel (C6)', () => {
  test('offers End drive first, the drive mute and the driver swap, each at least 64 pt tall', async () => {
    await render(<StoppedPanel {...props()} />);
    const labels = [
      hudCopy.stopped.endDrive,
      hudCopy.stopped.muteDrive,
      hudCopy.stopped.passengerNow,
    ];
    for (const label of labels) {
      const button = screen.getByRole('button', { name: label });
      const style = StyleSheet.flatten(button.props.style);
      expect(style.minHeight).toBeGreaterThanOrEqual(64);
    }
    const all = screen.getAllByRole('button').map((b) => b.props.accessibilityLabel);
    expect(all[0]).toBe(hudCopy.stopped.endDrive);
  });

  test('a passenger is offered "I\'m driving now"', async () => {
    const p = props({ passenger: true });
    await render(<StoppedPanel {...p} />);
    expect(screen.queryByRole('button', { name: hudCopy.stopped.passengerNow })).toBeNull();
    await fireEvent.press(screen.getByRole('button', { name: hudCopy.stopped.drivingNow }));
    await act(() => jest.advanceTimersByTime(STOPPED_ACTION_DELAY_MS));
    expect(p.onSetPassenger).toHaveBeenCalledWith(false);
  });

  test('renders nothing while hidden', async () => {
    await render(<StoppedPanel {...props({ visible: false })} />);
    expect(screen.queryByRole('button')).toBeNull();
  });

  test('announces "Vehicle stopped. End drive button." as it appears', async () => {
    // React Native's Jest setup already mocks it, so the spy may carry earlier suites' calls.
    const spy = jest.spyOn(AccessibilityInfo, 'announceForAccessibility');
    spy.mockClear();
    const p = props({ visible: false });
    const { rerender } = await render(<StoppedPanel {...p} />);
    expect(spy).not.toHaveBeenCalled();
    await rerender(<StoppedPanel {...p} visible />);
    expect(spy).toHaveBeenCalledWith('Vehicle stopped. End drive button.');
    expect(spy).toHaveBeenCalledTimes(1);
  });

  test('an action runs 300 ms after the tap, not at once', async () => {
    const p = props();
    await render(<StoppedPanel {...p} />);
    await fireEvent.press(screen.getByRole('button', { name: hudCopy.stopped.endDrive }));
    expect(p.onEnd).not.toHaveBeenCalled();
    await act(() => jest.advanceTimersByTime(STOPPED_ACTION_DELAY_MS - 1));
    expect(p.onEnd).not.toHaveBeenCalled();
    await act(() => jest.advanceTimersByTime(1));
    expect(p.onEnd).toHaveBeenCalledTimes(1);
  });

  test('a tap in the last 300 ms before the panel hides is discarded', async () => {
    const p = props();
    const { rerender } = await render(<StoppedPanel {...p} />);
    await fireEvent.press(screen.getByRole('button', { name: hudCopy.stopped.endDrive }));
    await act(() => jest.advanceTimersByTime(200));
    await rerender(<StoppedPanel {...p} visible={false} />);
    await act(() => jest.advanceTimersByTime(1000));
    expect(p.onEnd).not.toHaveBeenCalled();
    // Showing again does not replay the discarded tap.
    await rerender(<StoppedPanel {...p} visible />);
    await act(() => jest.advanceTimersByTime(1000));
    expect(p.onEnd).not.toHaveBeenCalled();
  });

  test('a second tap while one is pending does not queue a second action', async () => {
    const p = props();
    await render(<StoppedPanel {...p} />);
    await fireEvent.press(screen.getByRole('button', { name: hudCopy.stopped.endDrive }));
    await fireEvent.press(screen.getByRole('button', { name: hudCopy.stopped.muteDrive }));
    await act(() => jest.advanceTimersByTime(1000));
    expect(p.onEnd).toHaveBeenCalledTimes(1);
    expect(p.onMuteForDrive).not.toHaveBeenCalled();
  });

  test('mute for this drive, then the button says the drive is muted and is disabled', async () => {
    const p = props();
    const { rerender } = await render(<StoppedPanel {...p} />);
    await fireEvent.press(screen.getByRole('button', { name: hudCopy.stopped.muteDrive }));
    await act(() => jest.advanceTimersByTime(STOPPED_ACTION_DELAY_MS));
    expect(p.onMuteForDrive).toHaveBeenCalledTimes(1);
    await rerender(<StoppedPanel {...p} mutedForDrive />);
    const muted = screen.getByRole('button', { name: hudCopy.stopped.mutedDrive });
    expect(muted.props.accessibilityState).toMatchObject({ disabled: true });
    await fireEvent.press(muted);
    await act(() => jest.advanceTimersByTime(1000));
    expect(p.onMuteForDrive).toHaveBeenCalledTimes(1);
  });

  test('passenger now', async () => {
    const p = props();
    await render(<StoppedPanel {...p} />);
    await fireEvent.press(screen.getByRole('button', { name: hudCopy.stopped.passengerNow }));
    await act(() => jest.advanceTimersByTime(STOPPED_ACTION_DELAY_MS));
    expect(p.onSetPassenger).toHaveBeenCalledWith(true);
  });

  test('unmounting with a tap pending runs nothing', async () => {
    const p = props();
    const { unmount } = await render(<StoppedPanel {...p} />);
    await fireEvent.press(screen.getByRole('button', { name: hudCopy.stopped.endDrive }));
    await unmount();
    await act(() => jest.advanceTimersByTime(1000));
    expect(p.onEnd).not.toHaveBeenCalled();
  });
});

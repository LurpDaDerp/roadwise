import { act, render, screen } from '@testing-library/react-native';
import { AccessibilityInfo, Text } from 'react-native';

import { useOsReduceMotion } from '../theme';

function Probe() {
  return <Text testID="still">{String(useOsReduceMotion())}</Text>;
}

type Listener = (on: boolean) => void;

describe('useOsReduceMotion', () => {
  let listeners: Listener[];
  let removed: number;

  beforeEach(() => {
    listeners = [];
    removed = 0;
    jest.spyOn(AccessibilityInfo, 'addEventListener').mockImplementation(((_event: string, fn: Listener) => {
      listeners.push(fn);
      return { remove: () => (removed += 1) };
    }) as unknown as typeof AccessibilityInfo.addEventListener);
  });
  afterEach(() => jest.restoreAllMocks());

  test('starts from the OS read and follows a change made while mounted', async () => {
    jest.spyOn(AccessibilityInfo, 'isReduceMotionEnabled').mockResolvedValue(false);
    const r = await render(<Probe />);
    await act(async () => {});
    expect(screen.getByTestId('still')).toHaveTextContent('false');
    await act(async () => listeners.forEach((fn) => fn(true)));
    expect(screen.getByTestId('still')).toHaveTextContent('true');
    await act(async () => listeners.forEach((fn) => fn(false)));
    expect(screen.getByTestId('still')).toHaveTextContent('false');
    await r.unmount();
    expect(removed).toBe(1);
  });

  test('an OS read of on applies', async () => {
    jest.spyOn(AccessibilityInfo, 'isReduceMotionEnabled').mockResolvedValue(true);
    await render(<Probe />);
    await act(async () => {});
    expect(screen.getByTestId('still')).toHaveTextContent('true');
  });

  test('a failed OS read keeps the first value', async () => {
    jest.spyOn(AccessibilityInfo, 'isReduceMotionEnabled').mockRejectedValue(new Error('no'));
    await render(<Probe />);
    await act(async () => {});
    expect(screen.getByTestId('still')).toHaveTextContent('false');
  });
});

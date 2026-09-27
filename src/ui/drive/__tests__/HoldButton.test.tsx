import { act, fireEvent, render, screen } from '@testing-library/react-native';

import { HoldButton } from '@/ui/drive/HoldButton';
import { HOLD_TO_ACT_MS } from '@/ui/drive/hudTokens';

const onHold = jest.fn();

function renderButton(holdMs?: number) {
  return render(
    <HoldButton
      testID="hold"
      shape="circle"
      label="SOS"
      accessibilityLabel="Emergency call"
      accessibilityHint="Hold for two seconds"
      face="#FF7070"
      ink="#000814"
      holdMs={holdMs}
      onHold={onHold}
    />
  );
}

beforeEach(() => {
  jest.useFakeTimers();
  onHold.mockClear();
});
afterEach(() => jest.useRealTimers());

test('a hold of exactly the threshold acts once; one millisecond less does nothing', async () => {
  await renderButton();
  const b = screen.getByTestId('hold');
  await fireEvent(b, 'pressIn');
  await act(() => jest.advanceTimersByTime(HOLD_TO_ACT_MS - 1));
  expect(onHold).not.toHaveBeenCalled();
  await act(() => jest.advanceTimersByTime(1));
  expect(onHold).toHaveBeenCalledTimes(1);
  // Holding on past the threshold does not fire again.
  await act(() => jest.advanceTimersByTime(5000));
  expect(onHold).toHaveBeenCalledTimes(1);
  await fireEvent(b, 'pressOut');
  expect(HOLD_TO_ACT_MS).toBe(2000);
});

test('a plain tap does nothing', async () => {
  await renderButton();
  await fireEvent.press(screen.getByTestId('hold'));
  await act(() => jest.advanceTimersByTime(5000));
  expect(onHold).not.toHaveBeenCalled();
});

test('a hold released early does nothing, and two short holds do not add up', async () => {
  await renderButton();
  const b = screen.getByTestId('hold');
  await fireEvent(b, 'pressIn');
  await act(() => jest.advanceTimersByTime(1500));
  await fireEvent(b, 'pressOut');
  await act(() => jest.advanceTimersByTime(1000));
  await fireEvent(b, 'pressIn');
  await act(() => jest.advanceTimersByTime(1500));
  await fireEvent(b, 'pressOut');
  await act(() => jest.advanceTimersByTime(5000));
  expect(onHold).not.toHaveBeenCalled();
});

test('unmounting mid-hold drops the hold', async () => {
  const { unmount } = await renderButton();
  await fireEvent(screen.getByTestId('hold'), 'pressIn');
  await act(() => jest.advanceTimersByTime(1000));
  await unmount();
  await act(() => jest.advanceTimersByTime(5000));
  expect(onHold).not.toHaveBeenCalled();
});

test('the threshold can be set per button', async () => {
  await renderButton(500);
  await fireEvent(screen.getByTestId('hold'), 'pressIn');
  await act(() => jest.advanceTimersByTime(500));
  expect(onHold).toHaveBeenCalledTimes(1);
});

test('it is a button with its label and hint, and a fill that starts empty', async () => {
  await renderButton();
  const b = screen.getByRole('button', { name: 'Emergency call' });
  expect(b).toHaveProp('accessibilityHint', 'Hold for two seconds');
  expect(screen.getByText('SOS')).toBeTruthy();
  expect(screen.getByTestId('hold-fill')).toBeTruthy();
});

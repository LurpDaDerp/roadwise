import { act, fireEvent, render, screen } from '@testing-library/react-native';
import * as Haptics from 'expo-haptics';

import { HoldButton } from '@/ui/drive/HoldButton';
import { HOLD_TO_END_MS, HUD_MIN_TARGET_PT } from '@/ui/drive/hudTokens';

jest.mock('expo-haptics', () => ({
  impactAsync: jest.fn(async () => {}),
  ImpactFeedbackStyle: { Light: 'light', Medium: 'medium', Heavy: 'heavy' },
}));

const onHold = jest.fn();

function renderButton(props: { disabled?: boolean } = {}) {
  return render(
    <HoldButton
      testID="hold"
      label="End"
      accessibilityLabel="End drive"
      face="#001D3D"
      ink="#F3F6FB"
      ring="#F3F6FB"
      track="#003566"
      onHold={onHold}
      {...props}
    />
  );
}

beforeEach(() => {
  jest.useFakeTimers();
  jest.clearAllMocks();
});
afterEach(() => jest.useRealTimers());

test('the hold is 0.5 s', () => {
  expect(HOLD_TO_END_MS).toBe(500);
});

test('a full hold acts once, with one haptic tick, as the ring closes', async () => {
  await renderButton();
  const b = screen.getByTestId('hold');
  await fireEvent(b, 'pressIn');
  await act(() => jest.advanceTimersByTime(HOLD_TO_END_MS - 1));
  expect(onHold).not.toHaveBeenCalled();
  expect(Haptics.impactAsync).not.toHaveBeenCalled();
  await act(() => jest.advanceTimersByTime(1));
  expect(onHold).toHaveBeenCalledTimes(1);
  expect(Haptics.impactAsync).toHaveBeenCalledTimes(1);
  await act(() => jest.advanceTimersByTime(5000));
  expect(onHold).toHaveBeenCalledTimes(1);
});

test('letting go early cancels: nothing fires, and the next hold starts from empty', async () => {
  await renderButton();
  const b = screen.getByTestId('hold');
  await fireEvent(b, 'pressIn');
  await act(() => jest.advanceTimersByTime(HOLD_TO_END_MS - 100));
  await fireEvent(b, 'pressOut');
  await act(() => jest.advanceTimersByTime(5000));
  expect(onHold).not.toHaveBeenCalled();
  expect(Haptics.impactAsync).not.toHaveBeenCalled();

  await fireEvent(b, 'pressIn');
  await act(() => jest.advanceTimersByTime(HOLD_TO_END_MS - 1));
  expect(onHold).not.toHaveBeenCalled();
  await act(() => jest.advanceTimersByTime(1));
  expect(onHold).toHaveBeenCalledTimes(1);
});

test('disabled: a hold does nothing', async () => {
  await renderButton({ disabled: true });
  await fireEvent(screen.getByTestId('hold'), 'pressIn');
  await act(() => jest.advanceTimersByTime(HOLD_TO_END_MS * 2));
  expect(onHold).not.toHaveBeenCalled();
  expect(screen.getByRole('button', { name: 'End drive' })).toBeDisabled();
});

test('unmounting mid-hold fires nothing', async () => {
  const { unmount } = await renderButton();
  await fireEvent(screen.getByTestId('hold'), 'pressIn');
  await act(() => unmount());
  await act(() => jest.advanceTimersByTime(HOLD_TO_END_MS * 2));
  expect(onHold).not.toHaveBeenCalled();
});

test('a screen reader activate acts straight away', async () => {
  await renderButton();
  await fireEvent(screen.getByTestId('hold'), 'accessibilityAction', { nativeEvent: { actionName: 'activate' } });
  expect(onHold).toHaveBeenCalledTimes(1);
});

test('the target is at least the in-car 64 pt', async () => {
  await renderButton();
  const style = screen.getByTestId('hold').props.style as { width: number; height: number };
  expect(style.width).toBeGreaterThanOrEqual(HUD_MIN_TARGET_PT);
  expect(style.height).toBeGreaterThanOrEqual(HUD_MIN_TARGET_PT);
});

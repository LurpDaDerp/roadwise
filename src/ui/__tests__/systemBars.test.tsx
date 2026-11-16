// The Android navigation bar's button ink (src/ui/systemBars.ts): last mounted wins, a covered
// screen's change waits until it is uncovered, and iPhone never loads or calls anything.
import { render } from '@testing-library/react-native';
import { Platform } from 'react-native';

import { resetNavigationBarInkForTests, useNavigationBarInk, windowTopOnScreen, type BarInk } from '../systemBars';

const mockSet = jest.fn(async (_ink: string) => {});
const mockWindowTop = jest.fn(async (): Promise<unknown> => 0);
const mockRequire = jest.fn((_name: string): unknown => ({ setNavigationBarInk: mockSet, windowTopOnScreen: mockWindowTop }));
jest.mock('expo-modules-core', () => ({
  ...jest.requireActual('expo-modules-core'),
  requireOptionalNativeModule: (name: string) => mockRequire(name),
}));

function Bar({ ink }: { ink: BarInk }) {
  useNavigationBarInk(ink);
  return null;
}

let restore: (() => void) | null = null;
beforeEach(() => {
  resetNavigationBarInkForTests();
  mockSet.mockClear();
  mockWindowTop.mockClear();
  mockRequire.mockClear();
});
afterEach(() => {
  restore?.();
  restore = null;
});

test('iPhone: nothing is loaded or called', async () => {
  restore = jest.replaceProperty(Platform, 'OS', 'ios').restore;
  await render(<Bar ink="light" />);
  expect(mockRequire).not.toHaveBeenCalled();
  expect(mockSet).not.toHaveBeenCalled();
});

test('Android: the root follows the scheme, a screen on top holds its own ink, and unmounting hands back', async () => {
  restore = jest.replaceProperty(Platform, 'OS', 'android').restore;
  const view = await render(<Bar ink="dark" />);
  expect(mockRequire).toHaveBeenCalledWith('RoadWiseSystemBars');
  expect(mockSet.mock.calls).toEqual([['dark']]);

  // the driving screen opens over it
  await view.rerender(
    <>
      <Bar ink="dark" />
      <Bar ink="light" />
    </>
  );
  expect(mockSet.mock.calls).toEqual([['dark'], ['light']]);

  // the scheme changes underneath, twice: kept for later, the driving screen's ink stays
  await view.rerender(
    <>
      <Bar ink="light" />
      <Bar ink="light" />
    </>
  );
  await view.rerender(
    <>
      <Bar ink="dark" />
      <Bar ink="light" />
    </>
  );
  expect(mockSet.mock.calls).toEqual([['dark'], ['light']]);

  // the driving screen closes: the root's ink (dark) comes back
  await view.rerender(<Bar ink="dark" />);
  expect(mockSet.mock.calls).toEqual([['dark'], ['light'], ['dark']]);

  // a change of scheme with nothing on top applies at once
  await view.rerender(<Bar ink="light" />);
  expect(mockSet.mock.calls).toEqual([['dark'], ['light'], ['dark'], ['light']]);
});

test('Android without the native half (an older build): nothing breaks', async () => {
  restore = jest.replaceProperty(Platform, 'OS', 'android').restore;
  mockRequire.mockImplementationOnce(() => null);
  await render(<Bar ink="light" />);
  expect(mockSet).not.toHaveBeenCalled();
});

describe('windowTopOnScreen, the keyboard lift window offset', () => {
  test('iPhone: 0, nothing loaded or called', async () => {
    restore = jest.replaceProperty(Platform, 'OS', 'ios').restore;
    await expect(windowTopOnScreen()).resolves.toBe(0);
    expect(mockRequire).not.toHaveBeenCalled();
  });

  test('Android: the native answer, in points', async () => {
    restore = jest.replaceProperty(Platform, 'OS', 'android').restore;
    mockWindowTop.mockResolvedValueOnce(412.5);
    await expect(windowTopOnScreen()).resolves.toBe(412.5);
    expect(mockWindowTop).toHaveBeenCalledTimes(1);
  });

  test('Android: a failed call, a junk answer or no native half reads as full screen (0)', async () => {
    restore = jest.replaceProperty(Platform, 'OS', 'android').restore;
    mockWindowTop.mockRejectedValueOnce(new Error('no activity'));
    await expect(windowTopOnScreen()).resolves.toBe(0);
    mockWindowTop.mockResolvedValueOnce(Number.NaN);
    await expect(windowTopOnScreen()).resolves.toBe(0);
    resetNavigationBarInkForTests();
    mockRequire.mockImplementationOnce(() => ({ setNavigationBarInk: mockSet }));
    await expect(windowTopOnScreen()).resolves.toBe(0);
    resetNavigationBarInkForTests();
    mockRequire.mockImplementationOnce(() => null);
    await expect(windowTopOnScreen()).resolves.toBe(0);
  });
});

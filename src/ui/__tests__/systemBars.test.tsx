// The Android navigation bar's button ink (src/ui/systemBars.ts): last mounted wins, a covered
// screen's change waits until it is uncovered, and iPhone never loads or calls anything.
import { render } from '@testing-library/react-native';
import { Platform } from 'react-native';

import { resetNavigationBarInkForTests, useNavigationBarInk, type BarInk } from '../systemBars';

const mockSet = jest.fn(async (_ink: string) => {});
const mockRequire = jest.fn((_name: string): unknown => ({ setNavigationBarInk: mockSet }));
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

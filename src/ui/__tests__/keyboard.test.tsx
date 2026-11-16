// The Android keyboard lift (src/ui/keyboard.ts): measured against the keyboard's top on each
// keyboard change (moved into the window's coordinates first), 0 when it hides, and never
// subscribed on iPhone.
import { act, renderHook } from '@testing-library/react-native';
import { Keyboard, Platform, type View } from 'react-native';

import { keyboardLift, useKeyboardLift } from '../keyboard';

let mockWindowTop = 0;
const mockWindowTopOnScreen = jest.fn(async () => mockWindowTop);
jest.mock('../systemBars', () => ({ windowTopOnScreen: () => mockWindowTopOnScreen() }));

type Handler = (e: { endCoordinates: { screenY: number; height: number } }) => void;
let handlers: Record<string, Handler[]>;
let restore: (() => void)[] = [];

beforeEach(() => {
  mockWindowTop = 0;
  mockWindowTopOnScreen.mockClear();
  handlers = {};
  jest.spyOn(Keyboard, 'addListener').mockImplementation(((name: string, fn: Handler) => {
    (handlers[name] ??= []).push(fn);
    return {
      remove: () => {
        handlers[name] = (handlers[name] ?? []).filter((h) => h !== fn);
      },
    };
  }) as never);
});
afterEach(() => {
  jest.restoreAllMocks();
  restore.forEach((r) => r());
  restore = [];
});

const emit = (name: string, screenY = 0) => handlers[name]?.forEach((h) => h({ endCoordinates: { screenY, height: 0 } }));
const viewAt = (y: number, h: number) => ({
  current: { measureInWindow: (cb: (x: number, y: number, w: number, h: number) => void) => cb(0, y, 400, h) } as unknown as View,
});

test('the overlap is the view bottom below the keyboard top, never negative', () => {
  expect(keyboardLift(800, 500)).toBe(300);
  expect(keyboardLift(400, 500)).toBe(0);
  expect(keyboardLift(Number.NaN, 500)).toBe(0);
});

test('the keyboard top (screen) is moved into the window before it is compared', () => {
  // a split-screen bottom pane starting 400 pt down: keyboard top 900 on screen is 500 in the window
  expect(keyboardLift(800, 900, 400)).toBe(300);
  expect(keyboardLift(800, 900, Number.NaN)).toBe(0);
});

test('iPhone: no listener, always 0', async () => {
  restore.push(jest.replaceProperty(Platform, 'OS', 'ios').restore);
  const ref = viewAt(0, 800);
  const { result } = await renderHook(() => useKeyboardLift(ref));
  expect(Keyboard.addListener).not.toHaveBeenCalled();
  expect(mockWindowTopOnScreen).not.toHaveBeenCalled();
  expect(result.current).toBe(0);
});

test('Android: lifts by the measured overlap and drops to 0 when the keyboard hides', async () => {
  restore.push(jest.replaceProperty(Platform, 'OS', 'android').restore);
  const ref = viewAt(40, 760); // bottom at 800
  const { result, unmount } = await renderHook(() => useKeyboardLift(ref));
  expect(result.current).toBe(0);
  await act(async () => emit('keyboardDidShow', 520));
  expect(result.current).toBe(280);
  // the emoji panel makes it taller
  await act(async () => emit('keyboardDidShow', 470));
  expect(result.current).toBe(330);
  await act(async () => emit('keyboardDidHide'));
  expect(result.current).toBe(0);
  await unmount();
  expect(handlers.keyboardDidShow).toEqual([]);
  expect(handlers.keyboardDidHide).toEqual([]);
});

test('Android: a view already above the keyboard (a resized window) is not lifted', async () => {
  restore.push(jest.replaceProperty(Platform, 'OS', 'android').restore);
  const ref = viewAt(0, 500);
  const { result } = await renderHook(() => useKeyboardLift(ref));
  await act(async () => emit('keyboardDidShow', 520));
  expect(result.current).toBe(0);
});

test("Android in split screen's bottom pane: the window's offset is taken off the keyboard's top", async () => {
  restore.push(jest.replaceProperty(Platform, 'OS', 'android').restore);
  mockWindowTop = 400; // the pane starts 400 pt down the screen
  const ref = viewAt(40, 560); // bottom at 600 in the window
  const { result } = await renderHook(() => useKeyboardLift(ref));
  await act(async () => emit('keyboardDidShow', 750)); // 350 in the window
  expect(mockWindowTopOnScreen).toHaveBeenCalledTimes(1);
  expect(result.current).toBe(250);
});

test('Android: a hide that lands before the window offset does keeps the lift at 0', async () => {
  restore.push(jest.replaceProperty(Platform, 'OS', 'android').restore);
  let release: (top: number) => void = () => {};
  mockWindowTopOnScreen.mockImplementationOnce(() => new Promise<number>((r) => (release = r)));
  const ref = viewAt(40, 760);
  const { result } = await renderHook(() => useKeyboardLift(ref));
  await act(async () => emit('keyboardDidShow', 520));
  await act(async () => emit('keyboardDidHide'));
  await act(async () => release(0));
  expect(result.current).toBe(0);
});

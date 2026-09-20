import { FONT_WAIT_MS, shouldRender } from '@/ui/fonts';

test('holds the splash while the licence faces are still loading', () => {
  expect(shouldRender({ loaded: false, error: null, timedOut: false })).toBe(false);
});

test('draws once the faces are in memory', () => {
  expect(shouldRender({ loaded: true, error: null, timedOut: false })).toBe(true);
});

test('draws on a font error rather than stranding the app on the splash', () => {
  expect(shouldRender({ loaded: false, error: new Error('decode failed'), timedOut: false })).toBe(
    true
  );
});

test('draws when the wait has run long enough to read as a hang', () => {
  expect(shouldRender({ loaded: false, error: null, timedOut: true })).toBe(true);
});

test('the wait is short enough to be one beat, not a stall', () => {
  expect(FONT_WAIT_MS).toBeLessThanOrEqual(3000);
});

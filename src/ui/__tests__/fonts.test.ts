import { FONT_FACE_NAMES, fontFamilies, FONT_WAIT_MS, shouldRender } from '@/ui/fonts';
import { tokens } from '@/ui/tokens';

test('holds the splash while the display faces are still loading', () => {
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

test('every bundled family a style names is a face the loader registers', () => {
  const named = new Set([
    ...Object.values(tokens.type).map((s) => s.fontFamily),
    ...Object.entries(fontFamilies)
      .filter(([k]) => k !== 'ui')
      .map(([, v]) => v),
  ]);
  named.delete(fontFamilies.ui);
  for (const family of named) expect(FONT_FACE_NAMES).toContain(family);
});

test('only the weights in use are loaded', () => {
  expect(FONT_FACE_NAMES.length).toBeLessThanOrEqual(4);
});

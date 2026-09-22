import { prefillName } from '@/features/auth/prefillName';

const user = (user_metadata: Record<string, unknown>) => ({ user_metadata });

test('no user, or no metadata, prefills nothing', () => {
  expect(prefillName(null)).toBe('');
  expect(prefillName(undefined)).toBe('');
  expect(prefillName({})).toBe('');
  expect(prefillName(user({}))).toBe('');
});

test('display_name wins, then full_name, then name', () => {
  expect(prefillName(user({ display_name: 'Ava', full_name: 'Ava Stone', name: 'A. Stone' }))).toBe('Ava');
  expect(prefillName(user({ full_name: 'Ava Stone', name: 'A. Stone' }))).toBe('Ava Stone');
  expect(prefillName(user({ name: 'A. Stone' }))).toBe('A. Stone');
});

test('a candidate that is empty once cleaned falls through to the next', () => {
  expect(prefillName(user({ display_name: '  \u200B\u202E ', full_name: 'Ava Stone' }))).toBe('Ava Stone');
  expect(prefillName(user({ display_name: 42, full_name: null, name: 'Ava' }))).toBe('Ava');
});

test('strips control, bidi and zero-width characters (the bidi fixture)', () => {
  // U+202E RIGHT-TO-LEFT OVERRIDE would render "Ava" + "gpj.exe" reversed; U+2066..U+2069 are the
  // isolates, U+200B..U+200F zero-width and marks, U+FEFF a byte-order mark, U+0007 a bell.
  expect(prefillName(user({ display_name: 'Ava\u202Eexe.gpj' }))).toBe('Avaexe.gpj');
  expect(prefillName(user({ display_name: '\u2066Ava\u2069 \u200BStone\u200F\uFEFF\u0007' }))).toBe('Ava Stone');
  expect(prefillName(user({ display_name: '\u061CAva\u200E' }))).toBe('Ava');
});

test('line breaks and tabs become one space, and runs of space collapse', () => {
  expect(prefillName(user({ full_name: ' Ava\n\tStone\u2028Jr  ' }))).toBe('Ava Stone Jr');
});

test('caps at 40 characters counted as the database counts them, never splitting a character', () => {
  const long = 'A'.repeat(45);
  expect(prefillName(user({ display_name: long }))).toBe('A'.repeat(40));
  // 39 letters then an emoji (two UTF-16 units, one code point): 40 code points, kept whole.
  const emoji = 'B'.repeat(39) + '\u{1F697}' + 'CC';
  expect(prefillName(user({ display_name: emoji }))).toBe('B'.repeat(39) + '\u{1F697}');
  expect(Array.from(prefillName(user({ display_name: emoji })))).toHaveLength(40);
});

test('a cut that ends on a space is trimmed', () => {
  expect(prefillName(user({ display_name: 'A'.repeat(39) + ' Stone' }))).toBe('A'.repeat(39));
});

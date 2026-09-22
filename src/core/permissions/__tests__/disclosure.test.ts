import {
  affirmationCovers,
  affirmationFor,
  ARMING_DISCLOSURE_MIN_VERSION,
  disclosureVersionAtLeast,
} from '@/core/permissions';
import { DISCLOSURE_VERSION } from '@/features/drive/detectionCopy';

describe('disclosureVersionAtLeast (a minimum, never equality)', () => {
  test.each([
    ['pd-1', 'pd-1', true],
    ['pd-2', 'pd-1', true],
    ['pd-10', 'pd-2', true],
    ['pd-1', 'pd-2', false],
    ['pd-0', 'pd-1', false],
    ['garbage', 'pd-1', false],
    ['pd-', 'pd-1', false],
    ['pd-1.5', 'pd-1', false],
  ] as const)('%s ≥ %s → %s', (v, min, expected) => {
    expect(disclosureVersionAtLeast(v, min)).toBe(expected);
  });

  test('the words shown now are at or above the arming minimum', () => {
    expect(disclosureVersionAtLeast(DISCLOSURE_VERSION, ARMING_DISCLOSURE_MIN_VERSION)).toBe(true);
  });
});

describe('affirmationCovers', () => {
  const ok = { version: 'pd-1', at: 1, uid: 'u1' };

  test('this account, at the minimum: covered', () => {
    expect(affirmationCovers(ok, 'u1')).toBe(true);
  });

  test('a copy-only bump above the minimum stays covered', () => {
    expect(affirmationCovers({ ...ok, version: 'pd-2' }, 'u1', 'pd-1')).toBe(true);
  });

  test('below the minimum: not covered', () => {
    expect(affirmationCovers(ok, 'u1', 'pd-2')).toBe(false);
  });

  test('another account, no account, or none recorded: not covered', () => {
    expect(affirmationCovers(ok, 'u2')).toBe(false);
    expect(affirmationCovers(ok, null)).toBe(false);
    expect(affirmationCovers(null, 'u1')).toBe(false);
  });

  test('migration: an affirmation written before the uid was stored does not count', () => {
    expect(affirmationCovers({ version: 'pd-1', at: 1 }, 'u1')).toBe(false);
  });

  test('malformed records do not count', () => {
    expect(affirmationCovers('pd-1', 'u1')).toBe(false);
    expect(affirmationCovers({ version: 1, uid: 'u1' }, 'u1')).toBe(false);
    expect(affirmationCovers({ version: 'pd-1', uid: '' }, '')).toBe(false);
  });

  test('affirmationFor writes the version, the time and the account', () => {
    expect(affirmationFor('pd-1', 'u1', 5)).toEqual({ version: 'pd-1', at: 5, uid: 'u1' });
  });
});

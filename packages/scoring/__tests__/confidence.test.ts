import { effectiveConfidence } from '../src/confidence';

test.each([
  [0.49, 0],
  [0.5, 0.5],
  [0.79, 0.79],
  [0.8, 1],
  [0.95, 1],
])('q=%p → %p', (q, want) => expect(effectiveConfidence(q)).toBeCloseTo(want, 6));

// A detector that divides by a zero-length window hands us NaN; every comparison against it is
// false, so without an explicit guard the event would fall through as fully confident.
test.each([[NaN], [Infinity], [-Infinity]])('a confidence of %p is worth nothing', (q) =>
  expect(effectiveConfidence(q)).toBe(0)
);

import { effectiveConfidence } from '../src/confidence';

test.each([
  [0.49, 0],
  [0.5, 0.5],
  [0.79, 0.79],
  [0.8, 1],
  [0.95, 1],
])('q=%p → %p', (q, want) => expect(effectiveConfidence(q)).toBeCloseTo(want, 6));

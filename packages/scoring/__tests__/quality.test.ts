import { dataQualityGrade } from '../src/quality';
test.each([[95, true, 'A'], [90, true, 'A'], [89.9, true, 'B'], [70, true, 'B'], [69, true, 'C'], [95, false, 'B']])('%p%% imu=%p → %p', (p, imu, g) => expect(dataQualityGrade(p, imu)).toBe(g));

// A share that is not a number is no evidence of coverage: grade C, never the B/A that a bare
// comparison would let NaN or Infinity slip into.
test.each([[NaN, true, 'C'], [Number.POSITIVE_INFINITY, true, 'C'], [Number.NEGATIVE_INFINITY, false, 'C']])('non-finite %p%% imu=%p → %p', (p, imu, g) => expect(dataQualityGrade(p, imu)).toBe(g));

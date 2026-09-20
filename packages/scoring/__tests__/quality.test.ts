import { dataQualityGrade } from '../src/quality';
test.each([[95, true, 'A'], [90, true, 'A'], [89.9, true, 'B'], [70, true, 'B'], [69, true, 'C'], [95, false, 'B']])('%p%% imu=%p → %p', (p, imu, g) => expect(dataQualityGrade(p, imu)).toBe(g));

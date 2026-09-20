import { CONSTANTS } from './constants';

/**
 * Data-quality grade for a trip (§9.8). Grade A needs near-complete GNSS *and* the IMU, because the
 * harsh-manoeuvre categories are measured in g and are meaningless without it; grade B tolerates one
 * or the other being thin; grade C is too thin to score at all, so the trip is kept but unscored.
 */
export function dataQualityGrade(validGnssPct: number, imuPresent: boolean): 'A' | 'B' | 'C' {
  if (validGnssPct < CONSTANTS.DATA_QUALITY_B_PCT) return 'C';
  if (imuPresent && validGnssPct >= CONSTANTS.DATA_QUALITY_A_PCT) return 'A';
  return 'B';
}

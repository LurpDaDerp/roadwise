export const MPH_PER_MPS = 2.2369362920544;
export const METERS_PER_MILE = 1609.344;
export const mpsToMph = (mps: number) => mps * MPH_PER_MPS;
export const mphToMps = (mph: number) => mph / MPH_PER_MPS;
export const metersToMiles = (m: number) => m / METERS_PER_MILE;
export const kmhToMph = (kmh: number) => kmh * 0.621371192237334;

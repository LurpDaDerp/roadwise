// Small numeric helpers shared by the v3 modules. Not re-exported from the barrel.

export const clamp = (v: number, lo: number, hi: number): number => Math.min(hi, Math.max(lo, v));

/**
 * Round to `dp` decimals, half up, immune to binary drift: the value is first snapped to 9
 * decimals so e.g. 59.400000000000006 or 12.499999999999998 land where the decimal maths says.
 */
export const roundTo = (v: number, dp = 0): number => {
  const f = 10 ** dp;
  return Math.round(Math.round(v * f * 1e9) / 1e9) / f;
};

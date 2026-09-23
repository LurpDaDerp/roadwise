// Small order statistics. Pure.

/** The median of the values (the mean of the middle two for an even count); NaN when empty. */
export function median(values: readonly number[]): number {
  if (values.length === 0) return Number.NaN;
  const s = [...values].sort((a, b) => a - b);
  const m = s.length >> 1;
  return s.length % 2 === 1 ? s[m]! : (s[m - 1]! + s[m]!) / 2;
}

/** The q-quantile (0 ≤ q ≤ 1) with linear interpolation between order statistics; NaN when empty. */
export function quantile(values: readonly number[], q: number): number {
  if (values.length === 0) return Number.NaN;
  const s = [...values].sort((a, b) => a - b);
  const pos = Math.min(Math.max(q, 0), 1) * (s.length - 1);
  const lo = Math.floor(pos);
  const hi = Math.min(lo + 1, s.length - 1);
  return s[lo]! + (s[hi]! - s[lo]!) * (pos - lo);
}

/** The weighted q-quantile: the smallest value whose cumulative weight reaches q of the total. */
export function weightedQuantile(values: readonly number[], weights: readonly number[], q: number): number {
  const idx = values.map((_, i) => i).sort((a, b) => values[a]! - values[b]!);
  let total = 0;
  for (const w of weights) total += w;
  if (!(total > 0)) return Number.NaN;
  const target = Math.min(Math.max(q, 0), 1) * total;
  let acc = 0;
  for (const i of idx) {
    acc += weights[i]!;
    if (acc >= target) return values[i]!;
  }
  return values[idx[idx.length - 1]!]!;
}

/** Population standard deviation; NaN when empty. */
export function sd(values: readonly number[]): number {
  if (values.length === 0) return Number.NaN;
  let m = 0;
  for (const v of values) m += v;
  m /= values.length;
  let s = 0;
  for (const v of values) s += (v - m) * (v - m);
  return Math.sqrt(s / values.length);
}

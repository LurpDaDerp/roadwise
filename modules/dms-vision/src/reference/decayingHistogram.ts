// The forgetting 1-D histogram behind the gaze network's subject statistics. An exact port of the V1
// `dms/util.js` DecayingHistogram1D (itself a port of the Python reference), including numpy's
// pairwise summation, so the V1 fixtures `gaze_inputs_stats_tracker.json` reproduce to 1e-12.
//
// Ports: `pairwiseSum` may be a plain left-to-right sum natively. The difference is a few ulps of
// the total, far inside the self-test tolerance, and the quantile only interpolates within one bin.

/** numpy's pairwise summation (`pairwise_sum_DOUBLE`). */
export function pairwiseSum(a: ArrayLike<number>, off: number, n: number): number {
  if (n < 8) {
    let res = 0.0;
    for (let i = 0; i < n; i++) res += a[off + i]!;
    return res;
  }
  if (n <= 128) {
    const r = [a[off]!, a[off + 1]!, a[off + 2]!, a[off + 3]!, a[off + 4]!, a[off + 5]!, a[off + 6]!, a[off + 7]!];
    let i = 8;
    const lim = n - (n % 8);
    for (; i < lim; i += 8) {
      for (let k = 0; k < 8; k++) r[k]! += a[off + i + k]!;
    }
    let res = r[0]! + r[1]! + (r[2]! + r[3]!) + (r[4]! + r[5]! + (r[6]! + r[7]!));
    for (; i < n; i++) res += a[off + i]!;
    return res;
  }
  let n2 = Math.floor(n / 2);
  n2 -= n2 % 8;
  return pairwiseSum(a, off, n2) + pairwiseSum(a, off + n2, n - n2);
}

/** Python's `round(x)` (round half to even) for a finite float. */
export function roundHalfEven(x: number): number {
  const f = Math.floor(x);
  const diff = x - f;
  if (diff > 0.5) return f + 1;
  if (diff < 0.5) return f;
  return f % 2 === 0 ? f : f + 1;
}

export class DecayingHistogram1D {
  readonly lo: number;
  readonly hi: number;
  readonly bin: number;
  readonly n: number;
  readonly tau: number;
  private counts: Float64Array;
  private scale = 1.0;
  private tLast: number | null = null;
  private sum = 0.0;
  private dirty = false;

  constructor(lo: number, hi: number, binWidth: number, tauS: number) {
    this.lo = lo;
    this.hi = hi;
    this.bin = binWidth;
    this.n = Math.max(1, roundHalfEven((hi - lo) / binWidth));
    this.tau = tauS;
    this.counts = new Float64Array(this.n);
  }

  reset(): void {
    this.counts.fill(0.0);
    this.scale = 1.0;
    this.tLast = null;
    this.sum = 0.0;
    this.dirty = false;
  }

  private rawSum(): number {
    if (this.dirty) {
      this.sum = pairwiseSum(this.counts, 0, this.n);
      this.dirty = false;
    }
    return this.sum;
  }

  private advance(t: number): void {
    if (this.tLast !== null && this.tau > 0.0) {
      const dt = Math.max(0.0, t - this.tLast);
      this.scale *= Math.exp(-dt / this.tau);
      if (this.scale < 1e-3) {
        const s = this.scale;
        for (let i = 0; i < this.n; i++) this.counts[i]! *= s;
        this.scale = 1.0;
        this.dirty = true;
      }
    }
    this.tLast = t;
  }

  add(x: number, t: number, w = 1.0): void {
    this.advance(t);
    if (!Number.isFinite(x) || w <= 0.0) return;
    let i = Math.trunc((x - this.lo) / this.bin);
    i = Math.min(Math.max(i, 0), this.n - 1);
    this.counts[i]! += w / this.scale;
    this.dirty = true;
  }

  mass(): number {
    return this.rawSum() * this.scale;
  }

  quantile(q: number): number | null {
    const total = this.rawSum();
    if (total <= 0.0) return null;
    const target = Math.min(Math.max(q, 0.0), 1.0) * total;
    let acc = 0.0;
    for (let i = 0; i < this.n; i++) {
      acc += this.counts[i]!;
      if (acc >= target) {
        const prev = acc - this.counts[i]!;
        const frac = this.counts[i]! > 0 ? (target - prev) / this.counts[i]! : 0.5;
        return this.lo + (i + frac) * this.bin;
      }
    }
    return this.hi;
  }

  median(): number | null {
    return this.quantile(0.5);
  }
}

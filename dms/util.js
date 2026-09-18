'use strict';
/**
 * Shared numeric helpers: angle conventions, decaying histograms, causal windows.
 *
 * Plain-JS port of `dms/util.py` (deployment-stack).  Every number is a float64 (JS numbers
 * are IEEE doubles, the same as numpy's default), the arithmetic order follows the Python
 * line for line, and the small numpy reductions are reproduced by `pairwiseSum` below.
 */

const DEG_PER_RAD = 180.0 / Math.PI;   // CPython's math.degrees multiplies by this constant
const RAD_PER_DEG = Math.PI / 180.0;

// --- numpy-compatible helpers -----------------------------------------------------------

/**
 * numpy's pairwise summation (`numpy/core/src/umath/loops.c.src: pairwise_sum_DOUBLE`).
 * Reproducing the reduction order keeps histogram masses bit-comparable with the reference.
 */
function pairwiseSum(a, off, n) {
  if (n < 8) {
    let res = 0.0;
    for (let i = 0; i < n; i++) res += a[off + i];
    return res;
  }
  if (n <= 128) {
    const r0 = a[off], r1 = a[off + 1], r2 = a[off + 2], r3 = a[off + 3];
    const r = [r0, r1, r2, r3, a[off + 4], a[off + 5], a[off + 6], a[off + 7]];
    let i = 8;
    const lim = n - (n % 8);
    for (; i < lim; i += 8) {
      r[0] += a[off + i];
      r[1] += a[off + i + 1];
      r[2] += a[off + i + 2];
      r[3] += a[off + i + 3];
      r[4] += a[off + i + 4];
      r[5] += a[off + i + 5];
      r[6] += a[off + i + 6];
      r[7] += a[off + i + 7];
    }
    let res = ((r[0] + r[1]) + (r[2] + r[3])) + ((r[4] + r[5]) + (r[6] + r[7]));
    for (; i < n; i++) res += a[off + i];
    return res;
  }
  let n2 = Math.floor(n / 2);
  n2 -= n2 % 8;
  return pairwiseSum(a, off, n2) + pairwiseSum(a, off + n2, n - n2);
}

/** `float(np.sum(a))` of a contiguous array. */
function sumArray(a) {
  return pairwiseSum(a, 0, a.length);
}

/** `float(np.mean(a))` of a contiguous array. */
function meanArray(a) {
  return pairwiseSum(a, 0, a.length) / a.length;
}

/** Python's `round(x)` (round-half-to-even) for a finite float. */
function roundHalfEven(x) {
  const f = Math.floor(x);
  const diff = x - f;
  if (diff > 0.5) return f + 1;
  if (diff < 0.5) return f;
  return f % 2 === 0 ? f : f + 1;
}

/** Python's `%` (result takes the sign of the divisor) for floats. */
function pyMod(x, y) {
  let m = x % y;
  if (m !== 0 && (m < 0) !== (y < 0)) m += y;
  return m;
}

/** Python's `//`-style floor division remainder for integers (used for ring slots). */
function pyModInt(k, n) {
  const m = k % n;
  return m < 0 ? m + n : m;
}

/**
 * Python's `round(x, ndigits)`: correct decimal rounding of the exact binary value with
 * ties to even.  Implemented on the exact value of the double (BigInt), so `to_dict()`
 * rounding matches the reference bit for bit instead of approximately.
 */
const _rndView = new DataView(new ArrayBuffer(8));
const POW10 = [];
for (let i = 0; i <= 20; i++) POW10.push(10n ** BigInt(i));

function pyRound(x, ndigits) {
  if (!Number.isFinite(x)) return x;
  if (x === 0) return x;
  _rndView.setFloat64(0, x);
  const hi = _rndView.getUint32(0);
  const lo = _rndView.getUint32(4);
  const negative = (hi >>> 31) === 1;
  let exp = (hi >>> 20) & 0x7ff;
  let mant = (BigInt(hi & 0xfffff) << 32n) | BigInt(lo >>> 0);
  if (exp === 0) exp = 1; else mant |= 1n << 52n;
  const k = exp - 1075;                    // |x| = mant * 2^k
  const p10 = ndigits <= 20 ? POW10[ndigits] : 10n ** BigInt(ndigits);
  let num = mant * p10;
  let den = 1n;
  if (k >= 0) num <<= BigInt(k); else den = 1n << BigInt(-k);
  let q = num / den;
  const rem = num - q * den;
  const twice = rem * 2n;
  if (twice > den || (twice === den && (q & 1n) === 1n)) q += 1n;
  const value = Number(q) / Number(p10);
  return negative ? -value : value;
}

// --- angles -----------------------------------------------------------------------------

function norm3(x, y, z) {
  return Math.sqrt(x * x + y * y + z * z);
}

/** `v / max(|v|, 1e-9)` for a 3-vector; returns a new plain array. */
function unit(v) {
  const x = v[0], y = v[1], z = v[2];
  const n = norm3(x, y, z);
  const d = n > 1e-9 ? n : 1e-9;
  return [x / d, y / d, z / d];
}

/**
 * Stored-convention unit vector -> `[yaw, pitch]` degrees: yaw = atan2(x, z) (+ image right),
 * pitch = atan2(-y, hypot(x, z)) (+ up).
 */
function vectorToAngles(v) {
  const x = v[0], y = v[1], z = v[2];
  return [Math.atan2(x, z) * DEG_PER_RAD, Math.atan2(-y, Math.hypot(x, z)) * DEG_PER_RAD];
}

function anglesToVector(yawDeg, pitchDeg) {
  const y = yawDeg * RAD_PER_DEG;
  const p = pitchDeg * RAD_PER_DEG;
  return [Math.cos(p) * Math.sin(y), -Math.sin(p), Math.cos(p) * Math.cos(y)];
}

function angularDistanceDeg(a, b) {
  const ua = unit(a), ub = unit(b);
  const d = ua[0] * ub[0] + ua[1] * ub[1] + ua[2] * ub[2];
  return Math.acos(Math.max(-1.0, Math.min(1.0, d))) * DEG_PER_RAD;
}

/** Rotation input: a flat row-major array of 9 or a 3x3 nested array. */
function rotAt(r, i, j) {
  const row = r[i];
  return Array.isArray(row) || ArrayBuffer.isView(row) ? row[j] : r[i * 3 + j];
}

/**
 * Face-forward unit vector (stored convention) of the auxiliary head rotation `R`:
 * `unit((M R M) e_z)` with `M = diag(1, 1, -1)`, i.e. `unit([-R02, -R12, R22])`.
 */
function headDirection(rotation) {
  // (M r M) e_z with M = diag(1, 1, -1); `0.0 - x` keeps the reference's signed zeros.
  return unit([0.0 - rotAt(rotation, 0, 2), 0.0 - rotAt(rotation, 1, 2), rotAt(rotation, 2, 2)]);
}

/**
 * Minimal rotation `R` with `R e_z = reference` (Rodrigues), as a flat row-major array of 9.
 * `R^T` maps gaze vectors into the reference frame.
 */
function referenceRotation(reference) {
  const r = unit(reference);
  const k = [0.0 - r[1], r[0] - 0.0, 0.0];          // np.cross([0,0,1], r)
  const s = norm3(k[0], k[1], k[2]);
  const c = r[2];                                    // np.dot([0,0,1], r)
  if (s < 1e-9) {
    return c > 0 ? [1, 0, 0, 0, 1, 0, 0, 0, 1] : [1, 0, 0, 0, -1, 0, 0, 0, -1];
  }
  const k0 = k[0] / s, k1 = k[1] / s, k2 = k[2] / s;
  const kx = [0.0, -k2, k1, k2, 0.0, -k0, -k1, k0, 0.0];
  const kk = new Array(9);
  for (let i = 0; i < 3; i++) {
    for (let j = 0; j < 3; j++) {
      let acc = 0.0;
      for (let m = 0; m < 3; m++) acc += kx[i * 3 + m] * kx[m * 3 + j];
      kk[i * 3 + j] = acc;
    }
  }
  const one = 1.0 - c;
  const out = new Array(9);
  for (let i = 0; i < 3; i++) {
    for (let j = 0; j < 3; j++) {
      const eye = i === j ? 1.0 : 0.0;
      out[i * 3 + j] = (eye + s * kx[i * 3 + j]) + one * kk[i * 3 + j];
    }
  }
  return out;
}

/** `[dyaw, dpitch]` degrees of `gaze` seen from the reference direction (+ image right, + up). */
function relativeAngles(gaze, reference) {
  const R = referenceRotation(reference);
  const g = unit(gaze);
  const v = [0, 0, 0];
  for (let i = 0; i < 3; i++) {
    let acc = 0.0;
    for (let m = 0; m < 3; m++) acc += R[m * 3 + i] * g[m];   // R.T @ g
    v[i] = acc;
  }
  return vectorToAngles(v);
}

function wrapDeg(a) {
  return pyMod(a + 180.0, 360.0) - 180.0;
}

// --- deque ------------------------------------------------------------------------------

/** Minimal FIFO with O(1) amortised shift (the Python `collections.deque` stand-in). */
class Deque {
  constructor(maxlen = 0) {
    this.items = [];
    this.head = 0;
    this.maxlen = maxlen;
  }

  get length() {
    return this.items.length - this.head;
  }

  push(x) {
    this.items.push(x);
    if (this.maxlen > 0 && this.length > this.maxlen) this.shift();
  }

  shift() {
    const v = this.items[this.head];
    this.items[this.head] = undefined;
    this.head += 1;
    if (this.head > 32 && this.head * 2 >= this.items.length) {
      this.items = this.items.slice(this.head);
      this.head = 0;
    }
    return v;
  }

  get(i) {
    return this.items[this.head + i];
  }

  first() {
    return this.items[this.head];
  }

  last() {
    return this.items[this.items.length - 1];
  }

  clear() {
    this.items = [];
    this.head = 0;
  }

  toArray() {
    return this.items.slice(this.head);
  }
}

// --- decaying histograms ----------------------------------------------------------------

/**
 * Exponentially forgetting 1-D histogram with quantile queries.  The decay is applied lazily
 * through a global scale; `mass()` is the decayed total weight (admitted seconds).
 */
class DecayingHistogram1D {
  constructor(lo, hi, binWidth, tauS) {
    this.lo = lo;
    this.hi = hi;
    this.bin = binWidth;
    this.n = Math.max(1, roundHalfEven((this.hi - this.lo) / this.bin));
    this.tau = tauS;
    this.counts = new Float64Array(this.n);
    this.scale = 1.0;
    this.t_last = null;
    this._sum = 0.0;
    this._dirty = false;
  }

  reset() {
    this.counts.fill(0.0);
    this.scale = 1.0;
    this.t_last = null;
    this._sum = 0.0;
    this._dirty = false;
  }

  _rawSum() {
    if (this._dirty) {
      this._sum = pairwiseSum(this.counts, 0, this.n);
      this._dirty = false;
    }
    return this._sum;
  }

  _advance(t) {
    if (this.t_last !== null && this.tau > 0.0) {
      const dt = Math.max(0.0, t - this.t_last);
      this.scale *= Math.exp(-dt / this.tau);
      if (this.scale < 1e-3) {
        const s = this.scale;
        for (let i = 0; i < this.n; i++) this.counts[i] *= s;
        this.scale = 1.0;
        this._dirty = true;
      }
    }
    this.t_last = t;
  }

  add(x, t, w = 1.0) {
    this._advance(t);
    if (!Number.isFinite(x) || w <= 0.0) return;
    let i = Math.trunc((x - this.lo) / this.bin);
    i = Math.min(Math.max(i, 0), this.n - 1);
    this.counts[i] += w / this.scale;
    this._dirty = true;
  }

  mass() {
    return this._rawSum() * this.scale;
  }

  quantile(q) {
    const total = this._rawSum();
    if (total <= 0.0) return null;
    const target = Math.min(Math.max(q, 0.0), 1.0) * total;
    let acc = 0.0;
    for (let i = 0; i < this.n; i++) {
      acc += this.counts[i];
      if (acc >= target) {
        const prev = acc - this.counts[i];
        const frac = this.counts[i] > 0 ? (target - prev) / this.counts[i] : 0.5;
        return this.lo + (i + frac) * this.bin;
      }
    }
    return this.hi;
  }

  median() {
    return this.quantile(0.5);
  }
}

/** The 2-D counterpart (yaw x pitch) used by the forward-reference calibrator. */
class DecayingHistogram2D {
  constructor(xRange, yRange, binDeg, tauS) {
    this.x0 = xRange[0];
    this.x1 = xRange[1];
    this.y0 = yRange[0];
    this.y1 = yRange[1];
    this.bin = binDeg;
    this.nx = Math.max(1, roundHalfEven((this.x1 - this.x0) / this.bin));
    this.ny = Math.max(1, roundHalfEven((this.y1 - this.y0) / this.bin));
    this.tau = tauS;
    this.counts = new Float64Array(this.nx * this.ny);
    this.scale = 1.0;
    this.t_last = null;
    this._sum = 0.0;
    this._dirty = false;
  }

  reset() {
    this.counts.fill(0.0);
    this.scale = 1.0;
    this.t_last = null;
    this._sum = 0.0;
    this._dirty = false;
  }

  _rawSum() {
    if (this._dirty) {
      this._sum = pairwiseSum(this.counts, 0, this.counts.length);
      this._dirty = false;
    }
    return this._sum;
  }

  copyFrom(other) {
    const f = this.scale !== 0 ? other.scale / this.scale : other.scale;
    for (let i = 0; i < this.counts.length; i++) this.counts[i] = other.counts[i] * f;
    this.t_last = other.t_last;
    this._dirty = true;
  }

  _advance(t) {
    if (this.t_last !== null && this.tau > 0.0) {
      const dt = Math.max(0.0, t - this.t_last);
      this.scale *= Math.exp(-dt / this.tau);
      if (this.scale < 1e-3) {
        const s = this.scale;
        for (let i = 0; i < this.counts.length; i++) this.counts[i] *= s;
        this.scale = 1.0;
        this._dirty = true;
      }
    }
    this.t_last = t;
  }

  add(x, y, t, w = 1.0) {
    this._advance(t);
    if (!(Number.isFinite(x) && Number.isFinite(y)) || w <= 0.0) return;
    const i = Math.min(Math.max(Math.trunc((x - this.x0) / this.bin), 0), this.nx - 1);
    const j = Math.min(Math.max(Math.trunc((y - this.y0) / this.bin), 0), this.ny - 1);
    this.counts[i * this.ny + j] += w / this.scale;
    this._dirty = true;
  }

  mass() {
    return this._rawSum() * this.scale;
  }

  /** Counts convolved with a separable 5 x 5 Gaussian (edges clipped). */
  smoothed(sigmaBins) {
    if (sigmaBins <= 0.0) return Float64Array.from(this.counts);
    const r = 2;
    const k = new Float64Array(2 * r + 1);
    for (let d = -r; d <= r; d++) {
      const q = d / sigmaBins;
      k[d + r] = Math.exp(-0.5 * (q * q));
    }
    const ks = pairwiseSum(k, 0, k.length);
    for (let i = 0; i < k.length; i++) k[i] /= ks;
    return separableBlur(this.counts, this.nx, this.ny, k);
  }

  /**
   * `[x, y, share]`: the smoothed mode refined by the 3 x 3 centroid, in the histogram's
   * units (bin centres), and the share of the total (decayed) mass in the 3 x 3 block.
   */
  mode(sigmaBins = 1.5) {
    const total = this._rawSum();
    if (total <= 0.0) return null;
    const s = this.smoothed(sigmaBins);
    let best = -Infinity;
    let arg = 0;
    for (let idx = 0; idx < s.length; idx++) {
      if (s[idx] > best) {
        best = s[idx];
        arg = idx;
      }
    }
    const i = Math.floor(arg / this.ny);
    const j = arg % this.ny;
    const i0 = Math.max(0, i - 1), i1 = Math.min(this.nx, i + 2);
    const j0 = Math.max(0, j - 1), j1 = Math.min(this.ny, j + 2);
    const h = i1 - i0, w = j1 - j0;
    const block = new Float64Array(h * w);
    const prodI = new Float64Array(h * w);
    const prodJ = new Float64Array(h * w);
    const rawBlock = new Float64Array(h * w);
    for (let a = 0; a < h; a++) {
      for (let b = 0; b < w; b++) {
        const v = s[(i0 + a) * this.ny + (j0 + b)];
        block[a * w + b] = v;
        prodI[a * w + b] = v * (i0 + a);
        prodJ[a * w + b] = v * (j0 + b);
        rawBlock[a * w + b] = this.counts[(i0 + a) * this.ny + (j0 + b)];
      }
    }
    const bs = pairwiseSum(block, 0, block.length);
    if (bs <= 0.0) return null;
    const ci = pairwiseSum(prodI, 0, prodI.length) / bs;
    const cj = pairwiseSum(prodJ, 0, prodJ.length) / bs;
    const x = this.x0 + (ci + 0.5) * this.bin;
    const y = this.y0 + (cj + 0.5) * this.bin;
    return [x, y, pairwiseSum(rawBlock, 0, rawBlock.length) / total];
  }

  /** Decayed mass inside a circle of `radius` (histogram units) around `(x, y)`. */
  massWithin(x, y, radius) {
    const sel = [];
    const rr = radius * radius;
    for (let i = 0; i < this.nx; i++) {
      const dx = this.x0 + (i + 0.5) * this.bin - x;
      for (let j = 0; j < this.ny; j++) {
        const dy = this.y0 + (j + 0.5) * this.bin - y;
        if (dx * dx + dy * dy <= rr) sel.push(this.counts[i * this.ny + j]);
      }
    }
    return pairwiseSum(sel, 0, sel.length) * this.scale;
  }
}

/**
 * `_separable_blur`: rows then columns, edges clipped, contributions accumulated in
 * increasing kernel offset (the numpy slice loop's order).
 */
function separableBlur(counts, nx, ny, k) {
  const r = (k.length - 1) >> 1;
  const tmp = new Float64Array(nx * ny);
  for (let d = -r; d <= r; d++) {
    const kv = k[d + r];
    const dst0 = Math.max(0, d);
    const src0 = Math.max(0, -d);
    const rows = nx - Math.abs(d);
    for (let q = 0; q < rows; q++) {
      const dstRow = (dst0 + q) * ny;
      const srcRow = (src0 + q) * ny;
      for (let j = 0; j < ny; j++) tmp[dstRow + j] += kv * counts[srcRow + j];
    }
  }
  const out = new Float64Array(nx * ny);
  for (let d = -r; d <= r; d++) {
    const kv = k[d + r];
    const dst0 = Math.max(0, d);
    const src0 = Math.max(0, -d);
    const cols = ny - Math.abs(d);
    for (let i = 0; i < nx; i++) {
      const row = i * ny;
      for (let q = 0; q < cols; q++) out[row + dst0 + q] += kv * tmp[row + src0 + q];
    }
  }
  return out;
}

// --- causal windows -----------------------------------------------------------------------

/** Median of the last `n` values (a small ring buffer). */
class CausalMedian {
  constructor(n) {
    this.n = Math.max(1, Math.trunc(n));
    this.values = new Deque(this.n);
  }

  reset() {
    this.values.clear();
  }

  push(x) {
    this.values.push(x);
    const s = this.values.toArray().slice().sort((a, b) => a - b);
    const m = s.length;
    return m % 2 ? s[(m - m % 2) / 2] : (s[m / 2 - 1] + s[m / 2]) / 2;
  }
}

/** Sum of `value * dt` over a sliding time window (seconds). */
class TimeWindowSum {
  constructor(windowS) {
    this.window = windowS;
    this.items = new Deque();
    this._sum = 0.0;
  }

  reset() {
    this.items.clear();
    this._sum = 0.0;
  }

  push(t, value, dt) {
    const contribution = value * dt;
    this.items.push([t, contribution]);
    this._sum += contribution;
    this._expire(t);
  }

  _expire(t) {
    while (this.items.length && this.items.first()[0] < t - this.window) {
      this._sum -= this.items.shift()[1];
    }
  }

  total(t = null, clamp = true) {
    if (t !== null) this._expire(t);
    return clamp ? Math.max(0.0, this._sum) : this._sum;
  }

  span() {
    return this.items.length > 1 ? this.items.last()[0] - this.items.first()[0] : 0.0;
  }
}

/** Two sums over a long sliding window, accumulated in fixed-width time buckets. */
class BucketWindowSum {
  constructor(windowS, bucketS) {
    this.window = windowS;
    this.bucket = bucketS;
    this.n = Math.ceil(this.window / this.bucket) + 1;
    this.reset();
  }

  reset() {
    this.keys = new Array(this.n).fill(null);
    this.a = new Array(this.n).fill(0.0);
    this.b = new Array(this.n).fill(0.0);
  }

  push(t, a, b) {
    const k = Math.floor(t / this.bucket);
    const i = pyModInt(k, this.n);
    if (this.keys[i] !== k) {
      this.keys[i] = k;
      this.a[i] = 0.0;
      this.b[i] = 0.0;
    }
    this.a[i] += a;
    this.b[i] += b;
  }

  totals(t) {
    const kNow = Math.floor(t / this.bucket);
    const kMin = Math.ceil((t - this.window) / this.bucket);
    let sa = 0.0, sb = 0.0;
    for (let i = 0; i < this.n; i++) {
      const k = this.keys[i];
      if (k !== null && kMin <= k && k <= kNow) {
        sa += this.a[i];
        sb += this.b[i];
      }
    }
    return [sa, sb];
  }
}

/** Timestamps of events inside a sliding window. */
class EventCounter {
  constructor(windowS) {
    this.window = windowS;
    this.times = new Deque();
  }

  reset() {
    this.times.clear();
  }

  push(t) {
    this.times.push(t);
    this._expire(t);
  }

  _expire(t) {
    while (this.times.length && this.times.first() < t - this.window) this.times.shift();
  }

  count(t) {
    this._expire(t);
    return this.times.length;
  }
}

module.exports = {
  DEG_PER_RAD,
  RAD_PER_DEG,
  pairwiseSum,
  sumArray,
  meanArray,
  roundHalfEven,
  pyMod,
  pyModInt,
  pyRound,
  norm3,
  rotAt,
  unit,
  vectorToAngles,
  anglesToVector,
  angularDistanceDeg,
  headDirection,
  referenceRotation,
  relativeAngles,
  wrapDeg,
  separableBlur,
  Deque,
  DecayingHistogram1D,
  DecayingHistogram2D,
  CausalMedian,
  TimeWindowSum,
  BucketWindowSum,
  EventCounter,
};

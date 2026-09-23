// Small filters (plan §M2). Pure.

/**
 * A median of the last three values within a quality run (gaze and head angles; EAR and MAR are not
 * smoothed). With fewer than three values it returns the value (one) or the mean (two). The caller
 * resets it on every quality change; a non-finite value also resets it and is passed through, so a
 * gap never mixes two runs.
 */
export class Median3 {
  private a = 0;
  private b = 0;
  private c = 0;
  private n = 0;

  get size(): number {
    return this.n;
  }

  reset(): void {
    this.n = 0;
  }

  push(v: number): number {
    if (!Number.isFinite(v)) {
      this.n = 0;
      return v;
    }
    this.a = this.b;
    this.b = this.c;
    this.c = v;
    if (this.n < 3) this.n += 1;
    if (this.n === 1) return v;
    if (this.n === 2) return (this.b + this.c) / 2;
    const { a, b, c } = this;
    return Math.max(Math.min(a, b), Math.min(Math.max(a, b), c));
  }
}

// Bounded windows (plan Task 5). Every engine window has a fixed capacity, so memory never grows with
// the trip. Pure: time is the frame clock the caller passes.

/**
 * A rolling sum over the last `windowMs`, in fixed buckets of `bucketMs` (100 ms for D2). Bucket k
 * holds times [k·bucketMs, (k+1)·bucketMs). `sum(now)` covers the buckets that end after
 * `now − windowMs` and start at or before `now`: the window (now − windowMs, now] at bucket resolution.
 */
export class TimeBuckets {
  readonly capacity: number;
  private readonly values: Float64Array;
  /** the newest bucket index written or cleared up to; -Infinity when empty */
  private head = Number.NEGATIVE_INFINITY;

  constructor(
    readonly windowMs: number,
    readonly bucketMs: number
  ) {
    if (!(bucketMs > 0) || !(windowMs > 0) || windowMs % bucketMs !== 0) {
      throw new Error('TimeBuckets: the window must be a positive whole number of buckets');
    }
    this.capacity = windowMs / bucketMs;
    this.values = new Float64Array(this.capacity);
  }

  reset(): void {
    this.values.fill(0);
    this.head = Number.NEGATIVE_INFINITY;
  }

  /** Clears every bucket between the current head and `k`, and makes `k` the head. */
  private advance(k: number): void {
    if (k <= this.head) return;
    if (this.head === Number.NEGATIVE_INFINITY || k - this.head >= this.capacity) {
      this.values.fill(0);
    } else {
      for (let j = this.head + 1; j <= k; j++) this.values[this.slot(j)] = 0;
    }
    this.head = k;
  }

  private slot(k: number): number {
    return ((k % this.capacity) + this.capacity) % this.capacity;
  }

  add(tMs: number, value: number): void {
    const k = Math.floor(tMs / this.bucketMs);
    this.advance(k);
    if (k <= this.head - this.capacity) return; // older than the window of the newest time
    const i = this.slot(k);
    this.values[i] = this.values[i]! + value;
  }

  sum(nowMs: number): number {
    const k = Math.floor(nowMs / this.bucketMs);
    this.advance(k);
    const oldest = Math.floor((nowMs - this.windowMs) / this.bucketMs) + 1;
    let s = 0;
    for (let j = Math.max(oldest, k - this.capacity + 1); j <= k; j++) s += this.values[this.slot(j)]!;
    return s;
  }
}

/** A fixed-capacity FIFO: pushing onto a full buffer drops the oldest item. */
export class RingBuffer<T> {
  private readonly items: (T | undefined)[];
  private start = 0;
  private count = 0;

  constructor(readonly capacity: number) {
    if (!Number.isInteger(capacity) || capacity < 1) throw new Error('RingBuffer: capacity must be a positive integer');
    this.items = new Array<T | undefined>(capacity);
  }

  get size(): number {
    return this.count;
  }

  push(item: T): void {
    if (this.count < this.capacity) {
      this.items[(this.start + this.count) % this.capacity] = item;
      this.count += 1;
    } else {
      this.items[this.start] = item;
      this.start = (this.start + 1) % this.capacity;
    }
  }

  /** The i-th item, oldest first. */
  at(i: number): T | undefined {
    if (i < 0 || i >= this.count) return undefined;
    return this.items[(this.start + i) % this.capacity];
  }

  first(): T | undefined {
    return this.at(0);
  }

  last(): T | undefined {
    return this.at(this.count - 1);
  }

  /** Drops items from the oldest end while `pred` holds; returns how many were dropped. */
  dropWhile(pred: (item: T) => boolean): number {
    let dropped = 0;
    while (this.count > 0 && pred(this.items[this.start] as T)) {
      this.items[this.start] = undefined;
      this.start = (this.start + 1) % this.capacity;
      this.count -= 1;
      dropped += 1;
    }
    return dropped;
  }

  forEach(fn: (item: T, i: number) => void): void {
    for (let i = 0; i < this.count; i++) fn(this.items[(this.start + i) % this.capacity] as T, i);
  }

  toArray(): T[] {
    const out: T[] = [];
    this.forEach((x) => out.push(x));
    return out;
  }

  clear(): void {
    this.items.fill(undefined);
    this.start = 0;
    this.count = 0;
  }
}

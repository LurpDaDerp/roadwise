// Bounded windows (plan Task 5): TimeBuckets (fixed 100 ms buckets, rolling sum) and RingBuffer<T>
// (fixed capacity). Every engine window has a fixed capacity, so memory cannot grow with trip length.
import { RingBuffer, TimeBuckets } from '../windows';

describe('TimeBuckets', () => {
  test('sums values by 100 ms bucket over the window', () => {
    const b = new TimeBuckets(1000, 100);
    b.add(0, 1);
    b.add(50, 1); // same bucket
    b.add(150, 2);
    expect(b.sum(150)).toBe(4);
    expect(b.sum(999)).toBe(4);
    // At 1000 ms the window (0, 1000] no longer holds bucket 0 (0–99 ms).
    expect(b.sum(1000)).toBe(2);
    expect(b.sum(1150)).toBe(0);
  });

  test('a gap longer than the window clears everything', () => {
    const b = new TimeBuckets(30_000, 100);
    for (let t = 0; t < 5000; t += 100) b.add(t, 0.1);
    expect(b.sum(4999)).toBeCloseTo(5, 9);
    expect(b.sum(4999 + 60_000)).toBe(0);
    b.add(70_000, 1);
    expect(b.sum(70_000)).toBe(1);
  });

  test('a value older than the window is ignored; one inside it lands in its bucket', () => {
    const b = new TimeBuckets(1000, 100);
    b.add(5000, 1);
    b.add(3000, 5); // before the window of the newest time
    b.add(4500, 2); // inside
    expect(b.sum(5000)).toBe(3);
  });

  test('reset and the capacity are fixed', () => {
    const b = new TimeBuckets(30_000, 100);
    expect(b.capacity).toBe(300);
    b.add(10, 1);
    b.reset();
    expect(b.sum(10)).toBe(0);
  });

  test('refuses a window that is not a whole number of buckets', () => {
    expect(() => new TimeBuckets(1050, 100)).toThrow();
    expect(() => new TimeBuckets(0, 100)).toThrow();
  });

  test('a two-hour run keeps the same capacity and a correct sum', () => {
    const b = new TimeBuckets(30_000, 100);
    let t = 0;
    for (; t < 2 * 3600 * 1000; t += 67) b.add(t, 1);
    expect(b.capacity).toBe(300);
    // The last 30 s at one value per 67 ms: about 448 values (bucket edges shift it by one).
    expect(Math.abs(b.sum(t - 67) - 30_000 / 67)).toBeLessThanOrEqual(2);
  });
});

describe('RingBuffer', () => {
  test('keeps the newest `capacity` items, oldest first', () => {
    const r = new RingBuffer<number>(3);
    expect(r.size).toBe(0);
    expect(r.last()).toBeUndefined();
    r.push(1);
    r.push(2);
    expect(r.toArray()).toEqual([1, 2]);
    r.push(3);
    r.push(4);
    expect(r.toArray()).toEqual([2, 3, 4]);
    expect(r.size).toBe(3);
    expect(r.at(0)).toBe(2);
    expect(r.at(2)).toBe(4);
    expect(r.at(3)).toBeUndefined();
    expect(r.first()).toBe(2);
    expect(r.last()).toBe(4);
  });

  test('dropWhile removes from the oldest end (time windows)', () => {
    const r = new RingBuffer<{ t: number }>(10);
    for (let t = 0; t < 8; t++) r.push({ t });
    expect(r.dropWhile((x) => x.t < 5)).toBe(5);
    expect(r.toArray().map((x) => x.t)).toEqual([5, 6, 7]);
    r.push({ t: 8 });
    expect(r.toArray().map((x) => x.t)).toEqual([5, 6, 7, 8]);
  });

  test('clear, forEach and the fixed capacity', () => {
    const r = new RingBuffer<string>(2);
    r.push('a');
    r.push('b');
    r.push('c');
    const seen: string[] = [];
    r.forEach((v) => seen.push(v));
    expect(seen).toEqual(['b', 'c']);
    r.clear();
    expect(r.size).toBe(0);
    expect(r.capacity).toBe(2);
    expect(() => new RingBuffer(0)).toThrow();
  });
});

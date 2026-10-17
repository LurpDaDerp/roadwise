/**
 * The aiming picture's reassembly on the phone (docs/BLE_PROTOCOL.md §3.4): the firmware's v3 VIEW
 * vectors byte for byte, and the rules for records out of place, a third image, the wrap, a stream
 * starting again and the zeroed buffers.
 */
import vectors from '../__fixtures__/ble_vectors.json';
import { fromHex } from '../protocol';
import { createViewAssembler, jpegDataUri, toBase64, VIEW_MAX_JPEG } from '../view';

interface ChunkVector {
  desc: string;
  mtu: number;
  frame: number;
  data_max: number;
  jpeg_len: number;
  jpeg: string;
  records: string[];
}
const chunks = (vectors as unknown as { v3: { view: { chunks: ChunkVector[] } } }).v3.view.chunks;

/** A record as the dashcam builds it. */
function record(frame: number, total: number, offset: number, data: number[]): number[] {
  return [0x01, 0x01, frame, 0, total & 0xff, total >> 8, offset & 0xff, offset >> 8, ...data];
}
/** An image cut into records of `n` data bytes. */
function cut(frame: number, jpeg: number[], n: number): number[][] {
  const out: number[][] = [];
  for (let o = 0; o < jpeg.length; o += n) out.push(record(frame, jpeg.length, o, jpeg.slice(o, o + n)));
  return out;
}
declare function btoa(s: string): string;
const bytes = (len: number, seed = 1): number[] => Array.from({ length: len }, (_, i) => (i * 31 + seed * 7) & 0xff);

describe('the v3 VIEW vectors', () => {
  it.each(chunks.map((c) => [c.desc, c] as const))('%s: the records reassemble to the image, acknowledged once', (_d, c) => {
    const a = createViewAssembler();
    const jpeg = fromHex(c.jpeg);
    expect(jpeg).toHaveLength(c.jpeg_len);
    const acks: number[] = [];
    let image: { frame: number; jpeg: Uint8Array } | null = null;
    c.records.forEach((hex, i) => {
      const rec = fromHex(hex);
      expect(rec.length - 8).toBeLessThanOrEqual(c.data_max);
      const r = a.put(rec);
      acks.push(...r.acks);
      if (i < c.records.length - 1) expect(r.image).toBeNull();
      else image = r.image;
    });
    expect(image).not.toBeNull();
    expect(image!.frame).toBe(c.frame);
    expect(Array.from(image!.jpeg)).toEqual(jpeg);
    expect(acks).toEqual([c.frame]);
    expect(a.open()).toBe(0);
    // A replayed record of a finished image is ignored, never acknowledged again.
    expect(a.put(fromHex(c.records[0]!))).toEqual({ image: null, acks: [] });
  });
});

describe('reassembly rules', () => {
  it('ignores another kind or version, frame 0 and a record shorter than its header', () => {
    const a = createViewAssembler();
    expect(a.put([0x02, 0x01, 1, 0, 4, 0, 0, 0, 1, 2, 3, 4])).toEqual({ image: null, acks: [] });
    expect(a.put([0x01, 0x02, 1, 0, 4, 0, 0, 0, 1, 2, 3, 4])).toEqual({ image: null, acks: [] });
    expect(a.put(record(0, 4, 0, [1, 2, 3, 4]))).toEqual({ image: null, acks: [] });
    expect(a.put([0x01, 0x01, 1, 0, 4, 0, 0])).toEqual({ image: null, acks: [] });
    expect(a.open()).toBe(0);
  });

  it('a record off its place, past total, with another total or a total above 6144 gives its image up, acknowledged once', () => {
    const img = bytes(300);
    const recs = cut(5, img, 100);
    const gap = createViewAssembler();
    gap.put(recs[0]!);
    expect(gap.put(recs[2]!)).toEqual({ image: null, acks: [5] });
    expect(gap.put(recs[1]!)).toEqual({ image: null, acks: [] });

    const past = createViewAssembler();
    expect(past.put(record(6, 10, 0, bytes(11)))).toEqual({ image: null, acks: [6] });

    const other = createViewAssembler();
    other.put(record(7, 20, 0, bytes(10)));
    expect(other.put(record(7, 21, 10, bytes(10)))).toEqual({ image: null, acks: [7] });

    const big = createViewAssembler();
    expect(big.put(record(8, VIEW_MAX_JPEG + 1, 0, bytes(10)))).toEqual({ image: null, acks: [8] });
    expect(big.open()).toBe(0);
  });

  it('a duplicate record gives the image up (records come in order)', () => {
    const a = createViewAssembler();
    const recs = cut(3, bytes(200), 100);
    a.put(recs[0]!);
    expect(a.put(recs[0]!)).toEqual({ image: null, acks: [3] });
  });

  it('keeps 2 images open; a third gives up the oldest; interleaved images both complete', () => {
    const a = createViewAssembler();
    const i1 = cut(1, bytes(200, 1), 100);
    const i2 = cut(2, bytes(200, 2), 100);
    const i3 = cut(3, bytes(200, 3), 100);
    a.put(i1[0]!);
    a.put(i2[0]!);
    expect(a.open()).toBe(2);
    expect(a.put(i3[0]!)).toEqual({ image: null, acks: [1] });
    expect(a.put(i2[1]!).image?.frame).toBe(2);
    const r3 = a.put(i3[1]!);
    expect(r3.image?.frame).toBe(3);
    expect(Array.from(r3.image!.jpeg)).toEqual(bytes(200, 3));
    expect(a.open()).toBe(0);
  });

  it('runs 300 images across the 255 → 1 wrap: every image shows once, each acknowledged once', () => {
    const a = createViewAssembler();
    const seen: number[] = [];
    const acks: number[] = [];
    for (let k = 0; k < 300; k++) {
      const f = (k % 255) + 1;
      for (const rec of cut(f, bytes(150, f), 69)) {
        const r = a.put(rec);
        acks.push(...r.acks);
        if (r.image) seen.push(r.image.frame);
      }
    }
    expect(seen).toHaveLength(300);
    expect(acks).toEqual(seen);
    expect(seen[255]).toBe(1);
  });

  it('start() forgets the finished frames, so a new stream’s frame 1 shows; without it, it is ignored', () => {
    const a = createViewAssembler();
    for (const rec of cut(1, bytes(100), 50)) a.put(rec);
    const again = cut(1, bytes(100, 9), 50);
    expect(a.put(again[0]!)).toEqual({ image: null, acks: [] });
    a.start();
    a.put(again[0]!);
    const r = a.put(again[1]!);
    expect(r.image?.frame).toBe(1);
    expect(Array.from(r.image!.jpeg)).toEqual(bytes(100, 9));
  });

  it('start() and wipe() zero the open images and drop them unacknowledged', () => {
    const filled: Uint8Array[] = [];
    const a = createViewAssembler({
      alloc: (n) => {
        const b = new Uint8Array(n);
        filled.push(b);
        return b;
      },
    });
    a.put(record(4, 10, 0, [9, 9, 9, 9, 9]));
    expect(filled[0]!.slice(0, 5)).toEqual(new Uint8Array([9, 9, 9, 9, 9]));
    a.wipe();
    expect(Array.from(filled[0]!)).toEqual(new Array(10).fill(0));
    expect(a.open()).toBe(0);
    // The rest of a wiped image starts nothing: it is off its place.
    expect(a.put(record(4, 10, 5, [1, 1, 1, 1, 1]))).toEqual({ image: null, acks: [4] });
  });
});

describe('the data URI', () => {
  it('is standard base64 with padding', () => {
    for (const len of [0, 1, 2, 3, 4, 5, 255, 3000]) {
      const b = bytes(len);
      expect(toBase64(b)).toBe(btoa(String.fromCharCode(...b)));
    }
    expect(jpegDataUri([0xff, 0xd8, 0xff, 0xd9])).toBe('data:image/jpeg;base64,/9j/2Q==');
  });
});

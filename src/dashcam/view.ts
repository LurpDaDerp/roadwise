// The setup's aiming picture on the phone (docs/BLE_PROTOCOL.md §3.4): VIEW records, opened by the
// transport (direction 3), reassembled into JPEG images in memory. Nothing here stores, logs or
// reports a record or an image: the images go to the setup flow's listeners only, and every buffer
// still open is zeroed when the stream starts again or stops.
//
// Record: [kind 0x01][ver 1][frame u8][rsv 0][total u16 LE][offset u16 LE][data]. At most 2 images
// open, records in offset order (a running `next` is enough); a record off its image's place, past
// `total`, with a `total` above 6144 or different from its image's gives that image up; a new image
// with 2 open gives up the older. A complete or given-up image is acknowledged once (COMMAND 11);
// a frame number among the last 128 finished is ignored. Every stream numbers its images from 1
// again, so `start()` forgets them before the phone asks for a stream that is not on.

export const VIEW_KIND_JPEG = 0x01;
export const VIEW_VERSION = 1;
export const VIEW_HDR = 8;
export const VIEW_MAX_JPEG = 6144;
/** Images reassembled at once. */
export const VIEW_SLOTS = 2;
/** Frame numbers remembered as finished (complete or given up). */
export const VIEW_DONE_MEMORY = 128;

export interface ViewImage {
  frame: number;
  jpeg: Uint8Array;
}

/** What one record did: an image it completed, and the frames to acknowledge (complete or given up). */
export interface ViewPut {
  image: ViewImage | null;
  acks: number[];
}

export interface ViewAssembler {
  /** One opened record. */
  put(record: ArrayLike<number>): ViewPut;
  /** A new stream: the finished frames forgotten, the open images zeroed and dropped unacknowledged. */
  start(): void;
  /** The stream stopped: the open images zeroed and dropped. */
  wipe(): void;
  /** Images open now (tests). */
  open(): number;
}

interface Slot {
  frame: number;
  total: number;
  next: number;
  buf: Uint8Array;
}

const NONE: ViewPut = Object.freeze({ image: null, acks: [] }) as ViewPut;

/** `alloc`: an image's buffer (tests check that the open ones are zeroed). */
export function createViewAssembler(o: { alloc?: (n: number) => Uint8Array } = {}): ViewAssembler {
  const alloc = o.alloc ?? ((n: number) => new Uint8Array(n));
  /** oldest first */
  let slots: Slot[] = [];
  let done: number[] = [];

  function finish(f: number): void {
    done.push(f);
    if (done.length > VIEW_DONE_MEMORY) done = done.slice(done.length - VIEW_DONE_MEMORY);
  }

  function drop(s: Slot): void {
    s.buf.fill(0);
    slots = slots.filter((x) => x !== s);
  }

  function giveUp(s: Slot, acks: number[]): void {
    drop(s);
    finish(s.frame);
    acks.push(s.frame);
  }

  function wipeAll(): void {
    for (const s of slots) s.buf.fill(0);
    slots = [];
  }

  return {
    put(rec) {
      if (rec.length < VIEW_HDR || rec[0] !== VIEW_KIND_JPEG || rec[1] !== VIEW_VERSION) return NONE;
      const f = rec[2]!;
      const total = rec[4]! | (rec[5]! << 8);
      const offset = rec[6]! | (rec[7]! << 8);
      const len = rec.length - VIEW_HDR;
      if (f === 0 || done.includes(f)) return NONE;
      const acks: number[] = [];
      let s = slots.find((x) => x.frame === f);
      if (!s) {
        if (slots.length >= VIEW_SLOTS) giveUp(slots[0]!, acks);
        if (total < 1 || total > VIEW_MAX_JPEG) {
          finish(f);
          acks.push(f);
          return { image: null, acks };
        }
        s = { frame: f, total, next: 0, buf: alloc(total) };
        slots.push(s);
      }
      if (offset !== s.next || offset + len > s.total || total !== s.total) {
        giveUp(s, acks);
        return { image: null, acks };
      }
      for (let i = 0; i < len; i++) s.buf[offset + i] = rec[VIEW_HDR + i]!;
      s.next += len;
      if (s.next < s.total) return acks.length ? { image: null, acks } : NONE;
      slots = slots.filter((x) => x !== s);
      finish(f);
      acks.push(f);
      // The slot's buffer becomes the image: the listener owns it from here.
      return { image: { frame: f, jpeg: s.buf }, acks };
    },
    start() {
      wipeAll();
      done = [];
    },
    wipe: wipeAll,
    open: () => slots.length,
  };
}

const B64 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';

/** Standard base64 with padding. */
export function toBase64(bytes: ArrayLike<number>): string {
  let out = '';
  let i = 0;
  for (; i + 2 < bytes.length; i += 3) {
    const n = (bytes[i]! << 16) | (bytes[i + 1]! << 8) | bytes[i + 2]!;
    out += B64[(n >> 18) & 63]! + B64[(n >> 12) & 63]! + B64[(n >> 6) & 63]! + B64[n & 63]!;
  }
  const rest = bytes.length - i;
  if (rest === 1) {
    const n = bytes[i]! << 16;
    out += `${B64[(n >> 18) & 63]!}${B64[(n >> 12) & 63]!}==`;
  } else if (rest === 2) {
    const n = (bytes[i]! << 16) | (bytes[i + 1]! << 8);
    out += `${B64[(n >> 18) & 63]!}${B64[(n >> 12) & 63]!}${B64[(n >> 6) & 63]!}=`;
  }
  return out;
}

/** An image as the URI the aiming screen shows (never cached: the screen loads it with `cachePolicy="none"`). */
export const jpegDataUri = (jpeg: ArrayLike<number>): string => `data:image/jpeg;base64,${toBase64(jpeg)}`;

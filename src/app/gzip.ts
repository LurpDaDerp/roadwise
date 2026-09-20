/**
 * A gzip container around uncompressed bytes: RFC 1952 framing over RFC 1951 "stored" blocks.
 *
 * The finalizer promises `fs.writeGzip` and crash recovery cannot finalize a drive without it,
 * but M1 shipped no adapter and no deflate lives in the dependency list. A stored-block stream
 * is a valid deflate stream that every gunzip reads — the server's trace check and Node's
 * `zlib` alike — so correctness is not traded, only size: a trace on disk is as big as its
 * JSON. When a compressor arrives, it replaces the body of `gzipStored` and nothing else.
 */

/** A stored block carries at most this many bytes (its length is a 16-bit field). */
const MAX_STORED_BLOCK = 65_535;

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n += 1) {
    let c = n;
    for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  return table;
})();

/** CRC-32 (IEEE 802.3), as gzip's trailer wants it. */
export function crc32(bytes: Uint8Array): number {
  let c = 0xffffffff;
  for (const byte of bytes) c = (CRC_TABLE[(c ^ byte) & 0xff] ?? 0) ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

/** `bytes` as a gzip stream with no compression applied. `mtimeS` is the header's timestamp. */
export function gzipStored(bytes: Uint8Array, mtimeS = 0): Uint8Array {
  const blocks = Math.max(1, Math.ceil(bytes.length / MAX_STORED_BLOCK));
  const out = new Uint8Array(10 + bytes.length + blocks * 5 + 8);
  const view = new DataView(out.buffer);

  // Header: magic, method 8 (deflate), no flags, mtime, no extra flags, OS unknown.
  out.set([0x1f, 0x8b, 0x08, 0x00]);
  view.setUint32(4, mtimeS >>> 0, true);
  out[8] = 0x00;
  out[9] = 0xff;

  let at = 10;
  for (let i = 0; i < blocks; i += 1) {
    const start = i * MAX_STORED_BLOCK;
    const end = Math.min(bytes.length, start + MAX_STORED_BLOCK);
    const len = end - start;
    // BFINAL on the last block, BTYPE 00 (stored); then LEN and its one's complement.
    out[at] = i === blocks - 1 ? 0x01 : 0x00;
    view.setUint16(at + 1, len, true);
    view.setUint16(at + 3, ~len & 0xffff, true);
    at += 5;
    out.set(bytes.subarray(start, end), at);
    at += len;
  }

  view.setUint32(at, crc32(bytes), true);
  view.setUint32(at + 4, bytes.length >>> 0, true);
  return out;
}

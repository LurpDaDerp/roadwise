/**
 * Real deflate for the drive trace (plan R3, D2): `fflate`'s `gzipSync` at level 6.
 *
 * M2 wrapped the trace in stored (uncompressed) deflate blocks because no compressor was in the
 * dependency list; this replaces that body and nothing else — the finalizer still calls
 * `fs.writeGzip(path, bytes)`, and every gunzip (the server's trace check, Node's `zlib`) reads the
 * result. Once per finished drive, while the car is stationary, off the 1 Hz path. Its cost on
 * Hermes (no JIT) is **not yet measured**: a 3 h trace is ~10.8k rows, ~2 MB after the bridge
 * rounds them, and could take 0.5 s or more at level 6 (review D2 m4). The device pass times it
 * around `writeGzip`; over 0.5 s, level 1 is compared (size against time) before level 6 ships.
 *
 * `mtime: 0` leaves the header's timestamp empty, so the same rows always make the same file — a
 * re-finalize after a crash rewrites identical bytes, and nothing about when it was written leaks
 * into the object.
 */
import { gzipSync } from 'fflate';

/** Deflate level: fflate's default, where size stops improving meaningfully for this data. */
export const GZIP_LEVEL = 6;

/** `bytes` as a gzip stream. */
export function gzip(bytes: Uint8Array): Uint8Array {
  return gzipSync(bytes, { level: GZIP_LEVEL, mtime: 0 });
}

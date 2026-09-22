/** @jest-environment node */
import { gunzipSync as fflateGunzip } from 'fflate';

import { gzip } from '@/boot/gzip';
import { canonicalJson } from '@/core/engine/finalize';
import type { FeatureRow } from '@/core/engine/types';

// Jest compiles this suite to CommonJS, so `require` is real at run time. The root tsconfig's
// `types` is `["jest"]`, so Node's own typings are not in the program and the shape is local.
// eslint-disable-next-line @typescript-eslint/no-require-imports -- see above: `import` would need @types/node
const { gunzipSync } = require('node:zlib') as { gunzipSync: (buf: Uint8Array) => Uint8Array };

const text = (s: string) => new TextEncoder().encode(s);
/** Read back the way the server's trace check does: Node's zlib, not the library that wrote it. */
const roundTrip = (bytes: Uint8Array) => new Uint8Array(gunzipSync(gzip(bytes)));

/** Byte equality without Jest's element-by-element diff, which takes seconds on a megabyte. */
function sameBytes(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i += 1) if (a[i] !== b[i]) return false;
  return true;
}

/** A seeded generator, so the trace and its size are the same on every run. */
function prng(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (Math.imul(s, 1_103_515_245) + 12_345) >>> 0;
    return s / 2 ** 32;
  };
}

/**
 * A 1 Hz drive as the finalizer writes it (`canonicalJson` of the rows): a car wandering at city
 * speeds with sensor noise on every channel. `digits` is the precision each value carries.
 */
function driveTrace(minBytes: number, digits: 'sensor' | 'double'): Uint8Array {
  const rnd = prng(20260922);
  const q = (x: number, d: number) => (digits === 'double' ? x : Number(x.toFixed(d)));
  const rows: FeatureRow[] = [];
  let lat = 47.6062;
  let lng = -122.333;
  let speed = 13;
  let course = 90;
  let alt = 50;
  let json = '';
  for (let i = 0; json.length < minBytes; i += 1) {
    speed = Math.max(0, speed + (rnd() - 0.5) * 0.6);
    course = (course + (rnd() - 0.5) * 4 + 360) % 360;
    lat += (Math.cos((course * Math.PI) / 180) * speed) / 111_320;
    lng += (Math.sin((course * Math.PI) / 180) * speed) / 75_000;
    alt += (rnd() - 0.5) * 0.3;
    rows.push({
      ts: 1_700_000_000_000 + i * 1000,
      lat: q(lat, 7),
      lng: q(lng, 7),
      hAcc: q(3 + rnd() * 5, 2),
      speed: q(speed, 2),
      speedAcc: q(0.3 + rnd() * 0.5, 2),
      course: q(course, 1),
      alt: q(alt, 2),
      gnssValid: true,
      aLonMax: q(rnd() * 0.1, 4),
      aLonMin: q(-rnd() * 0.1, 4),
      aLatMax: q(rnd() * 0.1, 4),
      aLatMin: q(-rnd() * 0.1, 4),
      yawRateMax: q(rnd() * 0.2, 4),
      jerkMax: q(rnd() * 0.5, 4),
      gravityStability: q(0.9 + rnd() * 0.1, 4),
      orientationDelta: q(rnd() * 0.05, 4),
      handlingScore: q(rnd() * 0.1, 4),
      locked: false,
      screenOn: true,
      appForeground: true,
    });
    // Re-serialising every row would be quadratic; every 500 rows is plenty to find the size.
    if (i % 500 === 0) json = canonicalJson(rows);
  }
  return text(canonicalJson(rows));
}

test('a gzip stream: magic, deflate, and what went in comes back out', () => {
  const out = gzip(text('{"rows":[{"ts":1}]}'));
  expect([...out.slice(0, 3)]).toEqual([0x1f, 0x8b, 0x08]);
  expect(new TextDecoder().decode(roundTrip(text('{"rows":[{"ts":1}]}')))).toBe(
    '{"rows":[{"ts":1}]}'
  );
});

test('empty input is still a valid stream', () => {
  expect(roundTrip(new Uint8Array())).toEqual(new Uint8Array());
});

test('the same bytes always make the same file: no timestamp in the header', () => {
  const bytes = text('[{"ts":1},{"ts":2}]');
  const out = gzip(bytes);
  expect([...out.slice(4, 8)]).toEqual([0, 0, 0, 0]);
  expect(gzip(bytes)).toEqual(out);
});

test('a 1 MB trace round-trips byte for byte and shrinks below a quarter of its size', () => {
  const trace = driveTrace(1_000_000, 'sensor');
  expect(trace.length).toBeGreaterThanOrEqual(1_000_000);

  const out = gzip(trace);

  expect(sameBytes(new Uint8Array(gunzipSync(out)), trace)).toBe(true);
  expect(sameBytes(fflateGunzip(out), trace)).toBe(true);
  expect(out.length / trace.length).toBeLessThan(0.25);
});

test('rows carrying full-precision doubles still shrink to under a third (measured ~0.30)', () => {
  // What a native module that emits unrounded doubles produces: the last digits are noise, and
  // noise does not compress. Recorded so the ratio is known, not assumed (see the D2 report).
  const trace = driveTrace(1_000_000, 'double');
  const out = gzip(trace);
  expect(sameBytes(new Uint8Array(gunzipSync(out)), trace)).toBe(true);
  expect(out.length / trace.length).toBeLessThan(1 / 3);
});

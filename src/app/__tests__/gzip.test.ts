/** @jest-environment node */
import { crc32, gzipStored } from '@/app/gzip';

// Jest compiles this suite to CommonJS, so `require` is real at run time. The root tsconfig's
// `types` is `["jest"]`, so Node's own typings are not in the program and the shape is local.
// eslint-disable-next-line @typescript-eslint/no-require-imports -- see above: `import` would need @types/node
const { gunzipSync } = require('node:zlib') as { gunzipSync: (buf: Uint8Array) => Uint8Array };

const text = (s: string) => new TextEncoder().encode(s);
const roundTrip = (bytes: Uint8Array) => new Uint8Array(gunzipSync(gzipStored(bytes)));

test('crc32 matches the standard check value', () => {
  expect(crc32(text('123456789'))).toBe(0xcbf43926);
  expect(crc32(new Uint8Array())).toBe(0);
});

test('a gzip stream: magic, deflate, and what went in comes back out', () => {
  const out = gzipStored(text('{"rows":[{"ts":1}]}'), 1_700_000_000);
  expect([...out.slice(0, 3)]).toEqual([0x1f, 0x8b, 0x08]);
  expect(new TextDecoder().decode(roundTrip(text('{"rows":[{"ts":1}]}')))).toBe('{"rows":[{"ts":1}]}');
});

test('empty input is still a valid stream', () => {
  expect(roundTrip(new Uint8Array())).toEqual(new Uint8Array());
});

test('input longer than one stored block is split and still reads back byte for byte', () => {
  const big = new Uint8Array(200_000);
  for (let i = 0; i < big.length; i += 1) big[i] = (i * 7919) & 0xff;
  expect(roundTrip(big)).toEqual(big);
  // Four blocks of five-byte overhead, ten bytes of header, eight of trailer.
  expect(gzipStored(big).length).toBe(10 + big.length + 4 * 5 + 8);
});

import { assert, assertEquals } from '@std/assert';
import { hookKeys, TOLERANCE_S, verifyHook } from './signature.ts';

// A vector computed independently with Python's hmac (key = bytes 0..31):
//   base64(HMAC-SHA256(key, 'msg_2KWPBgLlAfxdpx2AI54pPJ85f4W.1790000000.{"user":{"id":"u"}}'))
// The secret is put together from parts so no scanner takes the test key for a real one.
const KEY_B64 = 'AAECAwQFBgcICQoLDA0ODxAREhMUFRYXGBkaGxwdHh8=';
const SECRET = ['v1,whsec', KEY_B64].join('_');
const ID = 'msg_2KWPBgLlAfxdpx2AI54pPJ85f4W';
const TS = 1790000000;
const BODY = '{"user":{"id":"u"}}';
const SIGNATURE = 'v1,fNMIp8lrntLZBEqtSHIICb1rvSl1N9+SkEiN9ScyCy0=';

const headers = (over: Record<string, string | null> = {}): Headers => {
  const h = new Headers();
  const all: Record<string, string | null> = {
    'webhook-id': ID,
    'webhook-timestamp': String(TS),
    'webhook-signature': SIGNATURE,
    ...over,
  };
  for (const [k, v] of Object.entries(all)) if (v !== null) h.set(k, v);
  return h;
};

const keys = (): Uint8Array<ArrayBuffer>[] => {
  const k = hookKeys(SECRET);
  assert(k !== null);
  return k;
};

Deno.test('the independent vector verifies', async () => {
  assert(await verifyHook(keys(), headers(), BODY, TS));
});

Deno.test('Auth’s list form (signatures joined by ", ") verifies when any one matches', async () => {
  const other = 'v1,' + btoa('x'.repeat(32));
  assert(await verifyHook(keys(), headers({ 'webhook-signature': `${other}, ${SIGNATURE}` }), BODY, TS));
  assert(await verifyHook(keys(), headers({ 'webhook-signature': `${SIGNATURE}, ${other}` }), BODY, TS));
});

Deno.test('a changed body, id or timestamp, or another key, does not verify', async () => {
  assert(!(await verifyHook(keys(), headers(), BODY.replace('"u"', '"v"'), TS)));
  assert(!(await verifyHook(keys(), headers({ 'webhook-id': ID + 'x' }), BODY, TS)));
  assert(!(await verifyHook(keys(), headers({ 'webhook-timestamp': String(TS + 1) }), BODY, TS)));
  const otherKey = hookKeys(['v1,whsec', btoa('k'.repeat(32))].join('_'));
  assert(otherKey !== null);
  assert(!(await verifyHook(otherKey, headers(), BODY, TS)));
});

Deno.test('a call older or newer than the tolerance does not verify', async () => {
  assert(await verifyHook(keys(), headers(), BODY, TS + TOLERANCE_S));
  assert(await verifyHook(keys(), headers(), BODY, TS - TOLERANCE_S));
  assert(!(await verifyHook(keys(), headers(), BODY, TS + TOLERANCE_S + 1)));
  assert(!(await verifyHook(keys(), headers(), BODY, TS - TOLERANCE_S - 1)));
});

Deno.test('missing or malformed headers do not verify', async () => {
  const cases: Record<string, string | null>[] = [
    { 'webhook-id': null },
    { 'webhook-timestamp': null },
    { 'webhook-signature': null },
    { 'webhook-timestamp': '17900000.5' },
    { 'webhook-signature': 'v2,' + SIGNATURE.slice(3) },
    { 'webhook-signature': SIGNATURE.slice(3) },
    { 'webhook-signature': 'v1,%%%' },
    { 'webhook-id': 'x'.repeat(257) },
  ];
  for (const over of cases) {
    assert(!(await verifyHook(keys(), headers(over), BODY, TS)), JSON.stringify(over));
  }
});

Deno.test('the secret must be "v1,whsec_<base64>"; several may be joined with "|" while one is rotated', async () => {
  assertEquals(hookKeys(''), null);
  assertEquals(hookKeys(KEY_B64), null);
  assertEquals(hookKeys(['whsec', KEY_B64].join('_')), null);
  assertEquals(hookKeys(['v1,whsec', '***'].join('_')), null);
  assertEquals(hookKeys(['v1,whsec', btoa('short')].join('_')), null);
  const rotated = hookKeys([['v1,whsec', btoa('k'.repeat(32))].join('_'), SECRET].join('|'));
  assert(rotated !== null);
  assertEquals(rotated.length, 2);
  assert(await verifyHook(rotated, headers(), BODY, TS));
});

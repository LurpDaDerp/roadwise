import { assert, assertEquals } from '@std/assert';
import { signSweep, sweepKeyUsable, verifySweepSignature } from './sweep_auth.ts';

const KEY = 'rw-test-vector-key-0123456789abcdef';
const TS = 1790000000;

Deno.test('the signatures match the SQL side byte for byte (independently computed test vectors)', async () => {
  // 0008 purge_traces_signature and 0007 push_sweep_signature assert the same two values in pgTAP
  assertEquals(await signSweep('purge-trace-objects', KEY, TS), '1790000000.b1d7bb3aa71f004baa5812ff8e039210f30da2d2e7c40a38e735c4364c5f09a3');
  assertEquals(await signSweep('push-sender-sweep', KEY, TS), '1790000000.c1ba00cabb1bd464447aaa98eb43cd7fffaaee9cf3809292c15c696632ca752f');
});

Deno.test('a fresh, correct signature verifies at the window edges and not beyond', async () => {
  const header = await signSweep('purge-trace-objects', KEY, TS);
  assert(await verifySweepSignature(header, 'purge-trace-objects', KEY, TS));
  assert(await verifySweepSignature(header, 'purge-trace-objects', KEY, TS + 120));
  assert(await verifySweepSignature(header, 'purge-trace-objects', KEY, TS - 120));
  assertEquals(await verifySweepSignature(header, 'purge-trace-objects', KEY, TS + 121), false);
  assertEquals(await verifySweepSignature(header, 'purge-trace-objects', KEY, TS - 121), false);
});

Deno.test('anything else is refused: missing, malformed, another purpose, another key, a tampered ts', async () => {
  const good = await signSweep('purge-trace-objects', KEY, TS);
  const [, sig] = good.split('.');
  const refused = [
    null,
    '',
    'no-dot',
    `${TS}.`,
    `.${sig}`,
    `-${TS}.${sig}`,
    `${TS}.${sig!.toUpperCase()}`,
    `${TS}.${sig}00`,
    `0${TS}.${sig}`, // same number, different message bytes
    `${TS + 1}.${sig}`,
    await signSweep('push-sender-sweep', KEY, TS),
    await signSweep('purge-trace-objects', `${KEY}x`, TS),
  ];
  for (const header of refused) {
    assertEquals(await verifySweepSignature(header, 'purge-trace-objects', KEY, TS), false, String(header));
  }
});

Deno.test('a key must be at least 32 UTF-8 bytes', () => {
  assertEquals(sweepKeyUsable(undefined), false);
  assertEquals(sweepKeyUsable('x'.repeat(31)), false);
  assert(sweepKeyUsable('x'.repeat(32)));
  assert(sweepKeyUsable('é'.repeat(16))); // 32 bytes, 16 characters
});

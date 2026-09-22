// The signed-sweep contract a pg_cron job uses to wake an edge function (0007's push-sender sweep,
// 0008's purge-trace-objects): no key travels, only a timestamped HMAC.
//
//   X-Sweep-Signature: <ts>.<sig>
//   <ts>  unix time in whole seconds, decimal, no sign, no padding (1 to 12 digits)
//   <sig> lower-case hex of HMAC-SHA256(key = the UTF-8 bytes of the dedicated secret,
//                                      message = the UTF-8 bytes of '<purpose>:' + <ts>)
//
// The purpose string differs per function, so a signature for one can never be replayed against
// another even if the keys were ever the same. Verification accepts |now - ts| <= 120 s and compares
// in constant time. A replay inside the window only repeats an idempotent sweep.

export const SWEEP_SIGNATURE_HEADER = 'x-sweep-signature';
export const SWEEP_WINDOW_S = 120;
/** A dedicated secret of at least 32 bytes; anything shorter is a misconfiguration. */
export const MIN_SWEEP_KEY_BYTES = 32;

const encoder = new TextEncoder();

/** Whether `key` is long enough to sign with (UTF-8 bytes, as the SQL side's octet_length). */
export const sweepKeyUsable = (key: string | undefined | null): key is string =>
  typeof key === 'string' && encoder.encode(key).length >= MIN_SWEEP_KEY_BYTES;

async function hmacHex(key: string, message: string): Promise<string> {
  const k = await crypto.subtle.importKey('raw', encoder.encode(key), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const sig = new Uint8Array(await crypto.subtle.sign('HMAC', k, encoder.encode(message)));
  return Array.from(sig, (b) => b.toString(16).padStart(2, '0')).join('');
}

/** `<ts>.<sig>` for `purpose` at `ts`: the header value the SQL dispatcher sends. */
export async function signSweep(purpose: string, key: string, ts: number): Promise<string> {
  return `${ts}.${await hmacHex(key, `${purpose}:${ts}`)}`;
}

/** Equal-length string compare whose time does not depend on where the strings differ. */
function constantTimeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i += 1) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

/**
 * True only for a well-formed header, inside the window, whose signature is the HMAC of
 * `'<purpose>:<ts>'` under `key`. Never throws; never logs.
 */
export async function verifySweepSignature(
  header: string | null,
  purpose: string,
  key: string,
  nowS: number
): Promise<boolean> {
  if (header === null) return false;
  const dot = header.indexOf('.');
  if (dot < 0) return false;
  const tsText = header.slice(0, dot);
  const sig = header.slice(dot + 1);
  if (!/^[0-9]{1,12}$/.test(tsText) || !/^[0-9a-f]{64}$/.test(sig)) return false;
  const ts = Number(tsText);
  if (Math.abs(nowS - ts) > SWEEP_WINDOW_S) return false;
  return constantTimeEqual(await hmacHex(key, `${purpose}:${tsText}`), sig);
}

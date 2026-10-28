// The send-email hook's signature check: Standard Webhooks (standardwebhooks.com), as Supabase Auth
// signs every hook call.
//
// Auth's hook secret is configured as "v1,whsec_<base64 key>" (several may be joined with "|" while
// one is rotated). Each call carries `webhook-id`, `webhook-timestamp` (unix seconds) and
// `webhook-signature`: a list of "v1,<base64 HMAC-SHA256(key, id + "." + timestamp + "." + body)>",
// one per secret, separated by spaces (Auth joins them with ", "). A call passes when one of those
// signatures matches one of the keys over the exact body bytes, and its timestamp is within
// `TOLERANCE_S` of now.

/** How far a call's timestamp may be from now, either way, in seconds. */
export const TOLERANCE_S = 5 * 60;

const SECRET_PATTERN = /^v1,whsec_([A-Za-z0-9+/]+={0,2})$/;

function fromBase64(text: string): Uint8Array<ArrayBuffer> | null {
  try {
    const bin = atob(text);
    const out = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
    return out;
  } catch {
    return null;
  }
}

/** The HMAC keys a configured secret holds, or null when it is not "v1,whsec_<base64>" (each, if several). */
export function hookKeys(secret: string): Uint8Array<ArrayBuffer>[] | null {
  const keys: Uint8Array<ArrayBuffer>[] = [];
  for (const part of secret.split('|')) {
    const m = SECRET_PATTERN.exec(part.trim());
    const key = m ? fromBase64(m[1]) : null;
    if (key === null || key.byteLength < 16) return null;
    keys.push(key);
  }
  return keys.length > 0 ? keys : null;
}

async function hmac(key: Uint8Array<ArrayBuffer>, message: string): Promise<Uint8Array> {
  const k = await crypto.subtle.importKey('raw', key, { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  return new Uint8Array(await crypto.subtle.sign('HMAC', k, new TextEncoder().encode(message)));
}

/** Equal length and bytes, without stopping at the first difference. */
function sameBytes(a: Uint8Array, b: Uint8Array): boolean {
  if (a.byteLength !== b.byteLength) return false;
  let diff = 0;
  for (let i = 0; i < a.byteLength; i++) diff |= a[i] ^ b[i];
  return diff === 0;
}

/** True when the call is signed by one of `keys` over `body` and was made within `TOLERANCE_S` of `nowS`. */
export async function verifyHook(keys: Uint8Array<ArrayBuffer>[], headers: Headers, body: string, nowS: number): Promise<boolean> {
  const id = headers.get('webhook-id');
  const timestamp = headers.get('webhook-timestamp');
  const signatures = headers.get('webhook-signature');
  if (!id || id.length > 256 || !timestamp || !signatures) return false;
  if (!/^\d{1,12}$/.test(timestamp) || Math.abs(nowS - Number(timestamp)) > TOLERANCE_S) return false;
  const given = signatures
    .split(/\s+/)
    .map((s) => s.replace(/,$/, ''))
    .filter((s) => s.startsWith('v1,'))
    .map((s) => fromBase64(s.slice(3)))
    .filter((s): s is Uint8Array<ArrayBuffer> => s !== null);
  if (given.length === 0) return false;
  const signed = `${id}.${timestamp}.${body}`;
  for (const key of keys) {
    const expected = await hmac(key, signed);
    if (given.some((g) => sameBytes(g, expected))) return true;
  }
  return false;
}

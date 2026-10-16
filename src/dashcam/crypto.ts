// The link v2 primitives (docs/BLE_PROTOCOL.md §2.2, §3.3): X25519 (RFC 7748), SHA-256,
// HMAC-SHA-256, HKDF-SHA-256 (RFC 5869) and AES-128-GCM (12-byte nonce, 16-byte tag), over the
// noble libraries (pure JavaScript, audited), plus random bytes and a constant-time compare.
//
// Random bytes come from `globalThis.crypto.getRandomValues`, looked up at each call: Hermes has
// none of its own, and `react-native-get-random-values` (the first import of `index.ts`) installs
// it. noble's own `randomBytes` and `randomSecretKey` are never used here, since noble captures
// `globalThis.crypto` once when its module loads, possibly before the polyfill. A scalar is always
// passed to X25519 explicitly.
import { x25519 } from '@noble/curves/ed25519';
import { gcm } from '@noble/ciphers/aes';
import { hkdf } from '@noble/hashes/hkdf';
import { hmac } from '@noble/hashes/hmac';
import { sha256 as nobleSha256 } from '@noble/hashes/sha2';

export class RandomUnavailableError extends Error {
  constructor() {
    super('no secure random source (crypto.getRandomValues) on this phone');
    this.name = 'RandomUnavailableError';
  }
}

/** `n` random bytes from the platform's secure source, read at call time. Throws when there is none. */
export function randomBytes(n: number): Uint8Array {
  const c = (globalThis as { crypto?: { getRandomValues?: (a: Uint8Array) => Uint8Array } }).crypto;
  if (!c || typeof c.getRandomValues !== 'function') throw new RandomUnavailableError();
  const out = new Uint8Array(n);
  c.getRandomValues(out);
  return out;
}

const encoder = new TextEncoder();

/** ASCII / UTF-8 bytes of a label (labels carry no terminator). */
export const utf8 = (s: string): Uint8Array => encoder.encode(s);

export function concat(...parts: ArrayLike<number>[]): Uint8Array {
  let n = 0;
  for (const p of parts) n += p.length;
  const out = new Uint8Array(n);
  let i = 0;
  for (const p of parts) {
    out.set(p, i);
    i += p.length;
  }
  return out;
}

export const sha256 = (...parts: ArrayLike<number>[]): Uint8Array => nobleSha256(concat(...parts));

export const hmacSha256 = (key: Uint8Array, ...parts: ArrayLike<number>[]): Uint8Array => hmac(nobleSha256, key, concat(...parts));

export const hkdfSha256 = (salt: Uint8Array, ikm: Uint8Array, info: Uint8Array, length: number): Uint8Array => hkdf(nobleSha256, ikm, salt, info, length);

/** The X25519 public key of a 32-byte private scalar (clamped by X25519 itself). */
export const x25519Public = (priv: Uint8Array): Uint8Array => x25519.getPublicKey(priv);

/** The shared secret, or null when the peer's key is refused (a low-order point: an all-zero result). */
export function x25519Shared(priv: Uint8Array, peer: Uint8Array): Uint8Array | null {
  if (peer.length !== 32) return null;
  try {
    const z = x25519.getSharedSecret(priv, peer);
    return z.every((b) => b === 0) ? null : z;
  } catch {
    return null;
  }
}

/** AES-128-GCM: ciphertext followed by the 16-byte tag. */
export const gcmSeal = (key: Uint8Array, nonce: Uint8Array, aad: Uint8Array, plain: Uint8Array): Uint8Array => gcm(key, nonce, aad).encrypt(plain);

/** AES-128-GCM open of ciphertext + tag; null when the tag does not verify. */
export function gcmOpen(key: Uint8Array, nonce: Uint8Array, aad: Uint8Array, sealed: Uint8Array): Uint8Array | null {
  if (sealed.length < 16) return null;
  try {
    return gcm(key, nonce, aad).decrypt(sealed);
  } catch {
    return null;
  }
}

/** Equal length and bytes, in time that depends only on the length. */
export function ctEqual(a: ArrayLike<number>, b: ArrayLike<number>): boolean {
  if (a.length !== b.length) return false;
  let d = 0;
  for (let i = 0; i < a.length; i++) d |= (a[i]! ^ b[i]!) & 0xff;
  return d === 0;
}

/** Overwrite a secret buffer with zeros (best effort: JavaScript may hold copies). */
export function wipe(b: Uint8Array | null | undefined): void {
  b?.fill(0);
}

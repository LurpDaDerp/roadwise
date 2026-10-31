import { ctr } from '@noble/ciphers/aes';
import { bytesToHex, hexToBytes } from '@noble/ciphers/utils';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { getRandomBytes } from 'expo-crypto';
import * as SecureStore from 'expo-secure-store';

/**
 * UTF-8 by percent-encoding: `encodeURI` writes every non-ASCII codepoint (astral ones from their
 * surrogate pair) as its UTF-8 bytes in %XX form and leaves the rest as single ASCII bytes. These
 * are the bytes every stored blob was written from, and neither direction depends on
 * TextEncoder/TextDecoder being present on the platform. A lone surrogate throws (URIError), so a
 * string that is not valid Unicode fails the save rather than being stored altered.
 */
function utf8ToBytes(text: string): Uint8Array {
  const escaped = encodeURI(text);
  const bytes: number[] = [];
  for (let i = 0; i < escaped.length; i++) {
    const c = escaped.charCodeAt(i);
    if (c === 37) {
      bytes.push(parseInt(escaped.slice(i + 1, i + 3), 16));
      i += 2;
    } else {
      bytes.push(c);
    }
  }
  return Uint8Array.from(bytes);
}

function utf8FromBytes(bytes: Uint8Array): string {
  return decodeURIComponent(Array.from(bytes, (b) => `%${b.toString(16).padStart(2, '0')}`).join(''));
}

/**
 * The counter of a blob from before `v2:`: the 128-bit big-endian value 1 (15 zero bytes, then 1).
 * AES-CTR here carries across all 16 counter bytes, so a counter block never repeats inside one blob.
 */
const LEGACY_COUNTER = Uint8Array.from({ length: 16 }, (_, i) => (i === 15 ? 1 : 0));

/** A blob written with its own random counter: `v2:` + 16 counter bytes + the ciphertext, in hex. */
const BLOB_V2 = 'v2:';
const COUNTER_HEX = 32;
/** A stored 32-byte key, as `setItem` writes it. */
const KEY_HEX = /^[0-9a-f]{64}$/;

/**
 * Supabase's documented large-value storage adapter. SecureStore refuses values past ~2048 bytes
 * and a persisted session (access token + refresh token + user) is well over that, so the session
 * is stored as AES-256-CTR ciphertext in AsyncStorage while only its 32-byte key goes into the
 * Keychain / Keystore. AsyncStorage never holds plaintext, and dropping the key makes the stored
 * blob unreadable.
 *
 * The key is made once and kept until the session goes (`removeItem`): a save after the first
 * writes only the blob, with a fresh random counter, so a save cut short (the app killed, a failed
 * write) leaves the last blob or the new one, either readable with the one key. A blob from before
 * (no `v2:`, the fixed counter 1, under a key minted with it) still reads, and the next save turns
 * it into the new form under the same key.
 */
export class LargeSecureStore {
  private decrypt(hex: string, value: string): string {
    const key = hexToBytes(hex);
    if (value.startsWith(BLOB_V2)) {
      const body = value.slice(BLOB_V2.length);
      const cipher = ctr(key, hexToBytes(body.slice(0, COUNTER_HEX)));
      return utf8FromBytes(cipher.decrypt(hexToBytes(body.slice(COUNTER_HEX))));
    }
    return utf8FromBytes(ctr(key, LEGACY_COUNTER).decrypt(hexToBytes(value)));
  }

  /** Best effort on both halves: dropping a session must never be what fails. */
  private async purge(key: string): Promise<void> {
    try {
      await AsyncStorage.removeItem(key);
    } catch {
      // ignored: the entry is being discarded anyway
    }
    try {
      await SecureStore.deleteItemAsync(key);
    } catch {
      // ignored: the key is being discarded anyway
    }
  }

  async getItem(key: string): Promise<string | null> {
    const encrypted = await AsyncStorage.getItem(key);
    if (!encrypted) return null;

    // Read the key outside the corruption guard below. A rejection here is transient - an iOS
    // keychain errSecInteractionNotAllowed because the runtime started on a locked device (a
    // background drive-detection launch does exactly that), or a busy Android Keystore - and
    // deleting on it would sign the user out for good. Returning null reads to supabase-js as
    // "no session", which does not trigger removeItem, so both halves survive to the next
    // unlocked launch.
    let hex: string | null = null;
    try {
      hex = await SecureStore.getItemAsync(key);
    } catch {
      return null;
    }

    if (!hex) {
      // The key really is gone (a reinstall, a Keychain reset) while the blob survives: it can
      // never be read again, so drop both halves rather than trip over it on every launch.
      await this.purge(key);
      return null;
    }

    try {
      return this.decrypt(hex, encrypted);
    } catch {
      // A truncated or half-written blob. Swallow the cause rather than surface it: the hex
      // decoder and SecureStore can put raw input into their messages, and there is nothing here
      // a caller can act on.
      await this.purge(key);
      return null;
    }
  }

  async setItem(key: string, value: string): Promise<void> {
    // A keychain that cannot be read now (a locked device) fails the save: minting a new key over
    // one that may still be there would strand the blob it reads.
    let hex = await SecureStore.getItemAsync(key);
    if (hex === null || !KEY_HEX.test(hex)) {
      hex = bytesToHex(getRandomBytes(32));
      await SecureStore.setItemAsync(key, hex, {
        // The default (WHEN_UNLOCKED) is unreadable on a background launch while the phone is
        // locked, which is precisely when drive detection wakes the app.
        keychainAccessible: SecureStore.AFTER_FIRST_UNLOCK,
      });
    }
    // A fresh counter for every save: one key never encrypts two blobs from the same counter.
    const counter = getRandomBytes(16);
    const encrypted = ctr(hexToBytes(hex), counter).encrypt(utf8ToBytes(value));
    await AsyncStorage.setItem(key, BLOB_V2 + bytesToHex(counter) + bytesToHex(encrypted));
  }

  async removeItem(key: string): Promise<void> {
    await this.purge(key);
  }
}

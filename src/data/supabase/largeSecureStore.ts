import AsyncStorage from '@react-native-async-storage/async-storage';
import * as aesjs from 'aes-js';
import { getRandomBytes } from 'expo-crypto';
import * as SecureStore from 'expo-secure-store';

/**
 * aes-js decodes at most three bytes per character, so every astral-plane codepoint (an emoji in a
 * Google display name, say) comes back mangled and takes the surrounding JSON with it. Percent-
 * decoding is the same trick aes-js uses when encoding, run in reverse, and it is correct for the
 * full range without depending on TextDecoder being present on the platform.
 */
function utf8FromBytes(bytes: Uint8Array): string {
  return decodeURIComponent(Array.from(bytes, (b) => `%${b.toString(16).padStart(2, '0')}`).join(''));
}

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
    const key = aesjs.utils.hex.toBytes(hex);
    if (value.startsWith(BLOB_V2)) {
      const body = value.slice(BLOB_V2.length);
      const cipher = new aesjs.ModeOfOperation.ctr(key, new aesjs.Counter(aesjs.utils.hex.toBytes(body.slice(0, COUNTER_HEX))));
      return utf8FromBytes(cipher.decrypt(aesjs.utils.hex.toBytes(body.slice(COUNTER_HEX))));
    }
    const cipher = new aesjs.ModeOfOperation.ctr(key, new aesjs.Counter(1));
    return utf8FromBytes(cipher.decrypt(aesjs.utils.hex.toBytes(value)));
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
      // A truncated or half-written blob. Swallow the cause rather than surface it: aes-js and
      // SecureStore put key material and raw input into their messages, and there is nothing here
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
      hex = aesjs.utils.hex.fromBytes(getRandomBytes(32));
      await SecureStore.setItemAsync(key, hex, {
        // The default (WHEN_UNLOCKED) is unreadable on a background launch while the phone is
        // locked, which is precisely when drive detection wakes the app.
        keychainAccessible: SecureStore.AFTER_FIRST_UNLOCK,
      });
    }
    // A fresh counter for every save: one key never encrypts two blobs from the same counter.
    const counter = getRandomBytes(16);
    const cipher = new aesjs.ModeOfOperation.ctr(aesjs.utils.hex.toBytes(hex), new aesjs.Counter(counter));
    const encrypted = cipher.encrypt(aesjs.utils.utf8.toBytes(value));
    await AsyncStorage.setItem(key, BLOB_V2 + aesjs.utils.hex.fromBytes(counter) + aesjs.utils.hex.fromBytes(encrypted));
  }

  async removeItem(key: string): Promise<void> {
    await this.purge(key);
  }
}

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

/**
 * Supabase's documented large-value storage adapter. SecureStore refuses values past ~2048 bytes
 * and a persisted session (access token + refresh token + user) is well over that, so the session
 * is stored as AES-256-CTR ciphertext in AsyncStorage while only its 32-byte key goes into the
 * Keychain / Keystore. AsyncStorage never holds plaintext, and dropping the key makes the stored
 * blob unreadable.
 */
export class LargeSecureStore {
  private decrypt(hex: string, value: string): string {
    const cipher = new aesjs.ModeOfOperation.ctr(aesjs.utils.hex.toBytes(hex), new aesjs.Counter(1));
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
    const encryptionKey = getRandomBytes(32);
    const cipher = new aesjs.ModeOfOperation.ctr(encryptionKey, new aesjs.Counter(1));
    const encrypted = cipher.encrypt(aesjs.utils.utf8.toBytes(value));
    await SecureStore.setItemAsync(key, aesjs.utils.hex.fromBytes(encryptionKey), {
      // The default (WHEN_UNLOCKED) is unreadable on a background launch while the phone is
      // locked, which is precisely when drive detection wakes the app.
      keychainAccessible: SecureStore.AFTER_FIRST_UNLOCK,
    });
    await AsyncStorage.setItem(key, aesjs.utils.hex.fromBytes(encrypted));
  }

  async removeItem(key: string): Promise<void> {
    await this.purge(key);
  }
}

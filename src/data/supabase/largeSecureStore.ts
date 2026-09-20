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
  private async encrypt(key: string, value: string): Promise<string> {
    const encryptionKey = getRandomBytes(32);
    const cipher = new aesjs.ModeOfOperation.ctr(encryptionKey, new aesjs.Counter(1));
    const encrypted = cipher.encrypt(aesjs.utils.utf8.toBytes(value));
    await SecureStore.setItemAsync(key, aesjs.utils.hex.fromBytes(encryptionKey));
    return aesjs.utils.hex.fromBytes(encrypted);
  }

  private async decrypt(key: string, value: string): Promise<string | null> {
    const hex = await SecureStore.getItemAsync(key);
    if (!hex) return null;
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

    let decrypted: string | null = null;
    try {
      decrypted = await this.decrypt(key, encrypted);
    } catch {
      // A reinstall, a Keychain reset or a half-written blob leaves something that cannot be
      // decrypted. Swallow the cause rather than surface it: aes-js and SecureStore put key
      // material and raw input into their messages, and there is nothing here a caller can act on.
      decrypted = null;
    }

    if (decrypted === null) {
      // Self-heal, so the next sign-in starts clean instead of tripping over the same blob forever.
      await this.purge(key);
      return null;
    }
    return decrypted;
  }

  async setItem(key: string, value: string): Promise<void> {
    await AsyncStorage.setItem(key, await this.encrypt(key, value));
  }

  async removeItem(key: string): Promise<void> {
    await this.purge(key);
  }
}

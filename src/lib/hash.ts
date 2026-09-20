import { CryptoDigestAlgorithm, digestStringAsync } from 'expo-crypto';

/** Lowercase hex SHA-256 of a UTF-8 string — the trace digest the finalizer sends the server. */
export const sha256Hex = (text: string): Promise<string> =>
  digestStringAsync(CryptoDigestAlgorithm.SHA256, text);

import { sha256Hex } from '@/lib/hash';

// babel-plugin-jest-hoist lifts this above the import at transform time.
jest.mock('expo-crypto', () => ({
  CryptoDigestAlgorithm: { SHA256: 'SHA-256' },
  digestStringAsync: jest.fn(async (algorithm: string, data: string) => `${algorithm}:${data}`),
}));

test('sha256Hex asks expo-crypto for a SHA-256 of the exact text', async () => {
  await expect(sha256Hex('[{"ts":1}]')).resolves.toBe('SHA-256:[{"ts":1}]');
});

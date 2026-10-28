/** @jest-environment node */
// The handover and account-deletion wipe takes the leaving account's App Attest record (its id and its
// key's id) with everything else; only this install's attestation budget stays.
import { wipeDevice } from '@/boot/device';
import { createSqlJsDb } from '@/data/db/__fixtures__/sqljsDriver';
import { migrate } from '@/data/db';
import { APP_ATTEST_STORE_KEY } from '@/data/devices/appAttest';

const mockItems = new Map<string, string>();
jest.mock('expo-secure-store', () => ({
  AFTER_FIRST_UNLOCK: 'afterFirstUnlock',
  AFTER_FIRST_UNLOCK_THIS_DEVICE_ONLY: 'afterFirstUnlockThisDeviceOnly',
  getItemAsync: async (key: string) => mockItems.get(key) ?? null,
  setItemAsync: async (key: string, value: string) => {
    mockItems.set(key, value);
  },
  deleteItemAsync: async (key: string) => {
    mockItems.delete(key);
  },
}));
jest.mock('expo-notifications', () => ({}));

test('wipeDevice leaves nothing of the last account in the App Attest record, only the day’s attestations', async () => {
  const db = await createSqlJsDb();
  await migrate(db);
  const keyId = `${'K'.repeat(43)}=`;
  mockItems.set(APP_ATTEST_STORE_KEY, JSON.stringify({ owner: 'user-1', keyId, attested: true, tries: [1_700_000_000_000] }));
  await wipeDevice(db);
  expect(JSON.parse(mockItems.get(APP_ATTEST_STORE_KEY)!)).toEqual({ owner: null, keyId: null, attested: false, tries: [1_700_000_000_000] });
});

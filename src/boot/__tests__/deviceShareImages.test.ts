/** @jest-environment node */
import { wipeDevice, wipeForSignOut } from '@/boot/device';
import { createSqlJsDb } from '@/data/db/__fixtures__/sqljsDriver';
import { migrate, type Db } from '@/data/db';

jest.mock('expo-notifications', () => ({}));
const mockSweep = jest.fn();
jest.mock('@/lib/shareImages', () => ({ sweepShareImages: () => mockSweep() }));

let db: Db;
beforeEach(async () => {
  db = await createSqlJsDb();
  await migrate(db);
  mockSweep.mockClear();
});

test('Delete account, an account switch and a sign-out each sweep the share images a crash left', async () => {
  await wipeDevice(db);
  expect(mockSweep).toHaveBeenCalledTimes(1);
  await wipeForSignOut(db);
  expect(mockSweep).toHaveBeenCalledTimes(2);
});

test('Delete account and an account switch delete the App Attest record older builds kept; a sign-out leaves the store alone', async () => {
  // eslint-disable-next-line @typescript-eslint/no-require-imports -- the jest.setup mock
  const store = require('expo-secure-store') as { deleteItemAsync: jest.Mock };
  store.deleteItemAsync.mockClear();
  await wipeDevice(db);
  expect(store.deleteItemAsync).toHaveBeenCalledWith('roadwise.appAttest');
  store.deleteItemAsync.mockClear();
  await wipeForSignOut(db);
  expect(store.deleteItemAsync).not.toHaveBeenCalled();
});

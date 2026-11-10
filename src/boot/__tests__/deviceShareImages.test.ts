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

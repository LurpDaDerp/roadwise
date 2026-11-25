/** @jest-environment node */
// "Are you driving?" asks only with the notification permission and its switch on (Settings ›
// Notifications › "Are you driving?"): off reads as not allowed, so the host never posts it.
import { createSqlJsDb } from '@/data/db/__fixtures__/sqljsDriver';
import { createSettingsRepo, migrate, type Db } from '@/data/db';
import { ARE_YOU_DRIVING_KEY } from '@/features/settings/notifications/localSwitches';

import { createPassengerNotePort } from '../passengerNote';

let mockGranted = true;
jest.mock('expo-notifications', () => ({
  getPermissionsAsync: async () => ({ granted: mockGranted, ios: { status: mockGranted ? 2 : 1 } }),
  IosAuthorizationStatus: { NOT_DETERMINED: 0, DENIED: 1, AUTHORIZED: 2, PROVISIONAL: 3 },
}));

let db: Db;
beforeEach(async () => {
  db = await createSqlJsDb();
  await migrate(db);
  mockGranted = true;
});

test('allowed with the permission granted and the switch on until switched off', async () => {
  expect(await createPassengerNotePort(db).notificationsAllowed()).toBe(true);
  await createSettingsRepo(db).set(ARE_YOU_DRIVING_KEY, false);
  expect(await createPassengerNotePort(db).notificationsAllowed()).toBe(false);
  await createSettingsRepo(db).set(ARE_YOU_DRIVING_KEY, true);
  expect(await createPassengerNotePort(db).notificationsAllowed()).toBe(true);
});

test('not allowed without the permission, whatever the switch', async () => {
  mockGranted = false;
  expect(await createPassengerNotePort(db).notificationsAllowed()).toBe(false);
});

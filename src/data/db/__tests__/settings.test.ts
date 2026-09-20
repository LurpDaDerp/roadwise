/** @jest-environment node */
import { createSqlJsDb } from '@/data/db/__fixtures__/sqljsDriver';
import type { Db } from '@/data/db/driver';
import { migrate } from '@/data/db/migrate';
import { createSettingsRepo } from '@/data/db/settings';

let db: Db;
let settings: ReturnType<typeof createSettingsRepo>;

beforeEach(async () => {
  db = await createSqlJsDb();
  await migrate(db);
  settings = createSettingsRepo(db);
});

test('get returns null for a key that was never set', async () => {
  await expect(settings.get('units')).resolves.toBeNull();
});

test('round-trips the JSON shapes the app stores', async () => {
  await settings.set('units', 'mph');
  await settings.set('textScale', 1.25);
  await settings.set('hudEnabled', true);
  await settings.set('quietHours', { from: 23, to: 5 });
  await settings.set('dismissed', ['calibration', 'camera']);

  await expect(settings.get<string>('units')).resolves.toBe('mph');
  await expect(settings.get<number>('textScale')).resolves.toBe(1.25);
  await expect(settings.get<boolean>('hudEnabled')).resolves.toBe(true);
  await expect(settings.get<{ from: number; to: number }>('quietHours')).resolves.toEqual({
    from: 23,
    to: 5,
  });
  await expect(settings.get<string[]>('dismissed')).resolves.toEqual(['calibration', 'camera']);
});

test('set overwrites the value already under the key', async () => {
  await settings.set('units', 'mph');
  await settings.set('units', 'kph');
  await expect(settings.get<string>('units')).resolves.toBe('kph');
});

test('getOr falls back without writing anything', async () => {
  await expect(settings.getOr('units', 'mph')).resolves.toBe('mph');
  await expect(settings.get('units')).resolves.toBeNull();

  await settings.set('units', 'kph');
  await expect(settings.getOr('units', 'mph')).resolves.toBe('kph');
});

test('remove reports whether there was anything to remove', async () => {
  await settings.set('units', 'mph');
  await expect(settings.remove('units')).resolves.toBe(true);
  await expect(settings.remove('units')).resolves.toBe(false);
  await expect(settings.get('units')).resolves.toBeNull();
});

test('all returns every key with its parsed value', async () => {
  await settings.set('units', 'mph');
  await settings.set('hudEnabled', false);

  await expect(settings.all()).resolves.toEqual({ hudEnabled: false, units: 'mph' });
});

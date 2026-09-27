import { createSettingsRepo } from '@/data/db/settings';
import { createTestDb } from '@/data/queries/__fixtures__/harness';

import {
  ALERT_STYLE_PREF_KEY,
  ALERT_STYLES,
  alertStylePref,
  loadAlertStylePref,
  resetAlertStylePrefForTests,
  setAlertStylePref,
  subscribeAlertStylePref,
} from '../stylePref';

afterEach(() => resetAlertStylePrefForTests());

test('sound and vibration until the driver chooses otherwise', async () => {
  const settings = createSettingsRepo(await createTestDb());
  expect(alertStylePref()).toBe('both');
  await expect(loadAlertStylePref(settings)).resolves.toBe('both');
  expect(alertStylePref()).toBe('both');
  expect(ALERT_STYLES).toEqual(['both', 'vibration', 'sound']);
});

test('a choice is kept on the phone and read back by the next launch', async () => {
  const db = await createTestDb();
  await setAlertStylePref(createSettingsRepo(db), 'vibration');
  expect(alertStylePref()).toBe('vibration');
  await expect(createSettingsRepo(db).get(ALERT_STYLE_PREF_KEY)).resolves.toBe('vibration');

  resetAlertStylePrefForTests();
  expect(alertStylePref()).toBe('both');
  await expect(loadAlertStylePref(createSettingsRepo(db))).resolves.toBe('vibration');
  expect(alertStylePref()).toBe('vibration');
});

test('a stored value that is not a style reads as both', async () => {
  const db = await createTestDb();
  await createSettingsRepo(db).set(ALERT_STYLE_PREF_KEY, 'loud');
  await expect(loadAlertStylePref(createSettingsRepo(db))).resolves.toBe('both');
});

test('a read that fails never rejects and leaves the cached value as it was', async () => {
  const settings = createSettingsRepo(await createTestDb());
  await setAlertStylePref(settings, 'sound');
  const broken = { get: jest.fn(async () => Promise.reject(new Error('disk'))) };
  await expect(loadAlertStylePref(broken as never)).resolves.toBe('sound');
  expect(alertStylePref()).toBe('sound');
});

test('a write that fails rejects and leaves the choice where it was', async () => {
  const broken = { set: jest.fn(async () => Promise.reject(new Error('disk'))) };
  await expect(setAlertStylePref(broken as never, 'vibration')).rejects.toThrow('disk');
  expect(alertStylePref()).toBe('both');
});

test('subscribers hear every change', async () => {
  const settings = createSettingsRepo(await createTestDb());
  const heard: string[] = [];
  const off = subscribeAlertStylePref((s) => heard.push(s));
  await setAlertStylePref(settings, 'vibration');
  await setAlertStylePref(settings, 'sound');
  off();
  await setAlertStylePref(settings, 'both');
  expect(heard).toEqual(['vibration', 'sound']);
});

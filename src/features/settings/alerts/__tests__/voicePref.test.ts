import { createSettingsRepo } from '@/data/db/settings';
import { createTestDb } from '@/data/queries/__fixtures__/harness';

import {
  loadVoicePref,
  resetVoicePrefForTests,
  setVoicePref,
  subscribeVoicePref,
  VOICE_PREF_KEY,
  voicePrefEnabled,
} from '../voicePref';

afterEach(() => resetVoicePrefForTests());

test('voice is on until the driver turns it off', async () => {
  const settings = createSettingsRepo(await createTestDb());
  expect(voicePrefEnabled()).toBe(true);
  await expect(loadVoicePref(settings)).resolves.toBe(true);
  expect(voicePrefEnabled()).toBe(true);
});

test('turning voice off is kept on the phone and read back by the next launch', async () => {
  const db = await createTestDb();
  await setVoicePref(createSettingsRepo(db), false);
  expect(voicePrefEnabled()).toBe(false);
  await expect(createSettingsRepo(db).get(VOICE_PREF_KEY)).resolves.toBe(false);

  resetVoicePrefForTests();
  expect(voicePrefEnabled()).toBe(true);
  await expect(loadVoicePref(createSettingsRepo(db))).resolves.toBe(false);
  expect(voicePrefEnabled()).toBe(false);
});

test('a stored value that is not a boolean reads as on', async () => {
  const db = await createTestDb();
  await createSettingsRepo(db).set(VOICE_PREF_KEY, 'no');
  await expect(loadVoicePref(createSettingsRepo(db))).resolves.toBe(true);
});

test('a read that fails never rejects and leaves the cached value as it was', async () => {
  const settings = createSettingsRepo(await createTestDb());
  await setVoicePref(settings, false);
  const broken = { get: jest.fn(async () => Promise.reject(new Error('disk'))) };
  await expect(loadVoicePref(broken as never)).resolves.toBe(false);
  expect(voicePrefEnabled()).toBe(false);
});

test('a write that fails rejects and leaves the switch where it was', async () => {
  const broken = { set: jest.fn(async () => Promise.reject(new Error('disk'))) };
  await expect(setVoicePref(broken as never, false)).rejects.toThrow('disk');
  expect(voicePrefEnabled()).toBe(true);
});

test('subscribers hear every change', async () => {
  const settings = createSettingsRepo(await createTestDb());
  const heard: boolean[] = [];
  const off = subscribeVoicePref((on) => heard.push(on));
  await setVoicePref(settings, false);
  await setVoicePref(settings, true);
  off();
  await setVoicePref(settings, false);
  expect(heard).toEqual([false, true]);
});

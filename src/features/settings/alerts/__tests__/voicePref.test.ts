import { createSettingsRepo } from '@/data/db/settings';
import { memoryDb as createTestDb } from '@/features/permissions/__fixtures__/harness';

import {
  loadVoicePref,
  resetVoicePrefForTests,
  setVoicePref,
  subscribeVoicePref,
  VOICE_PREF_KEY,
  voicePrefEnabled,
} from '../voicePref';

afterEach(() => resetVoicePrefForTests());

test('voice is off until the driver turns it on', async () => {
  const settings = createSettingsRepo(await createTestDb());
  expect(voicePrefEnabled()).toBe(false);
  await expect(loadVoicePref(settings)).resolves.toBe(false);
  expect(voicePrefEnabled()).toBe(false);
});

test('turning voice on is kept on the phone and read back by the next launch', async () => {
  const db = await createTestDb();
  await setVoicePref(createSettingsRepo(db), true);
  expect(voicePrefEnabled()).toBe(true);
  await expect(createSettingsRepo(db).get(VOICE_PREF_KEY)).resolves.toBe(true);

  resetVoicePrefForTests();
  expect(voicePrefEnabled()).toBe(false);
  await expect(loadVoicePref(createSettingsRepo(db))).resolves.toBe(true);
  expect(voicePrefEnabled()).toBe(true);
});

test('a stored value that is not a boolean reads as off', async () => {
  const db = await createTestDb();
  await createSettingsRepo(db).set(VOICE_PREF_KEY, 'yes');
  await expect(loadVoicePref(createSettingsRepo(db))).resolves.toBe(false);
});

test('a read that fails never rejects and leaves the cached value as it was', async () => {
  const settings = createSettingsRepo(await createTestDb());
  await setVoicePref(settings, true);
  const broken = { get: jest.fn(async () => Promise.reject(new Error('disk'))) };
  await expect(loadVoicePref(broken as never)).resolves.toBe(true);
  expect(voicePrefEnabled()).toBe(true);
});

test('a write that fails rejects and leaves the switch where it was', async () => {
  const broken = { set: jest.fn(async () => Promise.reject(new Error('disk'))) };
  await expect(setVoicePref(broken as never, true)).rejects.toThrow('disk');
  expect(voicePrefEnabled()).toBe(false);
});

test('subscribers hear every change', async () => {
  const settings = createSettingsRepo(await createTestDb());
  const heard: boolean[] = [];
  const off = subscribeVoicePref((on) => heard.push(on));
  await setVoicePref(settings, true);
  await setVoicePref(settings, false);
  off();
  await setVoicePref(settings, true);
  expect(heard).toEqual([true, false]);
});

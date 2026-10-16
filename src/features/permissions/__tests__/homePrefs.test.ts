/** Home's stored permission prefs: hidden rows and "the next tap opens Settings", device-local. */
import { HOME_HIDDEN_KEY, HOME_TO_SETTINGS_KEY } from '@/core/permissions';

import { hideOnHome, markToSettings, pruneToSettings, readHomePrefs, serial, showOnHome } from '../homePrefs';

jest.mock('@/data/supabase/client', () => ({ supabase: {} }));

function store(initial: Record<string, unknown> = {}) {
  const data = new Map<string, unknown>(Object.entries(initial));
  return {
    data,
    failGet: false,
    failSet: false,
    async get<T>(key: string): Promise<T | null> {
      if (this.failGet) throw new Error('read failed');
      await Promise.resolve();
      return (data.has(key) ? data.get(key) : null) as T | null;
    },
    async set(key: string, value: unknown): Promise<void> {
      await Promise.resolve();
      if (this.failSet) throw new Error('write failed');
      data.set(key, JSON.parse(JSON.stringify(value)));
    },
  };
}

test('nothing stored: nothing hidden, no Settings taps', async () => {
  expect(await readHomePrefs(store())).toEqual({ hidden: [], toSettings: {} });
});

test('malformed values and unknown ids read as absent; ids are de-duplicated and in Home order', async () => {
  const s = store({
    [HOME_HIDDEN_KEY]: ['bluetooth', 'nope', 'motion', 'motion', 3, null, 'location'],
    [HOME_TO_SETTINGS_KEY]: { motion: 'denied:true', wifi: 'x', notifications: 4, precise: 'denied:true' },
  });
  expect(await readHomePrefs(s)).toEqual({ hidden: ['location', 'motion', 'bluetooth'], toSettings: { motion: 'denied:true', precise: 'denied:true' } });
  expect(await readHomePrefs(store({ [HOME_HIDDEN_KEY]: 'motion', [HOME_TO_SETTINGS_KEY]: ['motion'] }))).toEqual({ hidden: [], toSettings: {} });
});

test('a failed read shows every row: nothing is hidden by a failure', async () => {
  const s = store({ [HOME_HIDDEN_KEY]: ['motion'] });
  s.failGet = true;
  expect(await readHomePrefs(s)).toEqual({ hidden: [], toSettings: {} });
});

test('hide and show round trip; repeating either changes nothing', async () => {
  const s = store();
  expect(await hideOnHome(s, 'motion')).toEqual(['motion']);
  expect(await hideOnHome(s, 'location')).toEqual(['location', 'motion']);
  expect(await hideOnHome(s, 'motion')).toEqual(['location', 'motion']);
  expect(s.data.get(HOME_HIDDEN_KEY)).toEqual(['location', 'motion']);
  expect(await showOnHome(s, 'motion')).toEqual(['location']);
  expect(await showOnHome(s, 'motion')).toEqual(['location']);
  expect((await readHomePrefs(s)).hidden).toEqual(['location']);
});

test('a write whose read fails stores nothing (it never overwrites what is hidden with an empty list)', async () => {
  const s = store({ [HOME_HIDDEN_KEY]: ['motion'] });
  s.failGet = true;
  await expect(hideOnHome(s, 'location')).rejects.toThrow('read failed');
  s.failGet = false;
  expect(s.data.get(HOME_HIDDEN_KEY)).toEqual(['motion']);
});

test('a failed hide write rejects, and the queue keeps working', async () => {
  const s = store();
  s.failSet = true;
  await expect(hideOnHome(s, 'motion')).rejects.toThrow('write failed');
  s.failSet = false;
  expect(await hideOnHome(s, 'motion')).toEqual(['motion']);
});

test('a hide interleaved with a Settings-tap write keeps the hide (separate keys, one queue)', async () => {
  const s = store({ [HOME_TO_SETTINGS_KEY]: { motion: 'denied:true' } });
  const [hidden, marked, pruned] = await Promise.all([
    hideOnHome(s, 'notifications'),
    markToSettings(s, 'notifications', 'denied:true'),
    pruneToSettings(s, (id) => id !== 'motion'),
  ]);
  expect(hidden).toEqual(['notifications']);
  expect(marked).toEqual({ motion: 'denied:true', notifications: 'denied:true' });
  expect(pruned).toEqual({ notifications: 'denied:true' });
  expect(await readHomePrefs(s)).toEqual({ hidden: ['notifications'], toSettings: { notifications: 'denied:true' } });
});

test('prune writes only when an entry no longer applies', async () => {
  const s = store({ [HOME_TO_SETTINGS_KEY]: { motion: 'denied:true' } });
  const set = jest.spyOn(s, 'set');
  await pruneToSettings(s, () => true);
  expect(set).not.toHaveBeenCalled();
  await pruneToSettings(s, (_id, sig) => sig !== 'denied:true');
  expect(s.data.get(HOME_TO_SETTINGS_KEY)).toEqual({});
});

test('serial runs in order and survives a failure', async () => {
  const order: number[] = [];
  const a = serial(async () => {
    await Promise.resolve();
    order.push(1);
    throw new Error('x');
  });
  const b = serial(async () => {
    order.push(2);
    return 'b';
  });
  await expect(a).rejects.toThrow('x');
  expect(await b).toBe('b');
  expect(order).toEqual([1, 2]);
});

test("both keys are this account's on this phone: the handover wipe removes them, a plain sign-out keeps them", () => {
  // eslint-disable-next-line @typescript-eslint/no-require-imports -- loaded here only, behind the supabase mock
  const device = require('@/boot/device') as typeof import('@/boot/device');
  for (const key of [HOME_HIDDEN_KEY, HOME_TO_SETTINGS_KEY]) {
    expect(device.WIPE_KEEPS_SETTINGS).not.toContain(key);
    expect(key.startsWith(device.WIPE_KEEPS_SETTINGS_PREFIX)).toBe(false);
    expect(device.SIGN_OUT_SETTINGS).not.toContain(key);
  }
});

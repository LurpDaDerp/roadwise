import { act, renderHook } from '@testing-library/react-native';
import { Appearance } from 'react-native';

import {
  APPEARANCE_KEY,
  appearance,
  createAppearanceStore,
  followPhoneScheme,
  parseAppearance,
  useAppearance,
  type AppearanceStorage,
} from '@/ui/appearance';

function memoryStorage(seed: Record<string, string> = {}) {
  const data: Record<string, string> = { ...seed };
  return {
    data,
    getItem: jest.fn(async (k: string) => data[k] ?? null),
    setItem: jest.fn(async (k: string, v: string) => {
      data[k] = v;
    }),
  };
}

afterEach(() => {
  jest.useRealTimers();
  jest.restoreAllMocks();
});

test('a stored choice reads back; anything else is Adaptive', () => {
  for (const v of ['adaptive', 'light', 'dark', 'system'] as const) expect(parseAppearance(v)).toBe(v);
  for (const v of [null, undefined, '', 'Dark', 'auto', 3, {}]) expect(parseAppearance(v)).toBe('adaptive');
});

test('Adaptive until the stored choice is read, then the stored choice, read once', async () => {
  const storage = memoryStorage({ [APPEARANCE_KEY]: 'dark' });
  const store = createAppearanceStore(storage, { follow: jest.fn() });
  expect(store.get()).toEqual({ choice: 'adaptive', loaded: false });
  const first = store.load();
  expect(store.load()).toBe(first);
  await first;
  expect(store.get()).toEqual({ choice: 'dark', loaded: true });
  expect(storage.getItem).toHaveBeenCalledTimes(1);
  expect(storage.getItem).toHaveBeenCalledWith('roadwise.appearance.v1');
});

test('nothing stored, an unknown value, or a storage that fails all load as Adaptive', async () => {
  for (const storage of [
    memoryStorage(),
    memoryStorage({ [APPEARANCE_KEY]: 'sepia' }),
    { getItem: async () => Promise.reject(new Error('no disk')), setItem: async () => {} },
    {
      getItem: () => {
        throw new Error('no module');
      },
      setItem: async () => {},
    } as unknown as AppearanceStorage,
  ]) {
    const store = createAppearanceStore(storage, { follow: jest.fn() });
    await store.load();
    expect(store.get()).toEqual({ choice: 'adaptive', loaded: true });
  }
});

test('with no storage at all it is loaded as Adaptive from the start, so nothing waits on it', async () => {
  const store = createAppearanceStore(null, { follow: jest.fn() });
  expect(store.get()).toEqual({ choice: 'adaptive', loaded: true });
  await store.load();
  store.set('light');
  expect(store.get()).toEqual({ choice: 'light', loaded: true });
});

test('a read that hangs gives way to Adaptive after a second; the stored choice still lands when it comes', async () => {
  jest.useFakeTimers();
  let answer: (v: string | null) => void = () => {};
  const storage = { getItem: () => new Promise<string | null>((r) => (answer = r)), setItem: jest.fn(async () => {}) };
  const store = createAppearanceStore(storage, { follow: jest.fn() });
  const done = store.load();
  jest.advanceTimersByTime(999);
  expect(store.get().loaded).toBe(false);
  jest.advanceTimersByTime(1);
  await done;
  expect(store.get()).toEqual({ choice: 'adaptive', loaded: true });
  answer('light');
  await Promise.resolve();
  await Promise.resolve();
  expect(store.get()).toEqual({ choice: 'light', loaded: true });
});

test('a choice lands at once, tells every listener, and is saved on the phone', async () => {
  const storage = memoryStorage();
  const store = createAppearanceStore(storage, { follow: jest.fn() });
  await store.load();
  const heard = jest.fn();
  const off = store.subscribe(heard);
  store.set('light');
  expect(store.get().choice).toBe('light');
  expect(heard).toHaveBeenCalledTimes(1);
  expect(storage.setItem).toHaveBeenCalledWith(APPEARANCE_KEY, 'light');
  store.set('light');
  expect(heard).toHaveBeenCalledTimes(1);
  off();
  store.set('dark');
  expect(heard).toHaveBeenCalledTimes(1);
  expect(storage.data[APPEARANCE_KEY]).toBe('dark');
});

test('a choice made while the stored one is still being read wins over it', async () => {
  let answer: (v: string | null) => void = () => {};
  const storage = { getItem: () => new Promise<string | null>((r) => (answer = r)), setItem: jest.fn(async () => {}) };
  const store = createAppearanceStore(storage, { follow: jest.fn() });
  const done = store.load();
  store.set('system');
  answer('dark');
  await done;
  expect(store.get()).toEqual({ choice: 'system', loaded: true });
});

test("a save that fails keeps the choice for this session", async () => {
  const storage = { getItem: async () => null, setItem: jest.fn(async () => Promise.reject(new Error('full'))) };
  const store = createAppearanceStore(storage, { follow: jest.fn() });
  await store.load();
  store.set('dark');
  await Promise.resolve();
  expect(store.get().choice).toBe('dark');
});

test("System hands the phone's Light / Dark setting back before anyone hears of the change", async () => {
  const order: string[] = [];
  const follow = jest.fn(() => order.push('follow'));
  const store = createAppearanceStore(memoryStorage(), { follow });
  await store.load();
  store.subscribe(() => order.push('heard'));
  store.set('dark');
  expect(follow).not.toHaveBeenCalled();
  store.set('system');
  expect(order).toEqual(['heard', 'follow', 'heard']);
});

test("a stored System hands the phone's Light / Dark setting back before anyone hears of it, on time or after the give-way to Adaptive", async () => {
  // On time: read behind the splash.
  {
    const order: string[] = [];
    const follow = jest.fn(() => order.push('follow'));
    const store = createAppearanceStore(memoryStorage({ [APPEARANCE_KEY]: 'system' }), { follow });
    store.subscribe(() => order.push(`heard ${store.get().choice}`));
    await store.load();
    expect(store.get()).toEqual({ choice: 'system', loaded: true });
    expect(order).toEqual(['follow', 'heard system']);
  }
  // Late: Adaptive has been on screen (its sky's scheme forced) when the stored System lands.
  {
    jest.useFakeTimers();
    let answer: (v: string | null) => void = () => {};
    const order: string[] = [];
    const follow = jest.fn(() => order.push('follow'));
    const store = createAppearanceStore(
      { getItem: () => new Promise<string | null>((r) => (answer = r)), setItem: jest.fn(async () => {}) },
      { follow }
    );
    store.subscribe(() => order.push(`heard ${store.get().choice}`));
    const done = store.load();
    jest.advanceTimersByTime(1000);
    await done;
    expect(order).toEqual(['heard adaptive']);
    answer('system');
    await Promise.resolve();
    await Promise.resolve();
    expect(store.get()).toEqual({ choice: 'system', loaded: true });
    expect(order).toEqual(['heard adaptive', 'follow', 'heard system']);
  }
});

test('a stored Adaptive, Light or Dark leaves the override to the theme', async () => {
  for (const v of ['light', 'dark', 'adaptive']) {
    const follow = jest.fn();
    const store = createAppearanceStore(memoryStorage({ [APPEARANCE_KEY]: v }), { follow });
    await store.load();
    expect(store.get().choice).toBe(v);
    expect(follow).not.toHaveBeenCalled();
  }
});

test("following the phone clears the app's override", () => {
  const spy = jest.spyOn(Appearance, 'setColorScheme').mockImplementation(() => {});
  followPhoneScheme();
  expect(spy).toHaveBeenCalledWith('unspecified');
});

test('useAppearance re-renders on a change', async () => {
  const store = createAppearanceStore(null, { follow: jest.fn() });
  const { result } = await renderHook(() => useAppearance(store));
  expect(result.current).toEqual({ choice: 'adaptive', loaded: true });
  await act(async () => {
    store.set('dark');
  });
  expect(result.current.choice).toBe('dark');
});

test("the app's store needs no native module under Jest: it is Adaptive and loaded at once", async () => {
  expect(appearance.get()).toEqual({ choice: 'adaptive', loaded: true });
  await appearance.load();
  expect(appearance.get()).toEqual({ choice: 'adaptive', loaded: true });
});

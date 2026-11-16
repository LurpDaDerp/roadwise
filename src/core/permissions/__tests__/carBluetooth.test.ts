/** Bluetooth for the car check: asked once at pairing (iPhone after it, Android 12+ before it), read without ever prompting. */
import type { BluetoothPort, RadioState } from '../adapters';
import { ANDROID_BT_CONNECT, askBluetoothForCar, askNearbyForCar, BLUETOOTH_ANSWERED_KEY, CAR_RADIO_SETTLE_MS, carNearbyGranted, carRadioState } from '../carBluetooth';

function world(opts: { radio?: RadioState | null; answer?: RadioState; answered?: boolean; throws?: boolean } = {}) {
  const store = new Map<string, unknown>(opts.answered ? [[BLUETOOTH_ANSWERED_KEY, true]] : []);
  let manager: RadioState | null = opts.radio ?? null;
  const starts: (number | undefined)[] = [];
  const radio: BluetoothPort = {
    radio: async () => {
      if (opts.throws) throw new Error('no module');
      return manager;
    },
    startRadio: async (settleMs) => {
      starts.push(settleMs);
      manager = opts.answer ?? 'on';
      return manager;
    },
  };
  const settings = {
    get: async <T,>(k: string) => (store.has(k) ? (store.get(k) as T) : null),
    set: async (k: string, v: unknown) => void store.set(k, v),
  };
  return { radio, settings, store, starts };
}

describe('askBluetoothForCar', () => {
  test('iPhone, never answered: the prompt (creating the manager), and the answer remembered', async () => {
    const w = world({ answer: 'on' });
    expect(await askBluetoothForCar({ platform: 'ios', settings: w.settings, radio: w.radio })).toBe('on');
    expect(w.starts).toEqual([undefined]);
    expect(w.store.get(BLUETOOTH_ANSWERED_KEY)).toBe(true);
  });

  test('a denial is an answer too (never asked again); the car stays paired whatever it is', async () => {
    const w = world({ answer: 'unauthorized' });
    expect(await askBluetoothForCar({ platform: 'ios', settings: w.settings, radio: w.radio })).toBe('unauthorized');
    expect(w.store.get(BLUETOOTH_ANSWERED_KEY)).toBe(true);
  });

  test('answered before (or DashPal holds the manager): nothing is shown', async () => {
    const before = world({ answered: true });
    expect(await askBluetoothForCar({ platform: 'ios', settings: before.settings, radio: before.radio })).toBeNull();
    expect(before.starts).toEqual([]);
    const dashpal = world({ radio: 'off' });
    expect(await askBluetoothForCar({ platform: 'ios', settings: dashpal.settings, radio: dashpal.radio })).toBe('off');
    expect(dashpal.starts).toEqual([]);
    expect(dashpal.store.get(BLUETOOTH_ANSWERED_KEY)).toBe(true);
  });

  test('no answer yet (still unknown): not remembered, so the next pairing asks again', async () => {
    const w = world({ answer: 'unknown' });
    expect(await askBluetoothForCar({ platform: 'ios', settings: w.settings, radio: w.radio })).toBeNull();
    expect(w.store.has(BLUETOOTH_ANSWERED_KEY)).toBe(false);
  });

  test('never on Android; a failure never throws', async () => {
    const w = world();
    expect(await askBluetoothForCar({ platform: 'android', settings: w.settings, radio: w.radio })).toBeNull();
    expect(w.starts).toEqual([]);
    const broken = world({ throws: true });
    await expect(askBluetoothForCar({ platform: 'ios', settings: broken.settings, radio: broken.radio })).resolves.toBeNull();
  });
});

describe('carRadioState', () => {
  test('the manager that exists answers; unknown or resetting is null', async () => {
    for (const [radio, out] of [
      ['on', 'on'],
      ['off', 'off'],
      ['unauthorized', 'unauthorized'],
      ['unknown', null],
      ['resetting', null],
    ] as const) {
      const w = world({ radio });
      expect(await carRadioState({ platform: 'ios', settings: w.settings, radio: w.radio })).toBe(out);
      expect(w.starts).toEqual([]);
    }
  });

  test('no manager and never answered: null, and nothing created (no prompt from a drive)', async () => {
    const w = world();
    expect(await carRadioState({ platform: 'ios', settings: w.settings, radio: w.radio })).toBeNull();
    expect(w.starts).toEqual([]);
  });

  test('no manager but answered: created with a short wait, its state read', async () => {
    const w = world({ answered: true, answer: 'off' });
    expect(await carRadioState({ platform: 'ios', settings: w.settings, radio: w.radio })).toBe('off');
    expect(w.starts).toEqual([CAR_RADIO_SETTLE_MS]);
  });

  test('Android and failures: null', async () => {
    const w = world({ radio: 'on' });
    expect(await carRadioState({ platform: 'android', settings: w.settings, radio: w.radio })).toBeNull();
    const broken = world({ throws: true, answered: true });
    expect(await carRadioState({ platform: 'ios', settings: broken.settings, radio: broken.radio })).toBeNull();
  });
});

describe('Android: Nearby devices before "Use this car", the radio read with no prompt', () => {
  function perms(granted: boolean, answer: 'granted' | 'denied' | 'never_ask_again' = 'granted') {
    const asked: string[][] = [];
    let now = granted;
    return {
      asked,
      port: {
        check: async (p: string) => p === ANDROID_BT_CONNECT && now,
        requestMultiple: async (ps: string[]) => {
          asked.push(ps);
          now = answer === 'granted';
          return Object.fromEntries(ps.map((p) => [p, answer]));
        },
      },
    };
  }

  test('Android 12+: asked once (Nearby devices: BLUETOOTH_CONNECT alone), the answer remembered; allowed already: nothing shown', async () => {
    const w = world();
    const p = perms(false);
    expect(await askNearbyForCar({ settings: w.settings, android: { permissions: p.port, apiLevel: 35 } })).toBe(true);
    expect(p.asked).toEqual([[ANDROID_BT_CONNECT]]);
    expect(w.store.get(BLUETOOTH_ANSWERED_KEY)).toBe(true);
    const allowed = perms(true);
    expect(await askNearbyForCar({ settings: world().settings, android: { permissions: allowed.port, apiLevel: 35 } })).toBe(true);
    expect(allowed.asked).toEqual([]);
  });

  test('a denial is an answer: never asked again, and false (the pairing goes on all the same)', async () => {
    const w = world();
    const p = perms(false, 'denied');
    expect(await askNearbyForCar({ settings: w.settings, android: { permissions: p.port, apiLevel: 34 } })).toBe(false);
    expect(await askNearbyForCar({ settings: w.settings, android: { permissions: p.port, apiLevel: 34 } })).toBe(false);
    expect(p.asked).toHaveLength(1);
  });

  test('Android 11 and lower: nothing to allow, nothing shown', async () => {
    const p = perms(false);
    expect(await carNearbyGranted({ permissions: p.port, apiLevel: 30 })).toBe(true);
    expect(await askNearbyForCar({ settings: world().settings, android: { permissions: p.port, apiLevel: 30 } })).toBe(true);
    expect(p.asked).toEqual([]);
  });

  test('the radio: read with Nearby devices allowed (or below 12), started with the short wait when not yet read; never without it', async () => {
    const on = world({ answer: 'off' });
    expect(await carRadioState({ platform: 'android', settings: on.settings, radio: on.radio, android: { permissions: perms(true).port, apiLevel: 35 } })).toBe('off');
    expect(on.starts).toEqual([CAR_RADIO_SETTLE_MS]);
    const read = world({ radio: 'on' });
    expect(await carRadioState({ platform: 'android', settings: read.settings, radio: read.radio, android: { permissions: perms(false).port, apiLevel: 29 } })).toBe('on');
    expect(read.starts).toEqual([]);
    const denied = world({ radio: 'on' });
    expect(await carRadioState({ platform: 'android', settings: denied.settings, radio: denied.radio, android: { permissions: perms(false).port, apiLevel: 35 } })).toBeNull();
    const broken = world({ throws: true });
    expect(await carRadioState({ platform: 'android', settings: broken.settings, radio: broken.radio, android: { permissions: perms(true).port, apiLevel: 35 } })).toBeNull();
  });
});

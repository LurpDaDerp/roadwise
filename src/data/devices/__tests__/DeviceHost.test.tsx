/**
 * DeviceHost's push-token listener: every token read fires the OS token event again (expo-notifications
 * answers each `getExpoPushTokenAsync` with `onDevicePushToken`), so the host must drop the echo of
 * its own read or it registers forever. A genuinely new token still registers at once.
 */
import { act, render } from '@testing-library/react-native';

import { LAST_USER_KEY } from '@/boot/device';
import { createSqlJsDb } from '@/data/db/__fixtures__/sqljsDriver';
import type { Db } from '@/data/db/driver';
import { migrate } from '@/data/db/migrate';
import { createSettingsRepo } from '@/data/db/settings';
import { DeviceHost, type DeviceHostDeps } from '@/data/devices/DeviceHost';
import { requestDeviceSync } from '@/data/devices/events';
import type { LiveActivityTokenPort, PushPort } from '@/data/devices/pushToken';
import { DataProvider } from '@/data/queries/context';

jest.mock('@/data/supabase/client', () => ({ supabase: {} }));
jest.mock('@/data/supabase/session', () => ({ useSession: () => ({ status: 'signedIn', session: { user: { id: 'u1' } } }) }));

const T0 = 1_700_000_000_000;
const now = () => T0;
const EXPO_TOKEN = 'ExponentPushToken[abcdefgh12345678]';

type Emit = 'during' | 'after';

/** A real-device push port whose every token read fires the token event, as expo-notifications does. */
function echoingPush(opts: { emit: Emit; deviceToken: () => string }) {
  const listeners = new Set<(token: string) => void>();
  let reads = 0;
  const fire = (token: string) => {
    for (const l of [...listeners]) l(token);
  };
  const port: PushPort = {
    isDevice: () => true,
    permitted: async () => true,
    async getExpoPushToken() {
      reads += 1;
      const token = opts.deviceToken();
      // 'during': the event lands before the read resolves (the pass is still running);
      // 'after': it lands once the pass has had time to finish.
      if (opts.emit === 'during') fire(token);
      else setTimeout(() => fire(token), 20);
      // A real read goes to the network (exp.host): yield to the timers, so a loop shows up as a
      // count that never settles instead of starving the test's own clock.
      await new Promise((resolve) => setTimeout(resolve, 1));
      return EXPO_TOKEN;
    },
    addPushTokenListener(listener) {
      listeners.add(listener);
      return { remove: () => void listeners.delete(listener) };
    },
  };
  return { port, fire, reads: () => reads };
}

const noLiveActivity: LiveActivityTokenPort = { getToken: async () => null, addTokenListener: () => ({ remove() {} }) };
const appState = { currentState: 'active', addEventListener: () => ({ remove() {} }) };

async function world(push: PushPort, rpc: DeviceHostDeps['rpc']) {
  const db: Db = await createSqlJsDb();
  await migrate(db);
  await createSettingsRepo(db).set(LAST_USER_KEY, 'u1');
  const deps: Partial<DeviceHostDeps> = { rpc, push, liveActivity: noLiveActivity, appState, platform: 'ios', projectId: 'proj', newId: () => 'install-1234' };
  const onError = jest.fn();
  const view = await render(
    <DataProvider db={db} now={now}>
      <DeviceHost deps={deps} onError={onError} />
    </DataProvider>
  );
  return { view, onError };
}

/** Waits until `count` stops growing; fails if it is still growing after `maxRounds` rounds (a loop). */
async function settle(count: () => number, maxRounds = 40): Promise<number> {
  let last = -1;
  let still = 0;
  for (let round = 0; round < maxRounds; round += 1) {
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 30));
    });
    const c = count();
    if (c === last) {
      still += 1;
      if (still >= 3) return c;
    } else {
      still = 0;
      last = c;
    }
  }
  throw new Error(`never settled: ${count()} and counting`);
}

const registerCalls = (rpc: jest.Mock) => rpc.mock.calls.filter(([fn]) => fn === 'register_device').length;

describe.each<Emit>(['during', 'after'])('the token echo of our own read (lands %s the pass)', (emit) => {
  it('a forced sync registers once more and then settles', async () => {
    const push = echoingPush({ emit, deviceToken: () => 'apns-1' });
    const rpc = jest.fn(async () => null);
    const { view } = await world(push.port, rpc);
    const afterLaunch = await settle(() => registerCalls(rpc));
    expect(afterLaunch).toBeGreaterThanOrEqual(1);
    expect(afterLaunch).toBeLessThanOrEqual(2);

    await act(async () => requestDeviceSync());
    const afterSync = await settle(() => registerCalls(rpc));
    expect(afterSync).toBe(afterLaunch + 1);
    expect(await settle(() => push.reads())).toBe(afterSync);
    await view.unmount();
  });

  it('settles even while register_device keeps failing (offline)', async () => {
    const push = echoingPush({ emit, deviceToken: () => 'apns-1' });
    const rpc = jest.fn(async () => Promise.reject(new Error('offline')));
    const { view, onError } = await world(push.port, rpc);
    const afterLaunch = await settle(() => rpc.mock.calls.length);
    expect(afterLaunch).toBeLessThanOrEqual(2);
    await act(async () => requestDeviceSync());
    expect(await settle(() => rpc.mock.calls.length)).toBe(afterLaunch + 1);
    expect(onError).toHaveBeenCalled();
    await view.unmount();
  });
});

it('a genuinely rotated token registers at once, and its own echo does not loop', async () => {
  let current = 'apns-1';
  const push = echoingPush({ emit: 'during', deviceToken: () => current });
  const rpc = jest.fn(async () => null);
  const { view } = await world(push.port, rpc);
  const afterLaunch = await settle(() => registerCalls(rpc));

  current = 'apns-2';
  await act(async () => push.fire('apns-2'));
  expect(await settle(() => registerCalls(rpc))).toBe(afterLaunch + 1);
  await view.unmount();
});

it('a port that reports a different token on every read still cannot hold the host in a loop', async () => {
  let n = 0;
  const push = echoingPush({ emit: 'during', deviceToken: () => `apns-${(n += 1)}` });
  const rpc = jest.fn(async () => null);
  const { view } = await world(push.port, rpc);
  await settle(() => registerCalls(rpc));
  await act(async () => requestDeviceSync());
  const total = await settle(() => registerCalls(rpc));
  expect(total).toBeLessThanOrEqual(8);
  await view.unmount();
});

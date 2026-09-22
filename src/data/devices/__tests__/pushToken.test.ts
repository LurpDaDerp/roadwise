import { createFakeSupabase, createMemorySettings } from '../__fixtures__/fakeSupabase';
import {
  PUSH_REFRESH_MS,
  PUSH_REGISTRATION_KEY,
  syncPushToken,
  unregisterPushToken,
  UNREGISTER_BUDGET_MS,
  type PushPort,
} from '../pushToken';

const T0 = Date.UTC(2026, 8, 22, 12, 0, 0);
const TOKEN = 'ExponentPushToken[abcdefgh12345678]';
const TOKEN2 = 'ExponentPushToken[zyxwvuts87654321]';

function port(over: Partial<PushPort> = {}): PushPort & { token: string } {
  const p: PushPort & { token: string } = {
    token: TOKEN,
    isDevice: () => true,
    permitted: jest.fn(async () => true),
    getExpoPushToken: jest.fn(async (): Promise<string> => p.token),
    addPushTokenListener: jest.fn(() => ({ remove: () => {} })),
    ...over,
  };
  return p;
}

function setup(over: Partial<PushPort> = {}) {
  const fake = createFakeSupabase();
  const settings = createMemorySettings();
  const push = port(over);
  let now = T0;
  const onError = jest.fn();
  const deps = (extra: { force?: boolean; userId?: string; deviceId?: string } = {}) => ({
    userId: 'user-a',
    deviceId: 'install-1',
    settings,
    supabase: fake.client,
    port: push,
    projectId: 'eb9c484d-45ef-4125-b146-3132b49af806',
    now: () => now,
    onError,
    ...extra,
  });
  return { fake, settings, push, deps, onError, advance: (ms: number) => (now += ms) };
}

describe('syncPushToken', () => {
  it('registers the token against this install id', async () => {
    const { fake, deps, push } = setup();
    expect(await syncPushToken(deps())).toBe('registered');
    expect(push.getExpoPushToken).toHaveBeenCalledWith('eb9c484d-45ef-4125-b146-3132b49af806');
    expect(fake.to('register_push_token')).toHaveLength(1);
    expect(fake.to('register_push_token')[0]?.values).toEqual({ p_device_id: 'install-1', p_token: TOKEN });
  });

  it('a simulator is not a device', async () => {
    const { fake, deps, push } = setup({ isDevice: () => false });
    expect(await syncPushToken(deps())).toBe('not-a-device');
    expect(push.getExpoPushToken).not.toHaveBeenCalled();
    expect(fake.calls).toHaveLength(0);
  });

  it('no permission: no token is fetched and nothing is sent', async () => {
    const { fake, deps, push } = setup({ permitted: async () => false });
    expect(await syncPushToken(deps())).toBe('no-permission');
    expect(push.getExpoPushToken).not.toHaveBeenCalled();
    expect(fake.calls).toHaveLength(0);
  });

  it('unchanged within 7 days: no token fetch and no request', async () => {
    const { fake, deps, push, advance } = setup();
    await syncPushToken(deps());
    advance(PUSH_REFRESH_MS - 1);
    expect(await syncPushToken(deps())).toBe('unchanged');
    expect(push.getExpoPushToken).toHaveBeenCalledTimes(1);
    expect(fake.to('register_push_token')).toHaveLength(1);
  });

  it('refreshed after 7 days', async () => {
    const { fake, deps, advance } = setup();
    await syncPushToken(deps());
    advance(PUSH_REFRESH_MS);
    expect(await syncPushToken(deps())).toBe('registered');
    expect(fake.to('register_push_token')).toHaveLength(2);
  });

  it('forced (every launch): registered again even when fresh', async () => {
    const { fake, deps } = setup();
    await syncPushToken(deps());
    expect(await syncPushToken(deps({ force: true }))).toBe('registered');
    expect(fake.to('register_push_token')).toHaveLength(2);
  });

  it('a changed token (the token listener forces a check) is registered', async () => {
    const { fake, deps, push } = setup();
    await syncPushToken(deps());
    push.token = TOKEN2;
    expect(await syncPushToken(deps({ force: true }))).toBe('registered');
    expect(fake.to('register_push_token')[1]?.values).toEqual({ p_device_id: 'install-1', p_token: TOKEN2 });
  });

  it('another account on this install is registered, not unchanged', async () => {
    const { fake, deps } = setup();
    await syncPushToken(deps());
    expect(await syncPushToken(deps({ userId: 'user-b' }))).toBe('registered');
    expect(fake.to('register_push_token')).toHaveLength(2);
  });

  it('a server error is an error and records nothing, so the next try registers', async () => {
    const { fake, deps, settings, onError } = setup();
    fake.respond = () => ({ data: null, error: { code: '22023', message: 'unknown device' } });
    expect(await syncPushToken(deps())).toBe('error');
    expect(await settings.get(PUSH_REGISTRATION_KEY)).toBeNull();
    expect(onError).toHaveBeenCalledTimes(1);
    fake.respond = () => ({ data: null, error: null });
    expect(await syncPushToken(deps())).toBe('registered');
  });

  it('a token fetch failure is an error, and the token never appears in a report', async () => {
    const { deps, onError } = setup({
      getExpoPushToken: async () => {
        throw new Error(`fetch failed for ${TOKEN}`);
      },
    });
    expect(await syncPushToken(deps())).toBe('error');
    expect(JSON.stringify(onError.mock.calls.map((c) => String(c[0])))).not.toContain('abcdefgh');
  });

  it('a malformed token is never sent', async () => {
    const { fake, deps, push } = setup();
    push.token = 'not-a-token';
    expect(await syncPushToken(deps())).toBe('error');
    expect(fake.calls).toHaveLength(0);
  });

  it('the result never carries the token', async () => {
    const { deps } = setup();
    const result = await syncPushToken(deps());
    expect(JSON.stringify(result)).not.toContain('Push');
  });
});

describe('unregisterPushToken', () => {
  afterEach(() => jest.useRealTimers());

  it('releases the registered token under the same account and forgets it', async () => {
    const { fake, deps, settings } = setup();
    await syncPushToken(deps());
    await unregisterPushToken({ settings, supabase: fake.client });
    expect(fake.to('unregister_push_token')[0]?.values).toEqual({ p_token: TOKEN });
    expect(await settings.get(PUSH_REGISTRATION_KEY)).toBeNull();
  });

  it('nothing registered: no request', async () => {
    const { fake, settings } = setup();
    await unregisterPushToken({ settings, supabase: fake.client });
    expect(fake.calls).toHaveLength(0);
  });

  it('never sends under another account’s session', async () => {
    const { fake, deps, settings } = setup();
    await syncPushToken(deps());
    fake.sessionUid = 'user-b';
    await unregisterPushToken({ settings, supabase: fake.client });
    expect(fake.to('unregister_push_token')).toHaveLength(0);
  });

  it('errors are swallowed', async () => {
    const { fake, deps, settings } = setup();
    await syncPushToken(deps());
    fake.respond = () => {
      throw new Error('offline');
    };
    await expect(unregisterPushToken({ settings, supabase: fake.client })).resolves.toBeUndefined();
  });

  it('gives up at the 2-second budget and aborts the request', async () => {
    const { fake, deps, settings } = setup();
    await syncPushToken(deps());
    jest.useFakeTimers();
    fake.respond = () => new Promise(() => {});
    let done = false;
    const run = unregisterPushToken({ settings, supabase: fake.client }).then(() => (done = true));
    await jest.advanceTimersByTimeAsync(UNREGISTER_BUDGET_MS - 1);
    expect(done).toBe(false);
    await jest.advanceTimersByTimeAsync(1);
    await run;
    expect(done).toBe(true);
    expect(UNREGISTER_BUDGET_MS).toBe(2_000);
    expect(fake.to('unregister_push_token')[0]?.signal?.aborted).toBe(true);
  });
});

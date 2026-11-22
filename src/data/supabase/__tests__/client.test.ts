// The auth refresh ticker follows AppState from the first moment it exists (battery, design §3.5):
// auth-js starts it by itself once the client has initialised, so a launch that begins in the
// background must stop it then, not at a foreground transition that may never come.
import { AppState } from 'react-native';

type Listener = (state: string) => void;

interface Deferred {
  resolve(): void;
  promise: Promise<{ data: { session: null } }>;
}

// `jest.mock` is hoisted above these imports; the objects are only read from inside the mocked
// functions, so they exist by the time any of them runs.
const mockAuth = {
  startAutoRefresh: jest.fn(async () => {}),
  stopAutoRefresh: jest.fn(async () => {}),
  getSession: jest.fn(),
  // auth-js's own key for the stored session (supabase-js derives it from the project URL).
  storageKey: 'sb-example-auth-token',
};
jest.mock('@supabase/supabase-js', () => ({ createClient: jest.fn(() => ({ auth: mockAuth })) }));
jest.mock('@/lib/env', () => ({ env: { supabaseUrl: 'https://example.supabase.co', supabasePublishableKey: 'sb_publishable_test' } }));
// The client's storage: what each key holds, as LargeSecureStore would decrypt it.
const mockStorage = new Map<string, string>();
jest.mock('@/data/supabase/largeSecureStore', () => ({
  LargeSecureStore: class {
    async getItem(key: string): Promise<string | null> {
      return mockStorage.get(key) ?? null;
    }
  },
}));
jest.mock('react-native-get-random-values', () => ({}));

const appState = AppState as unknown as { currentState: string; addEventListener: jest.Mock };

/** The client's initialisation, held until the test releases it. */
function deferInitialisation(): Deferred {
  let resolve: () => void = () => {};
  const promise = new Promise<{ data: { session: null } }>((r) => {
    resolve = () => r({ data: { session: null } });
  });
  mockAuth.getSession.mockReturnValue(promise);
  return { resolve, promise };
}

/** Loads the module afresh, as a launch does, with AppState already saying `state`. */
function launch(state: string): Listener {
  appState.currentState = state;
  jest.isolateModules(() => {
    // eslint-disable-next-line @typescript-eslint/no-require-imports -- a fresh module instance per launch
    require('@/data/supabase/client');
  });
  const call = appState.addEventListener.mock.calls.find(([type]) => type === 'change');
  expect(call).toBeDefined();
  return (call as [string, Listener])[1];
}

const settle = () => new Promise<void>((r) => setTimeout(r, 0));

beforeEach(() => {
  jest.clearAllMocks();
});

test('a background launch stops the ticker once the client has initialised', async () => {
  const init = deferInitialisation();
  launch('background');
  // Nothing before initialisation: a stop then would only be overtaken by auth-js's own start.
  await settle();
  expect(mockAuth.stopAutoRefresh).not.toHaveBeenCalled();

  init.resolve();
  await settle();
  expect(mockAuth.stopAutoRefresh).toHaveBeenCalledTimes(1);
  expect(mockAuth.startAutoRefresh).not.toHaveBeenCalled();
});

test('a foreground launch leaves the ticker auth-js started', async () => {
  const init = deferInitialisation();
  launch('active');
  init.resolve();
  await settle();
  expect(mockAuth.stopAutoRefresh).not.toHaveBeenCalled();
  expect(mockAuth.startAutoRefresh).not.toHaveBeenCalled();
});

test('a background launch the driver opens before initialisation ends keeps the ticker', async () => {
  const init = deferInitialisation();
  const onChange = launch('background');
  appState.currentState = 'active';
  onChange('active');
  init.resolve();
  await settle();
  expect(mockAuth.startAutoRefresh).toHaveBeenCalledTimes(1);
  expect(mockAuth.stopAutoRefresh).not.toHaveBeenCalled();
});

test('the ticker follows every later transition', async () => {
  const init = deferInitialisation();
  const onChange = launch('active');
  init.resolve();
  await settle();

  onChange('background');
  expect(mockAuth.stopAutoRefresh).toHaveBeenCalledTimes(1);
  onChange('inactive');
  expect(mockAuth.stopAutoRefresh).toHaveBeenCalledTimes(2);
  onChange('active');
  expect(mockAuth.startAutoRefresh).toHaveBeenCalledTimes(1);
});

test('an unreadable stored session has initialised all the same: a background launch still stops', async () => {
  mockAuth.getSession.mockReturnValue(Promise.reject(new Error('corrupt session blob')));
  launch('background');
  await settle();
  expect(mockAuth.stopAutoRefresh).toHaveBeenCalledTimes(1);
  expect(mockAuth.startAutoRefresh).not.toHaveBeenCalled();
});

test('every request the client sends goes through the bounded fetch; the stored session keeps its key and storage', () => {
  deferInitialisation();
  appState.currentState = 'active';
  let createClient: jest.Mock | undefined;
  jest.isolateModules(() => {
    // eslint-disable-next-line @typescript-eslint/no-require-imports -- the module instance the client sees
    createClient = (require('@supabase/supabase-js') as { createClient: jest.Mock }).createClient;
    // eslint-disable-next-line @typescript-eslint/no-require-imports -- a fresh module instance per launch
    require('@/data/supabase/client');
  });
  const options = createClient?.mock.calls.at(-1)?.[2] as { auth: Record<string, unknown>; global: { fetch: unknown } };
  expect(typeof options.global.fetch).toBe('function');
  // No storageKey of its own: a different key would sign every install out.
  expect(options.auth.storageKey).toBeUndefined();
  expect(options.auth.storage).toBeDefined();
});

describe('readStoredSession: the session auth-js keeps on the phone, read without a refresh', () => {
  type ClientModule = typeof import('@/data/supabase/client');
  function load(): ClientModule {
    deferInitialisation();
    appState.currentState = 'active';
    let mod: ClientModule | undefined;
    jest.isolateModules(() => {
      // eslint-disable-next-line @typescript-eslint/no-require-imports -- a fresh module instance
      mod = require('@/data/supabase/client') as ClientModule;
    });
    return mod as ClientModule;
  }
  const whole = { access_token: 'a', refresh_token: 'r', expires_at: 1_700_000_000, user: { id: 'u1' } };

  beforeEach(() => mockStorage.clear());

  test('reads the session under the client’s own key, expired or not', async () => {
    mockStorage.set('sb-example-auth-token', JSON.stringify(whole));
    expect(await load().readStoredSession()).toEqual(whole);
  });

  test('nothing stored is null', async () => {
    expect(await load().readStoredSession()).toBeNull();
  });

  test.each([
    ['not JSON', 'v2:garbage'],
    ['no refresh token', JSON.stringify({ ...whole, refresh_token: undefined })],
    ['no access token', JSON.stringify({ ...whole, access_token: 1 })],
    ['no expiry', JSON.stringify({ ...whole, expires_at: undefined })],
    ['no user', JSON.stringify({ ...whole, user: null })],
    ['a user with no id', JSON.stringify({ ...whole, user: { id: '' } })],
  ])('what is not a whole session (%s) is null', async (_label, raw) => {
    mockStorage.set('sb-example-auth-token', raw);
    expect(await load().readStoredSession()).toBeNull();
  });

  test('a storage read that throws is null, never a rejection', async () => {
    const mod = load();
    const getItem = jest.spyOn(Map.prototype, 'get').mockImplementation(() => {
      throw new Error('keystore busy');
    });
    try {
      expect(await mod.readStoredSession()).toBeNull();
    } finally {
      getItem.mockRestore();
    }
  });
});

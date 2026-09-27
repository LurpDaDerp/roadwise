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
};
jest.mock('@supabase/supabase-js', () => ({ createClient: jest.fn(() => ({ auth: mockAuth })) }));
jest.mock('@/lib/env', () => ({ env: { supabaseUrl: 'https://example.supabase.co', supabaseAnonKey: 'anon' } }));
jest.mock('@/data/supabase/largeSecureStore', () => ({ LargeSecureStore: class {} }));
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

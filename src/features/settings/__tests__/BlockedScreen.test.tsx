import { screen, waitFor } from '@testing-library/react-native';

import { answerRpc, appWorld, clearQueryClients, tap } from '@/features/permissions/__fixtures__/harness';

import { BlockedScreen } from '../BlockedScreen';
import { settingsCopy } from '../copy';

const mockRpc = jest.fn();
jest.mock('@/data/server/rpc', () => {
  const actual = jest.requireActual('@/data/server/rpc');
  return { ...actual, callRpc: (fn: string, args?: unknown) => mockRpc(fn, args) };
});
jest.mock('@/data/supabase/client', () => ({ supabase: {} }));
jest.mock('@/data/supabase/session', () => ({ useSession: () => ({ session: { user: { id: 'me' } } }) }));
jest.mock('expo-router', () => {
  const { useEffect } = jest.requireActual<typeof import('react')>('react');
  return {
    useRouter: () => ({ back: jest.fn(), canGoBack: () => true }),
    useFocusEffect: (effect: () => void | (() => void)) => useEffect(effect, [effect]),
  };
});

beforeEach(() => mockRpc.mockReset());
afterEach(() => clearQueryClients());

it('lists blocked users and unblocks one, then reads the list again', async () => {
  let blocked = [
    { user_id: 'u1', username: 'loud_larry' },
    { user_id: 'u2', username: 'meanie' },
  ];
  answerRpc(mockRpc, {
    list_blocked: () => blocked,
    unblock_user: (args) => {
      blocked = blocked.filter((b) => b.user_id !== args?.p_user_id);
      return null;
    },
  });
  const w = await appWorld();
  await w.render(<BlockedScreen />);
  expect(await screen.findByTestId('blocked-loud_larry')).toBeOnTheScreen();

  await tap('unblock-loud_larry');
  expect(mockRpc).toHaveBeenCalledWith('unblock_user', { p_user_id: 'u1' });
  await waitFor(() => expect(screen.queryByTestId('blocked-loud_larry')).toBeNull());
  expect(screen.getByTestId('blocked-meanie')).toBeOnTheScreen();
});

it('says so when nobody is blocked', async () => {
  answerRpc(mockRpc, { list_blocked: [] });
  const w = await appWorld();
  await w.render(<BlockedScreen />);
  expect(await screen.findByText(settingsCopy.blocked.empty)).toBeOnTheScreen();
});

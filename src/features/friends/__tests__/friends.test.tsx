/**
 * Friends: requests answered and cancelled from the list, search only from 3 letters, the QR code
 * holds the add link, and the scanner opens only a RoadWise add link.
 */
import { act, fireEvent, screen, waitFor, within } from '@testing-library/react-native';

import { RpcError } from '@/data/server/rpc';
import { answerRpc, appWorld, clearQueryClients, fakeAppState, tap } from '@/features/permissions/__fixtures__/harness';
import type { PublicCard } from '@/features/social/api';

import { AddFriendsScreen } from '../AddFriendsScreen';
import { friendsCopy as copy } from '../copy';
import { FriendsScreen } from '../FriendsScreen';
import { ScanScreen } from '../ScanScreen';

const mockRpc = jest.fn();
jest.mock('@/data/server/rpc', () => {
  const actual = jest.requireActual('@/data/server/rpc');
  return { ...actual, callRpc: (fn: string, args?: unknown) => mockRpc(fn, args) };
});
jest.mock('@/data/supabase/client', () => ({ supabase: {} }));
/** The session: the signed-in user, and the profile it holds (cached on the phone for offline starts). */
const mockSession: { session: { user: { id: string } }; profile: { username: string | null } | null } = { session: { user: { id: 'me' } }, profile: null };
jest.mock('@/data/supabase/session', () => ({ useSession: () => mockSession }));
const mockRouter = { push: jest.fn(), replace: jest.fn(), back: jest.fn(), canGoBack: () => true };
jest.mock('expo-router', () => {
  const { useEffect } = jest.requireActual<typeof import('react')>('react');
  return {
    useRouter: () => mockRouter,
    useFocusEffect: (effect: () => void | (() => void)) => useEffect(effect, [effect]),
  };
});
jest.mock('react-native-qrcode-svg', () => {
  const { Text } = jest.requireActual<typeof import('react-native')>('react-native');
  return { __esModule: true, default: ({ value }: { value: string }) => <Text testID="qr-value">{value}</Text> };
});
/** What the phone's camera permission is now; the hook shows it as of its last read (on mount, or a get). */
const mockPermission = { granted: true, canAskAgain: true, status: 'granted' };
const mockRequest = jest.fn();
const mockGet = jest.fn();
jest.mock('expo-camera', () => {
  const { useCallback, useState } = jest.requireActual<typeof import('react')>('react');
  const { View } = jest.requireActual<typeof import('react-native')>('react-native');
  return {
    CameraView: (props: object) => <View {...props} />,
    useCameraPermissions: () => {
      const [shown, setShown] = useState(() => ({ ...mockPermission }));
      const get = useCallback(async () => {
        mockGet();
        const now = { ...mockPermission };
        setShown(now);
        return now;
      }, []);
      return [shown, mockRequest, get];
    },
  };
});

const card = (username: string, over: Partial<PublicCard> = {}): PublicCard => ({
  user_id: `id-${username}`,
  username,
  safety_rating: 90,
  ranked: true,
  ...over,
});

beforeEach(() => {
  mockRpc.mockReset();
  mockRouter.push.mockClear();
  mockRouter.replace.mockClear();
  mockRequest.mockClear();
  mockGet.mockClear();
  Object.assign(mockPermission, { granted: true, canAskAgain: true, status: 'granted' });
  mockSession.profile = null;
});
afterEach(() => clearQueryClients());

describe('Friends list', () => {
  it('answers an incoming request and cancels a sent one', async () => {
    answerRpc(mockRpc, {
      list_friends: { friends: [card('pal')], incoming: [card('newbie')], outgoing: [card('crush')] },
    });
    const w = await appWorld();
    await w.render(<FriendsScreen />);
    expect(await screen.findByTestId('friend-pal')).toBeOnTheScreen();

    await tap('accept-newbie');
    await waitFor(() =>
      expect(mockRpc).toHaveBeenCalledWith('respond_friend_request', { p_user_id: 'id-newbie', p_accept: true })
    );
    await tap('cancel-crush');
    await waitFor(() => expect(mockRpc).toHaveBeenCalledWith('cancel_friend_request', { p_user_id: 'id-crush' }));
  });

  it('Decline never spins Accept (both answer with the same call); Accept spins for its own answer only', async () => {
    let release = () => {};
    answerRpc(mockRpc, {
      list_friends: { friends: [], incoming: [card('newbie')], outgoing: [] },
      respond_friend_request: () => new Promise((resolve) => (release = () => resolve(null))),
    });
    const w = await appWorld();
    await w.render(<FriendsScreen />);
    await screen.findByTestId('incoming-newbie');

    await tap('decline-newbie');
    expect(mockRpc).toHaveBeenCalledWith('respond_friend_request', { p_user_id: 'id-newbie', p_accept: false });
    expect(screen.getByTestId('accept-newbie')).toHaveProp('accessibilityState', { disabled: true, busy: false });
    expect(within(screen.getByTestId('accept-newbie')).getByText(copy.accept)).toBeOnTheScreen();
    expect(screen.getByTestId('decline-newbie')).toHaveProp('accessibilityState', { disabled: true, busy: false });
    await act(async () => release());
    await waitFor(() => expect(screen.getByTestId('accept-newbie')).toHaveProp('accessibilityState', { disabled: false, busy: false }));

    await tap('accept-newbie');
    expect(screen.getByTestId('accept-newbie')).toHaveProp('accessibilityState', { disabled: true, busy: true });
    expect(screen.getByTestId('decline-newbie')).toHaveProp('accessibilityState', { disabled: true, busy: false });
    await act(async () => release());
    await waitFor(() => expect(screen.getByTestId('accept-newbie')).toHaveProp('accessibilityState', { disabled: false, busy: false }));
  });

  it('an answer refused because the request is gone re-reads the list: the stale row leaves and the line stays', async () => {
    let incoming = [card('newbie')];
    answerRpc(mockRpc, {
      list_friends: () => ({ friends: [card('pal')], incoming, outgoing: [] }),
      respond_friend_request: new RpcError('no such request', 'P0002'),
    });
    const w = await appWorld();
    await w.render(<FriendsScreen />);
    await screen.findByTestId('incoming-newbie');
    // newbie cancelled the request meanwhile
    incoming = [];
    await tap('accept-newbie');
    expect(await screen.findByText("That request isn't there anymore.")).toBeOnTheScreen();
    await waitFor(() => expect(screen.queryByTestId('incoming-newbie')).toBeNull());
    expect(screen.getByTestId('friend-pal')).toBeOnTheScreen();
    expect(screen.getByTestId('friends-action-error')).toBeOnTheScreen();
  });

  it('any other refusal (a rate limit, no connection) keeps the list as it was and reads nothing again', async () => {
    const reads = () => mockRpc.mock.calls.filter(([fn]) => fn === 'list_friends').length;
    answerRpc(mockRpc, {
      list_friends: { friends: [], incoming: [card('newbie')], outgoing: [card('crush')] },
      respond_friend_request: new RpcError('too many requests', '42501'),
      cancel_friend_request: new RpcError('TypeError: Network request failed', ''),
    });
    const w = await appWorld();
    await w.render(<FriendsScreen />);
    await screen.findByTestId('incoming-newbie');
    const before = reads();
    await tap('accept-newbie');
    expect(await screen.findByText("That's a lot of tries. Wait a minute, then try again.")).toBeOnTheScreen();
    await tap('cancel-crush');
    expect(await screen.findByText("Couldn't reach RoadWise. Check your connection and try again.")).toBeOnTheScreen();
    expect(reads()).toBe(before);
    expect(screen.getByTestId('incoming-newbie')).toBeOnTheScreen();
  });

  it('the pull spinner shows for a pull only, until the list is back, never for a background refetch', async () => {
    const lists = { friends: [card('pal')], incoming: [], outgoing: [] };
    let hold = false;
    let release = () => {};
    answerRpc(mockRpc, {
      list_friends: () => (hold ? new Promise((resolve) => (release = () => resolve(lists))) : lists),
    });
    const w = await appWorld();
    await w.render(<FriendsScreen />);
    await screen.findByTestId('friend-pal');
    const control = () => (screen.getByTestId('friends-screen').props as { refreshControl: { props: { refreshing: boolean; onRefresh: () => void } } }).refreshControl.props;
    hold = true;

    // A focus refetch, or one after an answered request: no spinner, so the page doesn't move.
    await act(async () => {
      void w.client.invalidateQueries();
    });
    await waitFor(() => expect(w.client.isFetching()).toBe(1));
    expect(control().refreshing).toBe(false);
    await act(async () => release());
    await waitFor(() => expect(w.client.isFetching()).toBe(0));

    // The driver's pull: the spinner until the list is back.
    await act(async () => control().onRefresh());
    expect(control().refreshing).toBe(true);
    await act(async () => release());
    expect(control().refreshing).toBe(false);
  });

  it('a sent request: its row opens the profile and Cancel is its own button beside it (VoiceOver reaches both)', async () => {
    answerRpc(mockRpc, { list_friends: { friends: [], incoming: [], outgoing: [card('crush')] } });
    const w = await appWorld();
    await w.render(<FriendsScreen />);
    const row = await screen.findByTestId('outgoing-crush');
    // Not inside the row's button, which would hide it from the screen reader.
    expect(within(row).queryByTestId('cancel-crush')).toBeNull();
    expect(screen.getByRole('button', { name: 'crush' })).toBeOnTheScreen();
    expect(screen.getByTestId('cancel-crush')).toHaveProp('accessibilityRole', 'button');
    await tap('outgoing-crush');
    expect(mockRouter.push).toHaveBeenCalledWith('/u/crush');
  });

  it('each friend reads their Safety Rating, or "No rating yet"; no level', async () => {
    answerRpc(mockRpc, { list_friends: { friends: [card('pal'), card('quiet', { safety_rating: null, ranked: false })], incoming: [], outgoing: [] } });
    const w = await appWorld();
    await w.render(<FriendsScreen />);
    expect(await screen.findByText('Safety Rating 90')).toBeOnTheScreen();
    expect(screen.getByText('No rating yet')).toBeOnTheScreen();
    expect(screen.queryByText(/Level/)).toBeNull();
  });

  it('a friend opens their profile', async () => {
    answerRpc(mockRpc, { list_friends: { friends: [card('Pal')], incoming: [], outgoing: [] } });
    const w = await appWorld();
    await w.render(<FriendsScreen />);
    await tap('friend-Pal');
    expect(mockRouter.push).toHaveBeenCalledWith('/u/pal');
  });

  it('a card with no username is left out instead of crashing the list', async () => {
    const nameless = { ...card('ghost'), user_id: 'id-ghost', username: null as unknown as string };
    answerRpc(mockRpc, { list_friends: { friends: [card('pal')], incoming: [nameless], outgoing: [] } });
    const w = await appWorld();
    await w.render(<FriendsScreen />);
    expect(await screen.findByTestId('friend-pal')).toBeOnTheScreen();
    expect(screen.queryByTestId('friends-incoming')).toBeNull();
  });

  it('nobody yet: says how to add someone, and where ratings compare', async () => {
    answerRpc(mockRpc, { list_friends: { friends: [], incoming: [], outgoing: [] } });
    const w = await appWorld();
    await w.render(<FriendsScreen />);
    expect(await screen.findByText(copy.empty)).toBeOnTheScreen();
    expect(screen.getByText('Add friends by username or QR code, then see how your ratings compare on the Friends tab.')).toBeOnTheScreen();
  });
});

describe('Add friends', () => {
  it('searches only from 3 letters, and the QR code is my add link', async () => {
    answerRpc(mockRpc, {
      get_my_summary: { profile: { username: 'swift_fox' } },
      search_users: [{ user_id: 'id-maya', username: 'maya_16', safety_rating: null }],
    });
    const w = await appWorld();
    await w.render(<AddFriendsScreen debounceMs={0} />);
    expect(await screen.findByTestId('qr-value')).toHaveTextContent('roadwise://add/swift_fox');

    const input = screen.getByTestId('friends-search');
    await act(async () => {
      fireEvent.changeText(input, 'ma');
    });
    expect(screen.getByText(copy.searchHint)).toBeOnTheScreen();
    expect(mockRpc).not.toHaveBeenCalledWith('search_users', expect.anything());

    await act(async () => {
      fireEvent.changeText(input, 'MAY');
    });
    await tap('result-maya_16');
    expect(mockRpc).toHaveBeenCalledWith('search_users', { p_query: 'may' });
    expect(mockRouter.push).toHaveBeenCalledWith('/u/maya_16');
  });

  it('offline, or before the summary answers, my code still shows: the session holds my username', async () => {
    mockSession.profile = { username: 'swift_fox' };
    // The summary never answers (no connection, or a cold start that has not heard back yet).
    answerRpc(mockRpc, { get_my_summary: () => new Promise(() => {}) });
    const w = await appWorld();
    await w.render(<AddFriendsScreen debounceMs={0} />);
    expect(await screen.findByTestId('qr-value')).toHaveTextContent('roadwise://add/swift_fox');
    expect(mockRpc).toHaveBeenCalledWith('get_my_summary', undefined);
    expect(screen.getByTestId('share-link')).toBeOnTheScreen();
    expect(screen.queryByText(copy.noUsername)).toBeNull();
  });

  it('with no username anywhere, it asks for one first and shows no code', async () => {
    answerRpc(mockRpc, { get_my_summary: { profile: { username: null } } });
    const w = await appWorld();
    await w.render(<AddFriendsScreen debounceMs={0} />);
    await waitFor(() => expect(mockRpc).toHaveBeenCalledWith('get_my_summary', undefined));
    expect(await screen.findByText(copy.noUsername)).toBeOnTheScreen();
    expect(screen.queryByTestId('qr-value')).toBeNull();
  });

  it('ignores a leading @', async () => {
    answerRpc(mockRpc, {
      get_my_summary: { profile: { username: 'swift_fox' } },
      search_users: [{ user_id: 'id-maya', username: 'maya_16', safety_rating: null }],
    });
    const w = await appWorld();
    await w.render(<AddFriendsScreen debounceMs={0} />);
    const input = screen.getByTestId('friends-search');
    expect(input).toHaveProp('maxLength', 21);

    // "@ma" is two letters: still the 3-letter hint
    await act(async () => {
      fireEvent.changeText(input, '@ma');
    });
    expect(screen.getByText(copy.searchHint)).toBeOnTheScreen();
    expect(mockRpc).not.toHaveBeenCalledWith('search_users', expect.anything());

    await act(async () => {
      fireEvent.changeText(input, '@maya');
    });
    expect(await screen.findByTestId('result-maya_16')).toBeOnTheScreen();
    expect(mockRpc).toHaveBeenCalledWith('search_users', { p_query: 'maya' });
  });
});

describe('Scan', () => {
  it('opens the profile in a RoadWise add link', async () => {
    const w = await appWorld();
    await w.render(<ScanScreen />);
    const camera = await screen.findByTestId('scan-camera');
    await act(async () => {
      camera.props.onBarcodeScanned({ data: 'roadwise://add/Maya_16', type: 'qr' });
    });
    expect(mockRouter.replace).toHaveBeenCalledWith('/u/maya_16');
  });

  it('refuses anything else, and opens nothing', async () => {
    const w = await appWorld();
    await w.render(<ScanScreen />);
    const camera = await screen.findByTestId('scan-camera');
    await act(async () => {
      camera.props.onBarcodeScanned({ data: 'https://evil.example/add/maya_16', type: 'qr' });
    });
    expect(await screen.findByTestId('scan-rejected')).toBeOnTheScreen();
    expect(mockRouter.replace).not.toHaveBeenCalled();
    expect(mockRouter.push).not.toHaveBeenCalled();
  });

  it('a camera that will not start says so in place of the viewfinder', async () => {
    const w = await appWorld();
    await w.render(<ScanScreen />);
    const camera = await screen.findByTestId('scan-camera');
    expect(screen.queryByTestId('scan-no-camera')).toBeNull();
    await act(async () => {
      camera.props.onMountError({ message: 'capture session failed' });
    });
    expect(within(screen.getByTestId('scan-no-camera')).getByText(copy.noCamera)).toBeOnTheScreen();
    expect(screen.queryByTestId('scan-camera')).toBeNull();
  });

  it('asks for the camera only on this screen, and explains a refusal', async () => {
    Object.assign(mockPermission, { granted: false, canAskAgain: true, status: 'undetermined' });
    const w = await appWorld();
    await w.render(<ScanScreen />);
    await waitFor(() => expect(mockRequest).toHaveBeenCalledTimes(1));
    expect(screen.getByText(copy.cameraWhy)).toBeOnTheScreen();
    expect(screen.queryByTestId('scan-camera')).toBeNull();
  });

  it('a camera turned off for good points to Settings', async () => {
    Object.assign(mockPermission, { granted: false, canAskAgain: false, status: 'denied' });
    const w = await appWorld();
    await w.render(<ScanScreen />);
    expect(await screen.findByText(copy.cameraDenied)).toBeOnTheScreen();
    expect(screen.getByTestId('scan-settings')).toBeOnTheScreen();
    expect(mockRequest).not.toHaveBeenCalled();
  });

  it('back from Settings with the camera turned on (Android keeps the app running), the scanner opens without a prompt', async () => {
    Object.assign(mockPermission, { granted: false, canAskAgain: false, status: 'denied' });
    const appState = fakeAppState();
    const w = await appWorld();
    await w.render(<ScanScreen appState={appState} />);
    expect(await screen.findByText(copy.cameraDenied)).toBeOnTheScreen();
    expect(mockGet).not.toHaveBeenCalled();

    // The driver opens Settings, allows Camera and comes back.
    Object.assign(mockPermission, { granted: true, canAskAgain: true, status: 'granted' });
    await act(async () => appState.foreground());
    expect(mockGet).toHaveBeenCalledTimes(1);
    expect(await screen.findByTestId('scan-camera')).toBeOnTheScreen();
    expect(screen.queryByText(copy.cameraDenied)).toBeNull();
    expect(mockRequest).not.toHaveBeenCalled();
  });

  it('stops listening for the app coming back once the screen closes', async () => {
    const appState = fakeAppState();
    const w = await appWorld();
    const { unmount } = await w.render(<ScanScreen appState={appState} />);
    expect(appState.listeners()).toBe(1);
    await unmount();
    expect(appState.listeners()).toBe(0);
  });
});

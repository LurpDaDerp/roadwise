/**
 * Friends: requests answered and cancelled from the list, search only from 3 letters, the QR code
 * holds the add link, and the scanner opens only a RoadWise add link.
 */
import { act, fireEvent, screen, waitFor, within } from '@testing-library/react-native';

import { answerRpc, appWorld, clearQueryClients, tap } from '@/features/permissions/__fixtures__/harness';
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
jest.mock('@/data/supabase/session', () => ({ useSession: () => ({ session: { user: { id: 'me' } } }) }));
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
const mockPermission = { granted: true, canAskAgain: true, status: 'granted' };
const mockRequest = jest.fn();
jest.mock('expo-camera', () => {
  const { View } = jest.requireActual<typeof import('react-native')>('react-native');
  return {
    CameraView: (props: object) => <View {...props} />,
    useCameraPermissions: () => [mockPermission, mockRequest],
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
  Object.assign(mockPermission, { granted: true, canAskAgain: true, status: 'granted' });
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
});

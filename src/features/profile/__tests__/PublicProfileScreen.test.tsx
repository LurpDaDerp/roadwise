/**
 * `/u/<username>`: the friend button for each relationship, what each press sends, block with a
 * confirm, and "not found" (also how a block looks).
 */
import { act, fireEvent, screen, waitFor } from '@testing-library/react-native';
import { Alert } from 'react-native';

import { RpcError } from '@/data/server/rpc';
import { appWorld, clearQueryClients } from '@/features/permissions/__fixtures__/harness';
import type { PublicProfile, Relationship } from '@/features/social/api';

import { profileCopy } from '../copy';
import { PublicProfileScreen, relationshipButtons } from '../PublicProfileScreen';

const mockRpc = jest.fn();
jest.mock('@/data/server/rpc', () => {
  const actual = jest.requireActual('@/data/server/rpc');
  return { ...actual, callRpc: (fn: string, args?: unknown) => mockRpc(fn, args) };
});
jest.mock('@/data/supabase/client', () => ({ supabase: {} }));
jest.mock('@/data/supabase/session', () => ({ useSession: () => ({ session: { user: { id: 'me' } } }) }));
const mockRouter = { push: jest.fn(), replace: jest.fn(), back: jest.fn(), canGoBack: jest.fn(() => true) };
jest.mock('expo-router', () => {
  const { useEffect } = jest.requireActual<typeof import('react')>('react');
  return {
    useRouter: () => mockRouter,
    useFocusEffect: (effect: () => void | (() => void)) => useEffect(effect, [effect]),
  };
});

const copy = profileCopy.public;

/** Finds, then presses inside one act (never a waitFor nested inside act). */
async function tap(testID: string) {
  const el = await screen.findByTestId(testID, {}, { timeout: 3000 });
  await act(async () => {
    fireEvent.press(el);
  });
}

const profile = (over: Partial<PublicProfile> = {}): PublicProfile => ({
  user_id: 'u-fox',
  username: 'swift_fox',
  safety_rating: 91.2,
  ranked: true,
  achievements: ['first_drive'],
  relationship: 'none',
  can_view_stats: false,
  can_view_heatmap: false,
  scores: null,
  ...over,
});

function serve(p: PublicProfile | Error) {
  mockRpc.mockImplementation(async (fn: string) => {
    if (fn === 'get_profile') {
      if (p instanceof Error) throw p;
      return p;
    }
    return null;
  });
}

/**
 * Renders the screen and, for a profile, waits until it has loaded. The loading state draws its own
 * top bar, which unmounts when the profile arrives; a press found there but fired after the swap
 * lands on an unmounted element and does nothing (RNTL ignores it), so every tap waits for the
 * loaded screen.
 */
async function show(p: PublicProfile | Error) {
  serve(p);
  const w = await appWorld();
  await w.render(<PublicProfileScreen username="Swift_Fox" />);
  if (!(p instanceof Error)) await screen.findByTestId('profile-username', {}, { timeout: 3000 });
  return w;
}

beforeEach(() => {
  mockRpc.mockReset();
  mockRouter.back.mockClear();
  mockRouter.replace.mockClear();
  mockRouter.canGoBack.mockImplementation(() => true);
});
afterEach(() => clearQueryClients());

describe('relationship buttons', () => {
  it.each<[Relationship, string[]]>([
    ['none', ['Add friend']],
    ['outgoing', ['Requested']],
    ['incoming', ['Accept', 'Decline']],
    ['friend', ['Friends']],
    ['self', []],
  ])('%s shows %p', (rel, labels) => {
    expect(relationshipButtons(rel).map((b) => b.label)).toEqual(labels);
  });

  it('asks for the lower-cased username', async () => {
    await show(profile());
    await screen.findByTestId('relationship-send');
    expect(mockRpc).toHaveBeenCalledWith('get_profile', { p_username: 'swift_fox' });
  });

  it('Add friend sends a request for that user id', async () => {
    await show(profile({ relationship: 'none' }));
    await tap('relationship-send');
    await waitFor(() => expect(mockRpc).toHaveBeenCalledWith('send_friend_request', { p_user_id: 'u-fox' }));
  });

  it('Accept and Decline answer an incoming request', async () => {
    await show(profile({ relationship: 'incoming' }));
    await tap('relationship-accept');
    await waitFor(() =>
      expect(mockRpc).toHaveBeenCalledWith('respond_friend_request', { p_user_id: 'u-fox', p_accept: true })
    );
    await tap('relationship-decline');
    await waitFor(() =>
      expect(mockRpc).toHaveBeenCalledWith('respond_friend_request', { p_user_id: 'u-fox', p_accept: false })
    );
  });

  it('Friends asks before removing', async () => {
    const alert = jest.spyOn(Alert, 'alert').mockImplementation((_t, _b, buttons) => {
      buttons?.find((b) => b.style === 'destructive')?.onPress?.();
    });
    await show(profile({ relationship: 'friend' }));
    await tap('relationship-remove');
    expect(alert).toHaveBeenCalledWith(copy.removeTitle('swift_fox'), copy.removeBody, expect.any(Array), expect.anything());
    await waitFor(() => expect(mockRpc).toHaveBeenCalledWith('remove_friend', { p_user_id: 'u-fox' }));
    alert.mockRestore();
  });

  it('your own profile has no friend button and no report or block', async () => {
    await show(profile({ relationship: 'self' }));
    await screen.findByTestId('profile-username');
    expect(screen.queryByTestId(/^relationship-/)).toBeNull();
    expect(screen.queryByTestId('profile-more')).toBeNull();
  });

  it('a failed request says why in plain words', async () => {
    await show(profile({ relationship: 'none' }));
    mockRpc.mockImplementation(async (fn: string) => {
      if (fn === 'get_profile') return profile();
      throw new RpcError('you have reached the friend limit', '42501');
    });
    await tap('relationship-send');
    expect(await screen.findByText("You've hit the 200-friend limit. Remove someone to add someone new.")).toBeOnTheScreen();
  });
});

describe('moderation', () => {
  it('Block confirms, blocks, then leaves the profile', async () => {
    const alert = jest.spyOn(Alert, 'alert').mockImplementation((_t, _b, buttons) => {
      buttons?.find((b) => b.style === 'destructive')?.onPress?.();
    });
    await show(profile());
    await tap('profile-more');
    await tap('profile-block');
    expect(alert).toHaveBeenCalledWith(copy.blockTitle('swift_fox'), copy.blockBody, expect.any(Array), expect.anything());
    await waitFor(() => expect(mockRpc).toHaveBeenCalledWith('block_user', { p_user_id: 'u-fox' }));
    await waitFor(() => expect(mockRouter.back).toHaveBeenCalled());
    alert.mockRestore();
  });

  it('opened straight from a link (nothing to go back to), Back and a block go Home', async () => {
    mockRouter.canGoBack.mockImplementation(() => false);
    const alert = jest.spyOn(Alert, 'alert').mockImplementation((_t, _b, buttons) => {
      buttons?.find((b) => b.style === 'destructive')?.onPress?.();
    });
    await show(profile());
    await tap('top-bar-back');
    expect(mockRouter.replace).toHaveBeenLastCalledWith('/(tabs)/home');
    mockRouter.replace.mockClear();
    await tap('profile-more');
    await tap('profile-block');
    await waitFor(() => expect(mockRouter.replace).toHaveBeenCalledWith('/(tabs)/home'));
    expect(mockRouter.back).not.toHaveBeenCalled();
    alert.mockRestore();
  });

  it('Report sends the chosen reason', async () => {
    await show(profile());
    await tap('profile-more');
    await tap('profile-report');
    // The report sheet waits for the menu to leave: iOS shows one modal at a time.
    expect(screen.queryByTestId('report-harassment')).toBeNull();
    await tap('report-harassment');
    await waitFor(() =>
      expect(mockRpc).toHaveBeenCalledWith('report_target', {
        p_kind: 'user',
        p_target_id: 'u-fox',
        p_reason: 'harassment',
        p_note: '',
      })
    );
    expect(await screen.findByTestId('report-sent')).toBeOnTheScreen();
  });

  it('the menu reports only the driver', async () => {
    await show(profile());
    await tap('profile-more');
    expect(screen.getByTestId('profile-report')).toBeOnTheScreen();
    expect(screen.queryByTestId('profile-report-clan')).toBeNull();
  });

  it('not found (or blocked) is one friendly empty state', async () => {
    await show(new RpcError('profile not found', 'P0002'));
    expect(await screen.findByTestId('public-profile-not-found', {}, { timeout: 4000 })).toBeOnTheScreen();
    expect(screen.getByText(copy.notFound)).toBeOnTheScreen();
  });
});

describe('what friends see', () => {
  it('the card: the avatar, the username and the Safety Rating, nothing of your own; no level, streak or league', async () => {
    await show(profile());
    expect(await screen.findByTestId('profile-username')).toHaveTextContent('swift_fox');
    expect(screen.getByLabelText('Safety Rating 91')).toBeOnTheScreen();
    expect(screen.queryByTestId('profile-since')).toBeNull();
    expect(screen.queryByTestId('profile-trend')).toBeNull();
    expect(screen.queryByTestId('profile-totals')).toBeNull();
    expect(screen.queryByText(/level|streak|league|clan|points?\b|pts/i)).toBeNull();
  });

  it('a driver who keeps their rating from you reads "No rating yet"', async () => {
    await show(profile({ safety_rating: null, ranked: false }));
    expect(await screen.findByLabelText('Safety Rating: No rating yet')).toBeOnTheScreen();
  });

  it('a Categories card with the six whole-number scores, Phone use among them, only when they share them', async () => {
    await show(profile({ relationship: 'friend', scores: { acceleration: 95, braking: 72, turning: 100, attention: null, phone: 81, speed: 88 } }));
    const card = await screen.findByTestId('public-categories');
    expect(card).toHaveTextContent(/Categories/);
    expect(screen.getByLabelText('Braking 72')).toBeOnTheScreen();
    expect(screen.getByLabelText('Attention, no score yet')).toBeOnTheScreen();
    expect(screen.getByLabelText('Phone use 81')).toBeOnTheScreen();
    expect(screen.getByTestId('public-category-speed')).toHaveTextContent(/88/);
    await clearQueryClients();
    // Phone use not scored yet, or left out by the server: a dash, like any unscored category.
    await show(profile({ relationship: 'friend', scores: { acceleration: 95, braking: 72, turning: 100, attention: null, speed: 88 } }));
    expect(await screen.findByLabelText('Phone use, no score yet')).toBeOnTheScreen();
    expect(screen.getByTestId('public-category-phone')).toHaveTextContent('—Phone use');
    await clearQueryClients();
    await show(profile({ relationship: 'friend', scores: null }));
    await screen.findByTestId('profile-username');
    expect(screen.queryByTestId('public-categories')).toBeNull();
  });

  it('badges show when they share them; a friend who keeps them sends none and the card stays away', async () => {
    await show(profile({ relationship: 'friend', achievements: ['first_drive', 'clean_100'] }));
    expect(await screen.findByTestId('achievement-clean_100-unlocked')).toBeOnTheScreen();
    await clearQueryClients();
    await show(profile({ relationship: 'friend', achievements: [] }));
    await screen.findByTestId('profile-username');
    expect(screen.queryByTestId('public-achievements')).toBeNull();
  });

  it('stats only when allowed', async () => {
    mockRpc.mockImplementation(async (fn: string) => {
      if (fn === 'get_profile') return profile({ relationship: 'friend', can_view_stats: true });
      if (fn === 'get_member_stats')
        return {
          miles: 200, durationS: 20000, nightMiles: 0, drives: 10, cleanDrives: 9, speeding: 1, hardBrake: 2, hardAccel: 0, hardCorner: 0,
        };
      return null;
    });
    const w = await appWorld();
    await w.render(<PublicProfileScreen username="swift_fox" />);
    await screen.findByTestId('relationship-remove');
    expect(await screen.findByTestId('member-stats', {}, { timeout: 3000 })).toBeOnTheScreen();
    expect(await screen.findByLabelText(/Clean drives/)).toBeOnTheScreen();
    expect(screen.getByLabelText(/^Distance, 200/)).toBeOnTheScreen();
    expect(screen.queryByText('Phone pickups')).toBeNull();
    expect(mockRpc).toHaveBeenCalledWith('get_member_stats', { p_user_id: 'u-fox' });
    expect(mockRpc).not.toHaveBeenCalledWith('get_heatmap', expect.anything());
  });
});

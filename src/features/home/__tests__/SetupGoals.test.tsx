/**
 * Home's "Get set up" row: which goals it offers and when each is done, open tiles first, where a
 * tile goes, and when the row is gone (all done, closed for good, during a drive).
 */
import { act, screen, waitFor, within } from '@testing-library/react-native';
import { useEffect, useState } from 'react';

import { SIGN_OUT_SETTINGS } from '@/boot/device';
import { EMERGENCY_CONTACTS_KEY } from '@/features/emergency/model';
import { appWorld, clearQueryClients, tap } from '@/features/permissions/__fixtures__/harness';
import { PLACES_KEY } from '@/features/places/model';

import { homeCopy } from '../copy';
import { HomeSetupGoals, orderGoals, SETUP_GOALS_DISMISSED_KEY } from '../SetupGoals';

const mockPush = jest.fn();
jest.mock('@/data/supabase/client', () => ({ supabase: {} }));
jest.mock('expo-notifications', () => ({}));
jest.mock('expo-router', () => ({
  useRouter: () => ({ back: jest.fn(), push: mockPush, canGoBack: () => true }),
  useFocusEffect: (fn: () => void | (() => void)) => {
    // eslint-disable-next-line @typescript-eslint/no-require-imports -- the real React inside a mock factory
    const { useEffect } = require('react') as typeof import('react');
    useEffect(() => fn(), [fn]);
  },
}));
let mockCarView: unknown = { status: 'unsupported' };
jest.mock('@/features/carLink/useCarLink', () => ({ useCarLink: () => ({ view: mockCarView }) }));
/** The friends query as Home sees it. */
let mockFriends: { data?: { friends: unknown[] }; status: string; fetchStatus: string } = { data: { friends: [] }, status: 'success', fetchStatus: 'idle' };
const friendsList = (friends: unknown[]) => ({ data: { friends }, status: 'success', fetchStatus: 'idle' });
jest.mock('@/features/social/api', () => ({ useFriends: () => mockFriends }));
/** The DashPal runtime's state (null: no runtime, as in a build without Bluetooth). */
let mockDashcam: unknown = null;
jest.mock('@/dashcam/ui/useDashcam', () => ({ useDashcamSelector: (select: (s: unknown) => unknown) => select(mockDashcam) }));

const HOME = { id: 'home', kind: 'home', name: 'Home', address: '1 Main St', area: '', lat: 47.6, lng: -122.3 };
const MOM = { id: 'contact-mom', name: 'Mom', phone: '5551234567' };
const READY = (cars: unknown[]) => ({ status: 'ready', state: { cars, outputs: [], seen: [], notMine: [] } });
const PAIRED_DASHPAL = { loaded: true, link: { paired: { dashcamId: 'd', name: 'DashPal-AB12' } } };

/** Renders the row again on `redraw()` (the mocks are read on each render). */
let redraw: () => void = () => {};
function Redrawn() {
  const [, set] = useState(0);
  useEffect(() => {
    redraw = () => set((x) => x + 1);
  }, []);
  return <HomeSetupGoals hidden={false} />;
}

const tileIds = () => within(screen.getByTestId('home-setup-row')).getAllByTestId(/^home-setup-[a-z]+$/).map((el) => String(el.props.testID));

beforeEach(() => {
  mockPush.mockClear();
  mockCarView = { status: 'unsupported' };
  mockFriends = friendsList([]);
  mockDashcam = null;
});
afterEach(() => clearQueryClients());

describe('the goals', () => {
  it('open goals come first, then the done ones, each in order', () => {
    const order = orderGoals([
      { id: 'emergency', done: true },
      { id: 'places', done: false },
      { id: 'dashpal', done: true },
      { id: 'friend', done: false },
    ]);
    expect(order.map((g) => g.id)).toEqual(['places', 'friend', 'emergency', 'dashpal']);
  });

  it('offers emergency contacts, places, DashPal and a first friend, with no car tile where the car link is not supported', async () => {
    const w = await appWorld();
    await w.render(<HomeSetupGoals hidden={false} />);
    expect(await screen.findByText(homeCopy.setup.title)).toBeOnTheScreen();
    expect(tileIds()).toEqual(['home-setup-emergency', 'home-setup-places', 'home-setup-dashpal', 'home-setup-friend']);
    expect(screen.getByTestId('home-setup-count')).toHaveTextContent('0 of 4');
  });

  it('adds Your car on an iPhone with the car link, and marks each done goal with a check at the end', async () => {
    mockCarView = READY([{ uid: 'car-1', name: 'My car' }]);
    mockDashcam = PAIRED_DASHPAL;
    mockFriends = friendsList([{ username: 'pal' }]);
    const w = await appWorld({ settings: { [EMERGENCY_CONTACTS_KEY]: [MOM] } });
    await w.render(<HomeSetupGoals hidden={false} />);
    await screen.findByTestId('home-setup');
    expect(tileIds()).toEqual(['home-setup-places', 'home-setup-emergency', 'home-setup-car', 'home-setup-dashpal', 'home-setup-friend']);
    expect(screen.getByTestId('home-setup-count')).toHaveTextContent('4 of 5');
    expect(screen.getByTestId('home-setup-emergency-done', { includeHiddenElements: true })).toBeOnTheScreen();
    expect(screen.queryByTestId('home-setup-places-done', { includeHiddenElements: true })).toBeNull();
    expect(screen.getByLabelText('Emergency contacts, done. People to call from a drive')).toBeOnTheScreen();
  });

  it('counts DashPal only once one is paired, and never with no runtime', async () => {
    mockDashcam = { loaded: true, link: { paired: null } };
    const w = await appWorld();
    await w.render(<HomeSetupGoals hidden={false} />);
    await screen.findByTestId('home-setup');
    expect(screen.queryByTestId('home-setup-dashpal-done', { includeHiddenElements: true })).toBeNull();
    expect(screen.queryByTestId('home-setup-dashpal')).toBeOnTheScreen();
  });

  it('leaves the First friend tile out when friends cannot be read (offline or an error)', async () => {
    mockFriends = { status: 'error', fetchStatus: 'idle' };
    const w = await appWorld();
    await w.render(<HomeSetupGoals hidden={false} />);
    await screen.findByTestId('home-setup');
    expect(tileIds()).toEqual(['home-setup-emergency', 'home-setup-places', 'home-setup-dashpal']);
    expect(screen.getByTestId('home-setup-count')).toHaveTextContent('0 of 3');
  });

  it('each tile opens its screen', async () => {
    mockCarView = READY([]);
    const w = await appWorld();
    await w.render(<HomeSetupGoals hidden={false} />);
    for (const id of ['emergency', 'places', 'car', 'dashpal', 'friend']) await tap(`home-setup-${id}`);
    expect(mockPush.mock.calls.map((c) => c[0])).toEqual(['/settings/emergency', '/settings/places', '/settings/car', '/settings/dashcam', '/(app)/friends/add']);
  });
});

describe('when the row is gone', () => {
  it('once every goal is done', async () => {
    mockDashcam = PAIRED_DASHPAL;
    mockFriends = friendsList([{ username: 'pal' }]);
    const w = await appWorld({ settings: { [EMERGENCY_CONTACTS_KEY]: [MOM], [PLACES_KEY]: [HOME] } });
    await w.render(<HomeSetupGoals hidden={false} />);
    await waitFor(async () => expect(await w.settings.get(PLACES_KEY)).not.toBeNull());
    expect(screen.queryByTestId('home-setup')).toBeNull();
  });

  it('until friends, DashPal and the car link are read, so a finished driver never sees it flash in', async () => {
    const w = await appWorld();
    await w.render(<Redrawn />);
    await screen.findByTestId('home-setup');
    for (const [friends, dashcam, car] of [
      [{ status: 'pending', fetchStatus: 'fetching' }, null, { status: 'unsupported' }],
      [friendsList([]), { loaded: false, link: { paired: null } }, { status: 'unsupported' }],
      [friendsList([]), null, { status: 'loading' }],
    ] as const) {
      mockFriends = friends as typeof mockFriends;
      mockDashcam = dashcam;
      mockCarView = car;
      await act(async () => redraw());
      expect(screen.queryByTestId('home-setup')).toBeNull();
    }
    mockCarView = { status: 'unsupported' };
    await act(async () => redraw());
    expect(screen.getByTestId('home-setup')).toBeOnTheScreen();
  });

  it('for good after its ✕, until a sign-out', async () => {
    const w = await appWorld();
    await w.render(<HomeSetupGoals hidden={false} />);
    await tap('home-setup-dismiss');
    expect(screen.queryByTestId('home-setup')).toBeNull();
    await waitFor(async () => expect(await w.settings.get(SETUP_GOALS_DISMISSED_KEY)).toBe(true));
    expect(SIGN_OUT_SETTINGS).toContain(SETUP_GOALS_DISMISSED_KEY);
  });

  it('stays closed when it was closed before', async () => {
    const w = await appWorld({ settings: { [SETUP_GOALS_DISMISSED_KEY]: true } });
    await w.render(<HomeSetupGoals hidden={false} />);
    await waitFor(async () => expect(await w.settings.get(SETUP_GOALS_DISMISSED_KEY)).toBe(true));
    expect(screen.queryByTestId('home-setup')).toBeNull();
  });

  it('during a drive', async () => {
    const w = await appWorld();
    await w.render(<HomeSetupGoals hidden />);
    await waitFor(async () => expect(await w.settings.get(SETUP_GOALS_DISMISSED_KEY)).toBeNull());
    expect(screen.queryByTestId('home-setup')).toBeNull();
  });

  it('copy has no dashes, exclamation marks or game words', () => {
    const words = JSON.stringify(homeCopy.setup, (_k, v: unknown) => (typeof v === 'function' ? (v as (...a: unknown[]) => string)(2, 5) : v));
    expect(words).not.toMatch(/[–—!]|\bpoints?\b|\bpts\b|streak|freeze|\blevel\b|leaderboard/i);
  });
});

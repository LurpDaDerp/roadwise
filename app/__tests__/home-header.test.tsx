/**
 * Task 18: Home's header carries the inbox bell (B3). The bell's own count and labels are
 * `InboxBell.test.tsx`'s subject; here it is only placed, above the scrolling record, and opens
 * the inbox.
 */
import { fireEvent, screen, within } from '@testing-library/react-native';
import { AccessibilityInfo } from 'react-native';

import { DriveContext } from '@/drive/DriveProvider';
import type { DriveHost, DriveState } from '@/drive/host';
import { createDriveStore } from '@/drive/store';
import { SessionProvider } from '@/data/supabase/session';
import { clearQueryClients, routerDouble, world } from '@/features/trips/__fixtures__/render';

import Home from '../(tabs)/home';

const mockRouter = routerDouble();
jest.mock('expo-router', () => {
  const { useEffect } = jest.requireActual<typeof import('react')>('react');
  return {
    useRouter: () => mockRouter,
    useFocusEffect: (effect: () => void | (() => void)) => useEffect(effect, [effect]),
  };
});
jest.mock('@/data/supabase/client', () => ({
  supabase: {
    auth: {
      getSession: jest.fn(async () => ({ data: { session: { user: { id: 'u1' } } } })),
      onAuthStateChange: jest.fn(() => ({ data: { subscription: { unsubscribe: jest.fn() } } })),
      signOut: jest.fn(async () => ({ error: null })),
    },
  },
}));
jest.mock('@/lib/env', () => ({ env: { diagnostics: false } }));
jest.mock('@/data/supabase/profile', () => ({
  fetchProfile: jest.fn(async () => ({ id: 'u1', display_name: 'Maya Chen' })),
}));
// The inbox as the server would answer it with nothing in it.
jest.mock('@/features/inbox/api', () => ({
  ...jest.requireActual('@/features/inbox/api'),
  defaultInboxApi: {
    fetchInbox: jest.fn(async () => []),
    markInboxRead: jest.fn(async () => {}),
    dismissInbox: jest.fn(async () => {}),
  },
}));

function fakeHost() {
  const state = { status: 'off', lockedOut: false, role: 'driver', mode: 'mounted', stationarySinceTs: null } as DriveState;
  return {
    snapshot: () => state,
    subscribe: () => () => {},
    autoDetectEnabled: () => false,
  } as unknown as DriveHost;
}

async function renderHome() {
  const w = await world();
  const host = fakeHost();
  const store = createDriveStore(host, { currentState: 'active', addEventListener: () => ({ remove() {} }) });
  await w.renderScreen(
    <SessionProvider>
      <DriveContext.Provider value={{ host, store }}>
        <Home />
      </DriveContext.Provider>
    </SessionProvider>
  );
  await screen.findByRole('header', { name: 'Maya Chen' });
}

beforeEach(() => {
  mockRouter.push.mockClear();
  jest.spyOn(AccessibilityInfo, 'isReduceMotionEnabled').mockResolvedValue(true);
});

afterEach(() => {
  clearQueryClients();
  jest.restoreAllMocks();
});

test('the inbox bell sits in the header, outside the scrolling record, and opens the inbox', async () => {
  await renderHome();
  const header = screen.getByTestId('home-header');
  const bell = within(header).getByRole('button', { name: 'Inbox' });
  expect(within(screen.getByTestId('home')).queryByTestId('inbox-bell')).toBeNull();
  await fireEvent.press(bell);
  expect(mockRouter.push).toHaveBeenCalledWith('/inbox');
});

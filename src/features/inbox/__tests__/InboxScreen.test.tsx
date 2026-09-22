import { act, fireEvent, screen, waitFor } from '@testing-library/react-native';
import type { ReactNode } from 'react';

import { MILE_M, T0, tripRow } from '@/data/queries/__fixtures__/rows';
import { createInboxCache } from '@/features/inbox/cache';
import { inboxCopy } from '@/features/inbox/copy';
import { InboxScreen, NOTIFICATION_SETTINGS_HREF } from '@/features/inbox/InboxScreen';
import { routerDouble } from '@/features/trips/__fixtures__/render';
import { TRIP_HISTORY_HREF, tripSummaryHref } from '@/features/trips/routes';

import { clearInboxClients, fakeApi, inboxWorld, setOnline } from '../__fixtures__/harness';
import { inboxRow, iso, lapseRow, nextId } from '../__fixtures__/rows';

jest.mock('@/data/supabase/client', () => ({ supabase: {} }));
const mockRouter = routerDouble();
jest.mock('expo-router', () => ({ useRouter: () => mockRouter }));
jest.mock('@/data/supabase/session', () => ({ useSession: () => ({ session: { user: { id: 'u1' } } }) }));
jest.mock('react-native-gesture-handler/ReanimatedSwipeable', () => {
  const { View } = jest.requireActual<typeof import('react-native')>('react-native');
  return {
    __esModule: true,
    // Renders its row and hands the swipe callback to the test as a prop on a View.
    default: ({ children, ...rest }: { children: ReactNode }) => <View {...rest}>{children}</View>,
  };
});

const press = (el: Parameters<typeof fireEvent.press>[0]) =>
  act(async () => {
    fireEvent.press(el);
  });

afterEach(() => {
  clearInboxClients();
  setOnline(null);
  jest.clearAllMocks();
});

const onPhoneRow = () => inboxRow({ id: nextId() }); // trip-1, on the phone below
const elsewhereRow = () =>
  inboxRow({
    id: nextId(),
    created_at: iso(T0 - 60_000),
    payload: { ...inboxRow().payload, clientTripId: 'trip-away', distanceM: 2 * MILE_M },
  });

async function renderInbox(rows = [onPhoneRow()], opts: { trips?: boolean } = {}) {
  const w = await inboxWorld({ trips: opts.trips === false ? [] : [tripRow({ distance_m: 3.2 * MILE_M })] });
  const server = fakeApi(rows);
  await w.render(<InboxScreen deps={{ api: server.api }} tz="UTC" />);
  return { ...w, ...server };
}

describe('InboxScreen', () => {
  it('shows a skeleton, then each row rendered from the drive’s current state', async () => {
    const w = await inboxWorld({ trips: [tripRow({ distance_m: 3.2 * MILE_M })] });
    const server = fakeApi([onPhoneRow()]);
    // Hold the server's answer so the loading state is observable on any machine.
    let release: () => void = () => undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const fetch = server.api.fetchInbox;
    server.api.fetchInbox = async (limit) => {
      await gate;
      return fetch(limit);
    };
    await w.render(<InboxScreen deps={{ api: server.api }} tz="UTC" />);
    expect(screen.getByTestId('inbox-loading')).toBeTruthy();
    await act(async () => release());
    expect(await screen.findByText('Drive summary ready')).toBeTruthy();
    expect(screen.getByText('Your 3.2 mi drive is ready. Tap to see how it went.')).toBeTruthy();
  });

  it('opening a row marks it read and goes to the drive', async () => {
    const row = onPhoneRow();
    const { api } = await renderInbox([row]);
    await press(await screen.findByTestId(`inbox-row-${row.id}`));
    expect(mockRouter.push).toHaveBeenCalledWith(tripSummaryHref('trip-1'));
    await waitFor(() => expect(api.markInboxRead).toHaveBeenCalledWith([row.id]));
    await waitFor(() => expect(screen.queryByTestId(`inbox-unread-${row.id}`)).toBeNull());
  });

  it('a drive not on this phone says so and opens nothing', async () => {
    const row = elsewhereRow();
    const ctx = await renderInbox([row]);
    expect(await screen.findByText(`· ${inboxCopy.notOnPhone}`)).toBeTruthy();
    const { api } = ctx;
    await press(screen.getByTestId(`inbox-row-${row.id}`));
    await waitFor(() => expect(api.markInboxRead).toHaveBeenCalledWith([row.id]));
    expect(mockRouter.push).not.toHaveBeenCalled();
  });

  it('a permission lapse opens B2', async () => {
    const row = lapseRow({ id: nextId() });
    const { api } = await renderInbox([row]);
    await press(await screen.findByTestId(`inbox-row-${row.id}`));
    expect(mockRouter.push).toHaveBeenCalledWith('/permissions');
    await waitFor(() => expect(api.markInboxRead).toHaveBeenCalledWith([row.id]));
  });

  describe('dismissing', () => {
    it('with the visible control', async () => {
      const row = onPhoneRow();
      const { api } = await renderInbox([row, elsewhereRow()]);
      await press(await screen.findByTestId(`inbox-dismiss-${row.id}`));
      await waitFor(() => expect(screen.queryByTestId(`inbox-row-${row.id}`)).toBeNull());
      await waitFor(() => expect(api.dismissInbox).toHaveBeenCalledWith([row.id]));
    });

    it('with the screen reader’s Dismiss action', async () => {
      const row = onPhoneRow();
      const { api } = await renderInbox([row, elsewhereRow()]);
      const el = await screen.findByTestId(`inbox-row-${row.id}`);
      expect(el.props.accessibilityActions).toEqual(
        expect.arrayContaining([{ name: 'dismiss', label: inboxCopy.dismiss }])
      );
      await act(async () => {
        fireEvent(el, 'accessibilityAction', { nativeEvent: { actionName: 'dismiss' } });
      });
      await waitFor(() => expect(screen.queryByTestId(`inbox-row-${row.id}`)).toBeNull());
      await waitFor(() => expect(api.dismissInbox).toHaveBeenCalledWith([row.id]));
    });

    it('with a swipe', async () => {
      const row = onPhoneRow();
      const { api } = await renderInbox([row, elsewhereRow()]);
      const swipe = await screen.findByTestId(`inbox-swipe-${row.id}`);
      await act(async () => {
        fireEvent(swipe, 'swipeableOpen', 'left');
      });
      await waitFor(() => expect(screen.queryByTestId(`inbox-row-${row.id}`)).toBeNull());
      await waitFor(() => expect(api.dismissInbox).toHaveBeenCalledWith([row.id]));
    });

    it('offline: the row goes now and the dismissal waits for the server', async () => {
      const row = onPhoneRow();
      const w = await inboxWorld({ trips: [tripRow()], cached: [row, elsewhereRow()] });
      setOnline(false);
      const { api } = fakeApi([]);
      await w.render(<InboxScreen deps={{ api }} tz="UTC" />);
      await press(await screen.findByTestId(`inbox-dismiss-${row.id}`));
      await waitFor(() => expect(screen.queryByTestId(`inbox-row-${row.id}`)).toBeNull());
      expect(api.dismissInbox).not.toHaveBeenCalled();
      expect(await createInboxCache(w.db).readPending('dismiss')).toEqual([row.id]);
    });
  });

  it('the header opens notification settings and marks everything read', async () => {
    const a = onPhoneRow();
    const b = elsewhereRow();
    const { api } = await renderInbox([a, b]);
    await press(await screen.findByTestId('inbox-mark-all'));
    await waitFor(() => expect(api.markInboxRead).toHaveBeenCalledWith([a.id, b.id]));
    await waitFor(() => expect(screen.queryByTestId('inbox-mark-all')).toBeNull());
    await press(screen.getByLabelText(inboxCopy.settings));
    expect(mockRouter.push).toHaveBeenCalledWith(NOTIFICATION_SETTINGS_HREF);
  });

  it('empty: "Nothing new — drive safe" with one action', async () => {
    await renderInbox([]);
    expect(await screen.findByText(inboxCopy.empty.title)).toBeTruthy();
    const actions = screen.getAllByRole('button').filter((b) => b.props.accessibilityLabel === inboxCopy.empty.action);
    expect(actions).toHaveLength(1);
    await press(actions[0]!);
    expect(mockRouter.push).toHaveBeenCalledWith(TRIP_HISTORY_HREF);
  });

  it('offline: the saved rows with a banner that says so, and no request', async () => {
    const w = await inboxWorld({ trips: [tripRow()], cached: [onPhoneRow()] });
    setOnline(false);
    const { api } = fakeApi([]);
    await w.render(<InboxScreen deps={{ api }} tz="UTC" />);
    expect(await screen.findByText(inboxCopy.offline)).toBeTruthy();
    expect(screen.getByText('Drive summary ready')).toBeTruthy();
    expect(api.fetchInbox).not.toHaveBeenCalled();
  });

  it('a server error shows inline with a retry that works', async () => {
    const row = onPhoneRow();
    const w = await inboxWorld({ trips: [tripRow()] });
    const server = fakeApi([row]);
    server.fail.fetch = Object.assign(new Error('boom'), { code: 'PGRST000' });
    await w.render(<InboxScreen deps={{ api: server.api }} tz="UTC" />);
    expect(await screen.findByText(inboxCopy.error)).toBeTruthy();
    server.fail.fetch = undefined;
    await press(screen.getByLabelText(inboxCopy.retry));
    expect(await screen.findByText('Drive summary ready')).toBeTruthy();
    expect(screen.queryByText(inboxCopy.error)).toBeNull();
  });

  it('dismissed rows and rows this build cannot render are not listed', async () => {
    const shown = onPhoneRow();
    await renderInbox([
      shown,
      inboxRow({ id: nextId(), dismissed_at: iso(T0) }),
      inboxRow({ id: nextId(), type: 'streak_milestone' }),
    ]);
    await screen.findByTestId(`inbox-row-${shown.id}`);
    expect(screen.getAllByText(/Tap to see how it went|Tell us who drove/)).toHaveLength(1);
  });
});

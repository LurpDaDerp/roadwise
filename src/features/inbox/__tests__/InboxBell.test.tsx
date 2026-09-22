import { act, fireEvent, screen } from '@testing-library/react-native';

import { T0 } from '@/data/queries/__fixtures__/rows';
import { INBOX_HREF, InboxBell } from '@/features/inbox/InboxBell';
import { routerDouble } from '@/features/trips/__fixtures__/render';

import { clearInboxClients, fakeApi, inboxWorld, settleInbox } from '../__fixtures__/harness';
import { inboxRow, iso, lapseRow, nextId } from '../__fixtures__/rows';

jest.mock('@/data/supabase/client', () => ({ supabase: {} }));
const mockRouter = routerDouble();
jest.mock('expo-router', () => ({ useRouter: () => mockRouter }));
jest.mock('@/data/supabase/session', () => ({ useSession: () => ({ session: { user: { id: 'u1' } } }) }));

afterEach(async () => {
  await clearInboxClients();
  jest.clearAllMocks();
});

async function renderBell(rows: ReturnType<typeof inboxRow>[]) {
  const w = await inboxWorld();
  const { api } = fakeApi(rows);
  await w.render(<InboxBell deps={{ api }} />);
  return api;
}

describe('InboxBell', () => {
  it('says the unread count in words and prints it — "Inbox, 2 unread"', async () => {
    await renderBell([inboxRow({ id: nextId() }), lapseRow({ id: nextId() })]);
    expect(await screen.findByLabelText('Inbox, 2 unread')).toBeTruthy();
    expect(screen.getByTestId('inbox-bell-badge')).toBeTruthy();
    expect(screen.getByText('2')).toBeTruthy();
  });

  it('counts only rows the list would show unread: not read, not dismissed, renderable', async () => {
    await renderBell([
      inboxRow({ id: nextId() }),
      inboxRow({ id: nextId(), read_at: iso(T0) }),
      inboxRow({ id: nextId(), dismissed_at: iso(T0) }),
      inboxRow({ id: nextId(), type: 'streak_milestone' }),
      inboxRow({ id: nextId(), payload: { clientTripId: 'x' } }),
    ]);
    expect(await screen.findByLabelText('Inbox, 1 unread')).toBeTruthy();
  });

  it('with nothing unread it is just "Inbox", with no badge', async () => {
    const api = await renderBell([inboxRow({ id: nextId(), read_at: iso(T0) })]);
    // "Inbox" is also the label before the fetch lands: wait for it to land.
    await settleInbox();
    expect(api.fetchInbox).toHaveBeenCalled();
    expect(screen.getByLabelText('Inbox')).toBeTruthy();
    expect(screen.queryByTestId('inbox-bell-badge')).toBeNull();
  });

  it('prints 9+ past nine, and the label keeps the exact number', async () => {
    await renderBell(Array.from({ length: 12 }, () => inboxRow({ id: nextId() })));
    expect(await screen.findByLabelText('Inbox, 12 unread')).toBeTruthy();
    expect(screen.getByText('9+')).toBeTruthy();
  });

  it('opens the inbox', async () => {
    await renderBell([]);
    await settleInbox();
    await act(async () => {
      fireEvent.press(screen.getByTestId('inbox-bell'));
    });
    expect(mockRouter.push).toHaveBeenCalledWith(INBOX_HREF);
  });
});

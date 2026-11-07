/**
 * Home's Wrapped card: last month's Wrapped from the 1st through the 7th (local), once the driver
 * has one, until its ✕ closes it for that month; never during a drive.
 */
import { act, fireEvent, screen, waitFor } from '@testing-library/react-native';

import { SIGN_OUT_SETTINGS } from '@/boot/device';
import { answerRpc, appWorld, clearQueryClients, tap } from '@/features/permissions/__fixtures__/harness';

import { archiveEntry } from '../__fixtures__/wrapped';
import { HomeWrappedCard } from '../HomeWrappedCard';
import { WRAPPED_CARD_DISMISSED_KEY } from '../month';

const mockRpc = jest.fn();
jest.mock('@/data/server/rpc', () => {
  const actual = jest.requireActual('@/data/server/rpc');
  return { ...actual, callRpc: (fn: string, args?: unknown) => mockRpc(fn, args) };
});
jest.mock('@/data/supabase/client', () => ({ supabase: {} }));
jest.mock('@/data/supabase/session', () => ({ useSession: () => ({ session: { user: { id: 'me' } } }) }));
const mockRouter = { push: jest.fn() };
jest.mock('expo-router', () => {
  const { useEffect } = jest.requireActual<typeof import('react')>('react');
  return { useRouter: () => mockRouter, useFocusEffect: (effect: () => void | (() => void)) => useEffect(effect, [effect]) };
});
jest.mock('@/lib/deviceZone', () => ({ deviceZone: () => 'America/New_York' }));

/** Noon in New York on a day of November 2026 (EST from the 2nd). */
const nov = (day: number) => Date.UTC(2026, 10, day, day === 1 ? 16 : 17);

const ARCHIVE = [archiveEntry({ month: '2026-10' }), archiveEntry({ month: '2026-09' })];

beforeEach(() => {
  mockRpc.mockReset();
  mockRouter.push.mockClear();
  answerRpc(mockRpc, { list_my_wrapped: ARCHIVE });
});
afterEach(() => {
  clearQueryClients();
  jest.restoreAllMocks();
});

const at = (ms: number) => jest.spyOn(Date, 'now').mockReturnValue(ms);

it("on the 1st: last month's Wrapped, in its colours, opening its story", async () => {
  at(nov(1));
  const w = await appWorld();
  await w.render(<HomeWrappedCard hidden={false} />);
  expect(await screen.findByTestId('home-wrapped')).toBeOnTheScreen();
  expect(screen.getByText('Your October Wrapped')).toBeOnTheScreen();
  expect(screen.getByText('See your month on the road.')).toBeOnTheScreen();
  expect(screen.getByTestId('home-wrapped-icon', { includeHiddenElements: true })).toBeTruthy();
  await tap('home-wrapped');
  expect(mockRouter.push).toHaveBeenCalledWith('/wrapped/2026-10');
});

it('through the 7th', async () => {
  at(nov(7));
  const w = await appWorld();
  await w.render(<HomeWrappedCard hidden={false} />);
  expect(await screen.findByTestId('home-wrapped')).toBeOnTheScreen();
});

it('from the 8th nothing, and the archive is never asked for', async () => {
  at(nov(8));
  const w = await appWorld();
  await w.render(<HomeWrappedCard hidden={false} />);
  await waitFor(() => expect(screen.queryByTestId('home-wrapped')).toBeNull());
  expect(mockRpc).not.toHaveBeenCalled();
});

it('no Wrapped for last month (under 3 scored drives): no card', async () => {
  at(nov(2));
  answerRpc(mockRpc, { list_my_wrapped: [archiveEntry({ month: '2026-09' })] });
  const w = await appWorld();
  await w.render(<HomeWrappedCard hidden={false} />);
  await waitFor(() => expect(mockRpc).toHaveBeenCalledWith('list_my_wrapped', undefined));
  expect(screen.queryByTestId('home-wrapped')).toBeNull();
});

it('never during a drive', async () => {
  at(nov(2));
  const w = await appWorld();
  await w.render(<HomeWrappedCard hidden />);
  await waitFor(() => expect(screen.queryByTestId('home-wrapped')).toBeNull());
  expect(mockRpc).not.toHaveBeenCalled();
});

it('✕ closes it for that month (kept on the phone, wiped at sign-out); next month brings it back', async () => {
  at(nov(2));
  const w = await appWorld();
  const r = await w.render(<HomeWrappedCard hidden={false} />);
  await tap('home-wrapped-dismiss');
  expect(screen.queryByTestId('home-wrapped')).toBeNull();
  expect(await w.settings.get(WRAPPED_CARD_DISMISSED_KEY)).toBe('2026-10');
  expect(SIGN_OUT_SETTINGS).toContain(WRAPPED_CARD_DISMISSED_KEY);
  await r.unmount();

  // Closed earlier: no flash of it on the next visit, and the archive is not asked for again.
  clearQueryClients();
  mockRpc.mockClear();
  const w2 = await appWorld({ settings: { [WRAPPED_CARD_DISMISSED_KEY]: '2026-10' } });
  const r2 = await w2.render(<HomeWrappedCard hidden={false} />);
  await act(async () => {});
  expect(screen.queryByTestId('home-wrapped')).toBeNull();
  expect(mockRpc).not.toHaveBeenCalled();
  await r2.unmount();

  // December 1st: November's card, even with October's closed.
  clearQueryClients();
  at(Date.UTC(2026, 11, 1, 17));
  answerRpc(mockRpc, { list_my_wrapped: [archiveEntry({ month: '2026-11' }), ...ARCHIVE] });
  const w3 = await appWorld({ settings: { [WRAPPED_CARD_DISMISSED_KEY]: '2026-10' } });
  await w3.render(<HomeWrappedCard hidden={false} />);
  expect(await screen.findByText('Your November Wrapped')).toBeOnTheScreen();
});

it('with VoiceOver: the card is one button whose actions open it and close it (the ✕ inside cannot be reached)', async () => {
  at(nov(2));
  const w = await appWorld();
  await w.render(<HomeWrappedCard hidden={false} />);
  const card = await screen.findByTestId('home-wrapped');
  expect(card.props.accessibilityActions).toEqual([{ name: 'activate' }, { name: 'dismiss', label: 'Close' }]);
  await act(async () => fireEvent(card, 'accessibilityAction', { nativeEvent: { actionName: 'activate' } }));
  expect(mockRouter.push).toHaveBeenCalledWith('/wrapped/2026-10');
  await act(async () => fireEvent(card, 'accessibilityAction', { nativeEvent: { actionName: 'dismiss' } }));
  expect(screen.queryByTestId('home-wrapped')).toBeNull();
  await waitFor(async () => expect(await w.settings.get(WRAPPED_CARD_DISMISSED_KEY)).toBe('2026-10'));
});

/**
 * The Wrapped screens: the own story from `get_my_wrapped` plus this phone's Places, a shared copy
 * from `get_shared_wrapped`, sharing the summary card (`create_wrapped_share` at share time), and
 * the archive.
 */
import { act, fireEvent, screen, within } from '@testing-library/react-native';
import { Dimensions, PixelRatio, Share } from 'react-native';

import { RpcError } from '@/data/server/rpc';
import { drive } from '@/features/drives/__fixtures__/drives';
import { answerRpc, appWorld, clearQueryClients, tap } from '@/features/permissions/__fixtures__/harness';

import { archiveEntry, myWrapped, sharedWrapped } from '../__fixtures__/wrapped';
import { SharedWrappedScreen, WrappedArchiveScreen, WrappedMonthScreen } from '../WrappedScreens';

const mockRpc = jest.fn();
jest.mock('@/data/server/rpc', () => {
  const actual = jest.requireActual('@/data/server/rpc');
  return { ...actual, callRpc: (fn: string, args?: unknown) => mockRpc(fn, args) };
});
jest.mock('@/data/supabase/client', () => ({ supabase: {} }));
jest.mock('@/data/supabase/session', () => ({ useSession: () => ({ session: { user: { id: 'me' } } }) }));
const mockRouter = { push: jest.fn(), back: jest.fn(), replace: jest.fn(), canGoBack: () => true };
jest.mock('expo-router', () => {
  const { useEffect } = jest.requireActual<typeof import('react')>('react');
  return { useRouter: () => mockRouter, useFocusEffect: (effect: () => void | (() => void)) => useEffect(effect, [effect]) };
});
jest.mock('react-native-view-shot', () => ({ captureRef: jest.fn(async () => 'file:///wrapped.png') }));
// This phone's scored drives (the Places slide).
let mockDrives: ReturnType<typeof drive>[] = [];
jest.mock('@/data/queries/analytics', () => ({
  ...jest.requireActual('@/data/queries/analytics'),
  useScoredDrives: () => ({ data: mockDrives, isPending: false }),
}));
// The link domain: none set.
jest.mock('@/lib/linkDomain', () => ({ linkDomain: () => null }));

const NY = 'America/New_York';
const oct = (day: number, from: string, to: string) =>
  drive({ clientTripId: `d${day}${from}`, startedAt: Date.UTC(2026, 9, day, 16), tz: NY, fromLabel: from, toLabel: to, fromPlace: null, toPlace: null });

const WIDTH = Dimensions.get('window').width;
/** Tap the right half of the slide: the next slide. */
async function next(times = 1) {
  for (let i = 0; i < times; i++) {
    await act(async () => {
      fireEvent.press(screen.getByTestId('wrapped-story-slide'), { nativeEvent: { pageX: WIDTH - 10, pageY: 300 } });
    });
  }
}
const showing = () => (screen.getByTestId(/^wrapped-slide-/).props.testID as string).replace('wrapped-slide-', '');

let shareSpy: jest.SpyInstance;
beforeEach(() => {
  mockRpc.mockReset();
  mockRouter.push.mockClear();
  mockRouter.back.mockClear();
  mockDrives = [oct(2, 'Home', 'Work'), oct(3, 'Home', 'Work'), oct(4, 'Home', 'Gym')];
  shareSpy = jest.spyOn(Share, 'share').mockImplementation(async () => ({ action: Share.sharedAction }));
});
afterEach(() => {
  clearQueryClients();
  shareSpy.mockRestore();
});

describe('the own story', () => {
  it('walks every slide: totals, safety, smoothness, phone and speed, habits, places, progress, the archetype, then the card', async () => {
    answerRpc(mockRpc, { get_my_wrapped: myWrapped() });
    const w = await appWorld();
    await w.render(<WrappedMonthScreen month="2026-10" />);
    expect(await screen.findByTestId('wrapped-story')).toBeOnTheScreen();
    expect(mockRpc).toHaveBeenCalledWith('get_my_wrapped', { p_month: '2026-10' });
    expect(screen.getByTestId('wrapped-story-header')).toHaveTextContent('Your October');
    expect(screen.getByTestId('wrapped-intro-title')).toHaveTextContent('Your October on the road');
    expect(screen.getByLabelText('Slide 1 of 10')).toBeOnTheScreen();

    await next();
    expect(showing()).toBe('totals');
    expect(screen.getByTestId('wrapped-distance-value')).toHaveTextContent('212 mi');
    expect(screen.getByTestId('wrapped-chip-miles')).toHaveTextContent('More miles than 72% of drivers');
    expect(screen.getByTestId('wrapped-time-value')).toHaveTextContent('7 h 20 min');
    expect(screen.getByTestId('wrapped-drives-value')).toHaveTextContent('14');

    await next();
    expect(showing()).toBe('safety');
    expect(screen.getByTestId('wrapped-avg-score-value')).toHaveTextContent('91');
    expect(screen.getByTestId('wrapped-chip-avgScore')).toHaveTextContent('Better than 64% of drivers');
    expect(screen.getByTestId('wrapped-rating-value')).toHaveTextContent('90');
    expect(screen.getByTestId('wrapped-rating-sub')).toHaveTextContent('Up 6 since October 1');
    expect(screen.getByTestId('wrapped-clean-value')).toHaveTextContent('86%');
    expect(screen.getByTestId('wrapped-clean-sub')).toHaveTextContent('12 of 14 drives');
    expect(screen.getByTestId('wrapped-longest-clean-value')).toHaveTextContent('31.5 mi');

    await next();
    expect(screen.getByTestId('wrapped-hard-value')).toHaveTextContent('1.4 per 100 mi');
    expect(screen.getByTestId('wrapped-best-value')).toHaveTextContent('Phone use · 95');

    await next();
    expect(screen.getByTestId('wrapped-pickups-value')).toHaveTextContent('0.5 per 100 mi');
    // A hidden percentile has no chip.
    expect(screen.queryByTestId('wrapped-chip-pickupsPer100')).toBeNull();
    expect(screen.getByTestId('wrapped-chip-speedingPer100')).toHaveTextContent('Better than 40% of drivers');
    expect(screen.getByText('Speeds are never shown.')).toBeOnTheScreen();

    await next();
    expect(screen.getByTestId('wrapped-day-value')).toHaveTextContent('Tuesday');
    expect(screen.getByTestId('wrapped-band-value')).toHaveTextContent('6–9 AM');
    expect(screen.getByTestId('wrapped-split-value')).toHaveTextContent('11 weekday · 3 weekend');

    await next();
    expect(showing()).toBe('places');
    expect(screen.getByTestId('wrapped-trip-value')).toHaveTextContent('Home → Work');
    expect(screen.getByTestId('wrapped-trip-sub')).toHaveTextContent('2 drives');

    await next();
    expect(screen.getByTestId('wrapped-badges')).toHaveTextContent(/2 badges earned/);
    expect(screen.getByTestId('wrapped-badges')).toHaveTextContent(/Clean 100 · Perfect Week/);
    expect(screen.getByTestId('wrapped-goals')).toHaveTextContent('5 weekly goals done');

    await next();
    expect(screen.getByTestId('wrapped-archetype-name')).toHaveTextContent('Spotless Commuter');
    expect(screen.getByTestId('wrapped-archetype-line')).toHaveTextContent(/^Clean drive after clean drive/);

    await next();
    expect(showing()).toBe('summary');
    const card = within(screen.getByTestId('wrapped-card'));
    expect(card.getByTestId('wrapped-card-month')).toHaveTextContent('October 2026');
    expect(card.getByTestId('wrapped-card-name')).toHaveTextContent('Spotless Commuter');
    expect(card.getByTestId('wrapped-card-miles')).toHaveTextContent(/212 mi/);
    expect(card.getByTestId('wrapped-card-cleanShare-chip')).toHaveTextContent('Better than 81% of drivers');
    expect(card.getByTestId('wrapped-card-hardPer100')).toHaveTextContent(/1\.4.*Hard events per 100 mi/);
    expect(screen.getByTestId('wrapped-share')).toBeOnTheScreen();
  });

  it('skips Places without a trip driven twice, and Progress with no badge and no goal', async () => {
    mockDrives = [oct(2, 'Home', 'Work'), oct(3, 'Home', 'Gym')];
    answerRpc(mockRpc, { get_my_wrapped: myWrapped({ badges: [], goalsCompleted: 0 }) });
    const w = await appWorld();
    await w.render(<WrappedMonthScreen month="2026-10" />);
    expect(await screen.findByLabelText('Slide 1 of 8')).toBeOnTheScreen();
    await next(6);
    expect(showing()).toBe('archetype');
  });

  it('shares the card with a line and the link, made only at share time; a failure says so', async () => {
    answerRpc(mockRpc, { get_my_wrapped: myWrapped(), create_wrapped_share: 'Ab3dEf7hJk9m' });
    const w = await appWorld();
    await w.render(<WrappedMonthScreen month="2026-10" />);
    await screen.findByTestId('wrapped-story');
    await next(9);
    expect(mockRpc.mock.calls.map((c) => c[0])).not.toContain('create_wrapped_share');
    await tap('wrapped-share');
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { captureRef } = require('react-native-view-shot') as { captureRef: jest.Mock };
    // iOS reads the size in points: 1080 × 1920 pixels over the screen's scale.
    const r = PixelRatio.get();
    expect(captureRef).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ format: 'png', width: 1080 / r, height: 1920 / r }));
    expect(mockRpc).toHaveBeenCalledWith('create_wrapped_share', { p_month: '2026-10' });
    expect(shareSpy).toHaveBeenCalledWith({ url: 'file:///wrapped.png', message: 'My October on RoadWise: Spotless Commuter. roadwise://w/Ab3dEf7hJk9m' });
    // Once shared, it can be stopped.
    answerRpc(mockRpc, { get_my_wrapped: myWrapped(), delete_wrapped_share: true });
    await tap('wrapped-stop-sharing');
    expect(mockRpc).toHaveBeenCalledWith('delete_wrapped_share', { p_month: '2026-10' });
    expect(screen.getByTestId('wrapped-share-line')).toHaveTextContent("Sharing stopped. The link doesn't work anymore.");

    answerRpc(mockRpc, { get_my_wrapped: myWrapped(), create_wrapped_share: new RpcError('too many requests', '42501') });
    await tap('wrapped-share');
    expect(screen.getByTestId('wrapped-share-line')).toHaveTextContent("Couldn't share. Try again.");
  });

  it('a month without a Wrapped, or a malformed one, says so', async () => {
    answerRpc(mockRpc, { get_my_wrapped: null });
    const w = await appWorld();
    await w.render(<WrappedMonthScreen month="2026-09" />);
    expect(await screen.findByText('No Wrapped for September')).toBeOnTheScreen();
    expect(screen.getByText('A month needs 3 or more scored drives.')).toBeOnTheScreen();
  });

  it('a malformed month never asks the server', async () => {
    const w = await appWorld();
    await w.render(<WrappedMonthScreen month="2026-13" />);
    expect(await screen.findByText("This Wrapped isn't available")).toBeOnTheScreen();
    expect(mockRpc).not.toHaveBeenCalledWith('get_my_wrapped', expect.anything());
  });

  it('✕ closes the story', async () => {
    answerRpc(mockRpc, { get_my_wrapped: myWrapped() });
    const w = await appWorld();
    await w.render(<WrappedMonthScreen month="2026-10" />);
    await tap('wrapped-story-close');
    expect(mockRouter.back).toHaveBeenCalled();
  });
});

describe('a shared Wrapped', () => {
  it("is the owner's month under their name: no Places, no clock times or splits, the card without Share and the footer", async () => {
    answerRpc(mockRpc, { get_shared_wrapped: sharedWrapped() });
    const w = await appWorld();
    await w.render(<SharedWrappedScreen id="Ab3dEf7hJk9m" />);
    expect(await screen.findByTestId('wrapped-story')).toBeOnTheScreen();
    expect(mockRpc).toHaveBeenCalledWith('get_shared_wrapped', { p_id: 'Ab3dEf7hJk9m' });
    expect(screen.getByTestId('wrapped-story-header')).toHaveTextContent("maya_16's October");
    expect(screen.getByTestId('wrapped-intro-title')).toHaveTextContent('October on the road');
    expect(screen.getByLabelText('Slide 1 of 9')).toBeOnTheScreen();
    await next(5);
    expect(showing()).toBe('habits');
    expect(screen.getByTestId('wrapped-day-value')).toHaveTextContent('Tuesday');
    expect(screen.queryByTestId('wrapped-band')).toBeNull();
    expect(screen.queryByTestId('wrapped-split')).toBeNull();
    await next();
    expect(showing()).toBe('progress');
    expect(screen.getByTestId('wrapped-badges')).toHaveTextContent(/2 badges earned/);
    expect(screen.queryByTestId('wrapped-goals')).toBeNull();
    await next(2);
    expect(showing()).toBe('summary');
    expect(screen.queryByTestId('wrapped-share')).toBeNull();
    expect(screen.queryByTestId('wrapped-stop-sharing')).toBeNull();
    expect(screen.getByTestId('wrapped-footer')).toHaveTextContent('Get your own Wrapped at the start of each month');
  });

  it('a share of your own can be stopped from it', async () => {
    answerRpc(mockRpc, { get_shared_wrapped: sharedWrapped({ mine: true }), delete_wrapped_share: true });
    const w = await appWorld();
    await w.render(<SharedWrappedScreen id="Ab3dEf7hJk9m" />);
    expect(await screen.findByTestId('wrapped-story-header')).toHaveTextContent('Your October');
    // Your own month reads "your" all through, still without Places or clock times.
    expect(screen.getByTestId('wrapped-intro-title')).toHaveTextContent('Your October on the road');
    expect(screen.getByText("Here's how your month went.")).toBeOnTheScreen();
    await next(7);
    expect(showing()).toBe('archetype');
    expect(screen.getByText('Your driving style this month')).toBeOnTheScreen();
    await next();
    expect(showing()).toBe('summary');
    expect(screen.queryByTestId('wrapped-footer')).toBeNull();
    // Once stopped, the link is gone on the server; the story stays up and says so.
    answerRpc(mockRpc, { get_shared_wrapped: null, delete_wrapped_share: true });
    await tap('wrapped-stop-sharing');
    expect(mockRpc).toHaveBeenCalledWith('delete_wrapped_share', { p_month: '2026-10' });
    await act(async () => {});
    expect(screen.getByTestId('wrapped-share-line')).toHaveTextContent("Sharing stopped. The link doesn't work anymore.");
    expect(screen.queryByText("This Wrapped isn't available")).toBeNull();
    expect(screen.queryByTestId('wrapped-stop-sharing')).toBeNull();
  });

  it('not found, blocked or taken down: "This Wrapped isn\'t available"; a malformed id never asks', async () => {
    answerRpc(mockRpc, { get_shared_wrapped: null });
    const w = await appWorld();
    await w.render(<SharedWrappedScreen id="Ab3dEf7hJk9m" />);
    expect(await screen.findByText("This Wrapped isn't available")).toBeOnTheScreen();

    clearQueryClients();
    mockRpc.mockReset();
    const w2 = await appWorld();
    await w2.render(<SharedWrappedScreen id="nope" />);
    expect(await screen.findByText("This Wrapped isn't available")).toBeOnTheScreen();
    expect(mockRpc).not.toHaveBeenCalled();
  });
});

describe('the archive', () => {
  it('lists every past Wrapped, newest first, each opening its story', async () => {
    answerRpc(mockRpc, { list_my_wrapped: [archiveEntry(), archiveEntry({ month: '2026-08', miles: 98, archetype: { style: 'lead_footed', pattern: 'road_tripper' } })] });
    const w = await appWorld();
    await w.render(<WrappedArchiveScreen />);
    expect(await screen.findByLabelText('October 2026, Spotless Commuter')).toBeOnTheScreen();
    expect(screen.getByLabelText('August 2026, Lead-Footed Road Tripper')).toBeOnTheScreen();
    await tap('wrapped-archive-2026-08');
    expect(mockRouter.push).toHaveBeenCalledWith('/wrapped/2026-08');
  });

  it('empty: when the first one arrives', async () => {
    answerRpc(mockRpc, { list_my_wrapped: [] });
    const w = await appWorld();
    await w.render(<WrappedArchiveScreen />);
    expect(await screen.findByText('Your first Wrapped arrives on the 1st after a month with 3 or more scored drives.')).toBeOnTheScreen();
  });
});

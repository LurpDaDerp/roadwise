import { fireEvent, screen, waitFor, within } from '@testing-library/react-native';
import { Share } from 'react-native';

import { profileHref } from '@/features/leagues/routes';

import { answerAlerts, callsTo, renderScreen, resetHarness, respond, router } from '../../leagues/__fixtures__/harness';
import { clanMember, myClan } from '../__fixtures__/data';
import { ClanScreen } from '../ClanScreen';
import { CLAN_CREATE_HREF, CLAN_MANAGE_HREF, clanJoinHref } from '../routes';

jest.mock('@/data/server/rpc', () => jest.requireActual('@/features/leagues/__fixtures__/harness').rpcModule);
jest.mock('@/data/supabase/session', () => jest.requireActual('@/features/leagues/__fixtures__/harness').sessionModule);
jest.mock('expo-router', () => jest.requireActual('@/features/leagues/__fixtures__/harness').routerModule);

afterEach(resetHarness);

const memberOrder = () => screen.getAllByTestId(/^member-/).map((el) => el.props.testID.replace('member-', ''));

test('no clan: create or join with a code', async () => {
  respond({ get_my_clan: null });
  await renderScreen(<ClanScreen />);
  expect(await screen.findByText('Drive better together')).toBeOnTheScreen();
  await fireEvent.press(screen.getByRole('button', { name: 'Create a clan' }));
  expect(router.push).toHaveBeenCalledWith(CLAN_CREATE_HREF);
  await fireEvent.press(screen.getByRole('button', { name: 'Join with a code' }));
  expect(router.push).toHaveBeenCalledWith(clanJoinHref());
});

describe('in a clan as the leader', () => {
  test('banner, weekly goal, invite code and members', async () => {
    respond({ get_my_clan: myClan() });
    await renderScreen(<ClanScreen />);
    expect(await screen.findByText('Night Owls')).toBeOnTheScreen();
    expect(screen.getByText('3 / 30 members')).toBeOnTheScreen();
    expect(screen.getByTestId('clan-goal-text')).toHaveTextContent('31 / 80 clean miles this week');
    expect(screen.getByRole('progressbar', { name: 'Weekly goal' })).toBeOnTheScreen();
    expect(screen.getByTestId('clan-code')).toHaveTextContent('ABCD2345');
    expect(screen.getByLabelText('Invite code A B C D 2 3 4 5')).toBeOnTheScreen();
    expect(memberOrder()).toEqual(['me', 'copilot', 'rookie']);
    expect(screen.getByLabelText(/^Not placed, rookie, Level 4, Safety Rating Unranked$/)).toBeOnTheScreen();
    expect(screen.getByLabelText(/^Number 2, copilot, Co-leader, Level 4, Safety Rating 88$/)).toBeOnTheScreen();
  });

  test('share the invite and make a new code', async () => {
    const share = jest.spyOn(Share, 'share').mockResolvedValue({ action: 'sharedAction' });
    const alerts = answerAlerts();
    respond({ get_my_clan: myClan(), regenerate_clan_code: { invite_code: 'ZZZZ2345' } });
    await renderScreen(<ClanScreen />);
    await fireEvent.press(await screen.findByTestId('clan-share'));
    expect(share).toHaveBeenCalledWith({ message: expect.stringContaining('roadwise://clan/ABCD2345') });
    expect(share.mock.calls[0]?.[0]).toEqual({ message: expect.stringContaining('Night Owls') });

    await fireEvent.press(screen.getByTestId('clan-new-code'));
    await waitFor(() => expect(callsTo('regenerate_clan_code')).toHaveLength(1));
    expect(alerts).toHaveBeenCalledWith('Make a new code?', expect.any(String), expect.any(Array), expect.any(Object));
    // the write refreshes the clan
    await waitFor(() => expect(callsTo('get_my_clan')).toHaveLength(2));
  });

  test('sort chips reorder members on the phone', async () => {
    const c = myClan();
    c.members = [
      clanMember('me', { role: 'leader', points: 100, streak: 1, miles_30d: 5 }),
      clanMember('copilot', { role: 'coleader', points: 900, streak: 12, miles_30d: 50 }),
      clanMember('rookie', { points: 400, streak: 3, miles_30d: 500 }),
    ];
    respond({ get_my_clan: c });
    await renderScreen(<ClanScreen />);
    await screen.findByText('Night Owls');
    await fireEvent.press(screen.getByTestId('sort-points'));
    expect(memberOrder()).toEqual(['copilot', 'rookie', 'me']);
    await fireEvent.press(screen.getByTestId('sort-miles'));
    expect(memberOrder()).toEqual(['rookie', 'copilot', 'me']);
    await fireEvent.press(screen.getByTestId('sort-streak'));
    expect(memberOrder()).toEqual(['copilot', 'rookie', 'me']);
    expect(callsTo('get_my_clan')).toHaveLength(1);
  });

  test('a member row opens their profile; its menu blocks after a confirm', async () => {
    answerAlerts();
    respond({ get_my_clan: myClan(), block_user: null });
    await renderScreen(<ClanScreen />);
    await screen.findByText('Night Owls');
    await fireEvent.press(screen.getByRole('button', { name: /^Number 2, copilot/ }));
    expect(router.push).toHaveBeenCalledWith(profileHref('copilot'));

    await fireEvent.press(screen.getByRole('button', { name: 'More options for copilot' }));
    const menu = within(await screen.findByTestId('target-menu'));
    expect(menu.getByText('View profile')).toBeOnTheScreen();
    await fireEvent.press(menu.getByTestId('menu-block'));
    await waitFor(() => expect(callsTo('block_user')).toEqual([{ p_user_id: 'id-copilot' }]));
    await waitFor(() => expect(screen.queryByTestId('target-menu')).toBeNull());
    expect(callsTo('get_my_clan').length).toBeGreaterThanOrEqual(2);
  });

  test('report from the menu with a reason', async () => {
    const alerts = answerAlerts();
    respond({ get_my_clan: myClan(), report_target: null });
    await renderScreen(<ClanScreen />);
    await screen.findByText('Night Owls');
    await fireEvent.press(screen.getByRole('button', { name: 'More options for rookie' }));
    await fireEvent.press(within(await screen.findByTestId('target-menu')).getByTestId('menu-report'));
    expect(await screen.findByText('Report rookie')).toBeOnTheScreen();
    await fireEvent.press(screen.getByTestId('menu-cheating'));
    await waitFor(() =>
      expect(callsTo('report_target')).toEqual([
        { p_kind: 'user', p_target_id: 'id-rookie', p_reason: 'cheating', p_note: '' },
      ])
    );
    await waitFor(() => expect(alerts).toHaveBeenCalledWith('Thanks. Your report was sent.'));
  });

  test('your own row has no menu', async () => {
    respond({ get_my_clan: myClan() });
    await renderScreen(<ClanScreen />);
    await screen.findByText('Night Owls');
    expect(screen.queryByRole('button', { name: 'More options for me' })).toBeNull();
    expect(screen.getByRole('button', { name: 'More options for copilot' })).toBeOnTheScreen();
  });

  test('Manage opens the manage screen', async () => {
    respond({ get_my_clan: myClan() });
    await renderScreen(<ClanScreen />);
    await screen.findByText('Night Owls');
    await fireEvent.press(screen.getByRole('link', { name: 'Manage' }));
    expect(router.push).toHaveBeenCalledWith(CLAN_MANAGE_HREF);
  });
});

test('in a clan as a member: no invite controls', async () => {
  const c = myClan({ my_role: 'member' });
  c.clan.invite_code = null;
  c.members[0] = { ...c.members[0]!, role: 'member' };
  respond({ get_my_clan: c });
  await renderScreen(<ClanScreen />);
  expect(await screen.findByText('Night Owls')).toBeOnTheScreen();
  expect(screen.queryByTestId('clan-invite')).toBeNull();
  expect(screen.queryByTestId('clan-share')).toBeNull();
});

test('the goal shows when it is reached', async () => {
  respond({ get_my_clan: myClan({ goal: { week: '2026-W41', target_clean_miles: 50, clean_miles: 64 } }) });
  await renderScreen(<ClanScreen />);
  expect(await screen.findByText('Goal reached. Nice driving, crew!')).toBeOnTheScreen();
});

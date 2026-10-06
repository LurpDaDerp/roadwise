import { fireEvent, screen, waitFor, within } from '@testing-library/react-native';

import {
  answerAlerts,
  callsTo,
  renderScreen,
  resetHarness,
  respond,
  router,
  rpcError,
  searchParams,
} from '../../leagues/__fixtures__/harness';
import { myClan } from '../__fixtures__/data';
import { CreateClanScreen } from '../CreateClanScreen';
import { JoinClanScreen } from '../JoinClanScreen';
import { ManageClanScreen } from '../ManageClanScreen';
import { CLAN_TAB_HREF } from '../routes';

jest.mock('@/data/server/rpc', () => jest.requireActual('@/features/leagues/__fixtures__/harness').rpcModule);
jest.mock('@/data/supabase/session', () => jest.requireActual('@/features/leagues/__fixtures__/harness').sessionModule);
jest.mock('expo-router', () => jest.requireActual('@/features/leagues/__fixtures__/harness').routerModule);

afterEach(resetHarness);

describe('create', () => {
  test('live name check, banner pick, create, then the Clan tab', async () => {
    respond({ create_clan: { id: 'c1', name: 'Night Owls', banner: 'sunset', invite_code: 'ABCD2345' } });
    await renderScreen(<CreateClanScreen />);
    const name = screen.getByTestId('clan-name');
    await fireEvent.changeText(name, 'ab');
    await fireEvent(name, 'blur');
    expect(screen.getByTestId('clan-name-error')).toHaveTextContent('Use 3 to 24 characters.');
    expect(screen.getByTestId('clan-create-submit')).toBeDisabled();

    await fireEvent.changeText(name, 'Night  Owls');
    expect(screen.getByTestId('clan-name-error')).toHaveTextContent(/letters, numbers/);

    await fireEvent.changeText(name, 'Night Owls ');
    expect(screen.queryByTestId('clan-name-error')).toBeNull();
    await fireEvent.press(screen.getByRole('radio', { name: 'Sunset' }));
    expect(screen.getByRole('radio', { name: 'Sunset' })).toBeChecked();
    expect(within(screen.getByTestId('create-preview')).getByText('Night Owls')).toBeOnTheScreen();

    await fireEvent.press(screen.getByTestId('clan-create-submit'));
    await waitFor(() => expect(router.replace).toHaveBeenCalledWith(CLAN_TAB_HREF));
    expect(callsTo('create_clan')).toEqual([{ p_name: 'Night Owls', p_banner: 'sunset' }]);
  });

  test("the server's taken and word-filter answers become friendly copy", async () => {
    respond({ create_clan: rpcError('clan name is taken', '23505') });
    await renderScreen(<CreateClanScreen />);
    await fireEvent.changeText(screen.getByTestId('clan-name'), 'Night Owls');
    await fireEvent.press(screen.getByTestId('clan-create-submit'));
    expect(await screen.findByText('That name is taken. Try another one.')).toBeOnTheScreen();
    expect(router.replace).not.toHaveBeenCalled();

    respond({ create_clan: rpcError('name must be 3 to 24 characters', '22023') });
    await fireEvent.changeText(screen.getByTestId('clan-name'), 'Rude Words');
    expect(screen.queryByText('That name is taken. Try another one.')).toBeNull();
    await fireEvent.press(screen.getByTestId('clan-create-submit'));
    expect(await screen.findByText("That name isn't allowed. Try another one.")).toBeOnTheScreen();
  });
});

describe('join', () => {
  test('a link code previews the clan, then joins', async () => {
    searchParams.current = { code: 'abcd2345' };
    respond({
      preview_clan: { name: 'Night Owls', banner: 'ocean', member_count: 12, full: false },
      join_clan: { id: 'c1', name: 'Night Owls' },
    });
    await renderScreen(<JoinClanScreen />);
    expect(await screen.findByText('Night Owls')).toBeOnTheScreen();
    expect(screen.getByText('12 / 30 members')).toBeOnTheScreen();
    expect(callsTo('preview_clan')).toEqual([{ p_code: 'ABCD2345' }]);
    await fireEvent.press(screen.getByTestId('clan-join-submit'));
    await waitFor(() => expect(router.replace).toHaveBeenCalledWith(CLAN_TAB_HREF));
    expect(callsTo('join_clan')).toEqual([{ p_code: 'ABCD2345' }]);
  });

  test('the preview can be reported once the server sends the clan id', async () => {
    searchParams.current = { code: 'ABCD2345' };
    respond({ preview_clan: { id: 'c-owls', name: 'Night Owls', banner: 'ocean', member_count: 12, full: false }, report_target: null });
    await renderScreen(<JoinClanScreen />);
    await fireEvent.press(await screen.findByTestId('clan-preview-report'));
    await fireEvent.press(screen.getByTestId('report-harassment'));
    await waitFor(() => expect(callsTo('report_target')).toEqual([{ p_kind: 'clan', p_target_id: 'c-owls', p_reason: 'harassment', p_note: '' }]));
  });

  test('no clan id from the server: no Report', async () => {
    searchParams.current = { code: 'ABCD2345' };
    respond({ preview_clan: { name: 'Night Owls', banner: 'ocean', member_count: 12, full: false } });
    await renderScreen(<JoinClanScreen />);
    expect(await screen.findByText('Night Owls')).toBeOnTheScreen();
    expect(screen.queryByTestId('clan-preview-report')).toBeNull();
  });

  test('a full clan cannot be joined', async () => {
    searchParams.current = { code: 'ABCD2345' };
    respond({ preview_clan: { name: 'Packed', banner: 'gold', member_count: 30, full: true } });
    await renderScreen(<JoinClanScreen />);
    expect(await screen.findByTestId('clan-full')).toBeOnTheScreen();
    expect(screen.getByTestId('clan-join-submit')).toBeDisabled();
  });

  test('typed codes are checked, unknown ones explained', async () => {
    respond({ preview_clan: rpcError('clan not found', 'P0002') });
    await renderScreen(<JoinClanScreen />);
    await fireEvent.changeText(screen.getByTestId('clan-code-input'), 'abc');
    await fireEvent.press(screen.getByTestId('clan-find'));
    expect(screen.getByTestId('clan-code-input-error')).toHaveTextContent(/8 letters and numbers/);
    expect(callsTo('preview_clan')).toHaveLength(0);

    await fireEvent.changeText(screen.getByTestId('clan-code-input'), 'roadwise://clan/WXYZ2345');
    await fireEvent.press(screen.getByTestId('clan-find'));
    expect(await screen.findByText("We couldn't find a clan with that code. Check it and try again.")).toBeOnTheScreen();
    expect(callsTo('preview_clan')[0]).toEqual({ p_code: 'WXYZ2345' });
  });

  test('a join refused by the server shows why', async () => {
    searchParams.current = { code: 'ABCD2345' };
    respond({
      preview_clan: { name: 'Night Owls', banner: 'ocean', member_count: 12, full: false },
      join_clan: rpcError('you are already in a clan'),
    });
    await renderScreen(<JoinClanScreen />);
    await fireEvent.press(await screen.findByTestId('clan-join-submit'));
    expect(await screen.findByTestId('join-error')).toHaveTextContent(/already in a clan/);
    expect(router.replace).not.toHaveBeenCalled();
  });
});

describe('manage', () => {
  test('leader: change roles, hand over, remove (with confirms)', async () => {
    answerAlerts();
    respond({
      get_my_clan: myClan(),
      set_member_role: null,
      transfer_leadership: null,
      remove_member: null,
    });
    await renderScreen(<ManageClanScreen />);
    await fireEvent.press(await screen.findByTestId('manage-copilot'));
    const sheet = within(await screen.findByTestId('member-actions'));
    expect(sheet.getByText('Make member')).toBeOnTheScreen();
    expect(sheet.getByText('Make leader')).toBeOnTheScreen();
    await fireEvent.press(sheet.getByTestId('action-demote'));
    await waitFor(() => expect(callsTo('set_member_role')).toEqual([{ p_user_id: 'id-copilot', p_role: 'member' }]));
    await waitFor(() => expect(screen.queryByTestId('member-actions')).toBeNull());

    await fireEvent.press(screen.getByTestId('manage-rookie'));
    await fireEvent.press(within(await screen.findByTestId('member-actions')).getByTestId('action-promote'));
    await waitFor(() => expect(callsTo('set_member_role')).toContainEqual({ p_user_id: 'id-rookie', p_role: 'coleader' }));
    await waitFor(() => expect(screen.queryByTestId('member-actions')).toBeNull());

    await fireEvent.press(screen.getByTestId('manage-rookie'));
    await fireEvent.press(within(await screen.findByTestId('member-actions')).getByTestId('action-transfer'));
    await waitFor(() => expect(callsTo('transfer_leadership')).toEqual([{ p_user_id: 'id-rookie' }]));
    await waitFor(() => expect(screen.queryByTestId('member-actions')).toBeNull());

    await fireEvent.press(screen.getByTestId('manage-rookie'));
    await fireEvent.press(within(await screen.findByTestId('member-actions')).getByTestId('action-remove'));
    await waitFor(() => expect(callsTo('remove_member')).toEqual([{ p_user_id: 'id-rookie' }]));
    await waitFor(() => expect(screen.queryByTestId('member-actions')).toBeNull());
  });

  test('a cancelled confirm does nothing', async () => {
    answerAlerts('Cancel');
    respond({ get_my_clan: myClan() });
    await renderScreen(<ManageClanScreen />);
    await fireEvent.press(await screen.findByTestId('manage-rookie'));
    await fireEvent.press(within(await screen.findByTestId('member-actions')).getByTestId('action-remove'));
    expect(callsTo('remove_member')).toHaveLength(0);
  });

  test('co-leader: removes members only, never another co-leader', async () => {
    const c = myClan({ my_role: 'coleader' });
    c.members = [
      { ...c.members[0]!, user_id: 'id-boss', username: 'boss', role: 'leader' },
      { ...c.members[1]!, user_id: 'id-me', username: 'me', role: 'coleader' },
      c.members[2]!,
      { ...c.members[1]!, user_id: 'id-co2', username: 'co2', role: 'coleader' },
    ];
    respond({ get_my_clan: c });
    await renderScreen(<ManageClanScreen />);
    await screen.findByTestId('manage-rookie');
    expect(screen.queryByRole('button', { name: /^co2/ })).toBeNull();
    expect(screen.queryByRole('button', { name: /^boss/ })).toBeNull();
    await fireEvent.press(screen.getByTestId('manage-rookie'));
    const sheet = within(await screen.findByTestId('member-actions'));
    expect(sheet.getByTestId('action-remove')).toBeOnTheScreen();
    expect(sheet.queryByTestId('action-promote')).toBeNull();
    expect(sheet.queryByTestId('action-transfer')).toBeNull();
  });

  test('leader leaving: the confirm names who takes over', async () => {
    const alerts = answerAlerts();
    respond({ get_my_clan: myClan(), leave_clan: null });
    await renderScreen(<ManageClanScreen />);
    await fireEvent.press(await screen.findByTestId('leave-clan'));
    await waitFor(() => expect(router.replace).toHaveBeenCalledWith(CLAN_TAB_HREF));
    expect(alerts).toHaveBeenCalledWith(
      'Leave this clan?',
      "You're the leader. If you leave, copilot becomes the leader automatically.",
      expect.any(Array),
      expect.any(Object)
    );
    expect(callsTo('leave_clan')).toHaveLength(1);
  });

  test('report the clan', async () => {
    answerAlerts();
    respond({ get_my_clan: myClan({ my_role: 'member' }), report_target: null });
    await renderScreen(<ManageClanScreen />);
    await fireEvent.press(await screen.findByTestId('report-clan'));
    await fireEvent.press(await screen.findByTestId('menu-inappropriate_name'));
    await waitFor(() =>
      expect(callsTo('report_target')).toEqual([
        { p_kind: 'clan', p_target_id: 'clan-1', p_reason: 'inappropriate_name', p_note: '' },
      ])
    );
  });

  test('a refused action shows friendly copy', async () => {
    const alerts = answerAlerts();
    respond({ get_my_clan: myClan(), remove_member: rpcError('member not found', 'P0002') });
    await renderScreen(<ManageClanScreen />);
    await fireEvent.press(await screen.findByTestId('manage-rookie'));
    await fireEvent.press(within(await screen.findByTestId('member-actions')).getByTestId('action-remove'));
    await waitFor(() => expect(alerts).toHaveBeenCalledWith("That player isn't in your clan anymore."));
  });
});

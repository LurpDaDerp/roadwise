import { act, fireEvent, screen } from '@testing-library/react-native';
import type { Alert } from 'react-native';

import { clearInboxClients, inboxWorld, settleInbox } from '@/features/inbox/__fixtures__/harness';

import { ManageScreen } from '../ManageScreen';
import { family, fakeFamilyApi, me, member, OTHER, UID } from '../__fixtures__/world';

jest.mock('@/data/supabase/client', () => ({ supabase: {} }));
jest.mock('@/data/supabase/session', () => ({
  useSession: () => ({ session: { user: { id: '00000000-0000-4000-8000-00000000000a' } } }),
}));
const mockRouter = { push: jest.fn(), back: jest.fn(), replace: jest.fn(), canGoBack: jest.fn(() => true) };
jest.mock('expo-router', () => ({
  useRouter: () => mockRouter,
  useFocusEffect: (cb: () => void | (() => void)) => {
    const { useEffect } = jest.requireActual<typeof import('react')>('react');
    // eslint-disable-next-line react-hooks/exhaustive-deps
    useEffect(() => cb(), []);
  },
}));

afterEach(async () => {
  await clearInboxClients();
  jest.clearAllMocks();
});

const alertPressing = (choose: string) =>
  jest.fn((_t: string, _b?: string, buttons?: Parameters<typeof Alert.alert>[2]) => {
    buttons?.find((b) => b.text === choose)?.onPress?.();
  }) as unknown as typeof Alert.alert;

async function renderManage(snapshot = { family: family() }, alert?: typeof Alert.alert) {
  const w = await inboxWorld();
  const server = fakeFamilyApi(snapshot);
  const share = jest.fn(async () => undefined);
  await w.render(<ManageScreen deps={{ api: server.api, share, alert }} />);
  await settleInbox();
  return { ...w, ...server, share };
}

describe('ManageScreen', () => {
  it('the admin sees the code, read one character at a time, and shares it', async () => {
    const { share } = await renderManage();
    expect(screen.getByTestId('family-code')).toHaveTextContent('ABC 234');
    expect(screen.getByTestId('family-code').props.accessibilityLabel).toBe('Join code: A, B, C, 2, 3, 4');
    await act(async () => {
      fireEvent.press(screen.getByTestId('family-share-code'));
    });
    expect(share).toHaveBeenCalledWith({ message: expect.stringContaining('ABC234') });
    expect(share).toHaveBeenCalledWith({ message: expect.stringContaining('It works once, for 48 hours.') });
  });

  it('says the code works once, and that a new one appears after someone joins', async () => {
    await renderManage();
    expect(screen.getByTestId('family-code-hint')).toHaveTextContent(/^Works once, until .+\. After someone joins, a new code appears here\./);
  });

  it('a member sees no code and no Remove', async () => {
    await renderManage({ family: family({ myRole: 'member', code: null, codeExpiresAt: null, members: [me({ role: 'member' }), member({ role: 'admin' })] }) });
    expect(screen.queryByTestId('family-code')).toBeNull();
    expect(screen.queryByTestId(`family-remove-${OTHER}`)).toBeNull();
  });

  it('the admin gets a new code', async () => {
    const { api } = await renderManage();
    await act(async () => {
      fireEvent.press(screen.getByTestId('family-rotate-code'));
    });
    expect(api.rotateCode).toHaveBeenCalled();
  });

  it('removing a member asks first, then removes them', async () => {
    const alert = alertPressing('Remove');
    const { api } = await renderManage({ family: family() }, alert);
    await act(async () => {
      fireEvent.press(screen.getByTestId(`family-remove-${OTHER}`));
    });
    await settleInbox();
    expect(alert).toHaveBeenCalledWith('Remove Sam?', 'They leave the family, and their shared location is deleted.', expect.any(Array));
    expect(api.removeMember).toHaveBeenCalledWith(OTHER);
    expect(screen.queryByTestId(`family-manage-member-${OTHER}`)).toBeNull();
  });

  it('nobody can remove themselves: there is no Remove on your own row', async () => {
    await renderManage();
    expect(screen.queryByTestId(`family-remove-${UID}`)).toBeNull();
  });

  it('leaving asks first, says what it deletes, then goes back to the Family tab', async () => {
    const alert = alertPressing('Leave');
    const { api } = await renderManage({ family: family({ members: [me()] }) }, alert);
    await act(async () => {
      fireEvent.press(screen.getByTestId('family-leave'));
    });
    await settleInbox();
    expect(alert).toHaveBeenCalledWith(
      'Leave this family?',
      'You are the only member, so the family and its places are deleted.',
      expect.any(Array)
    );
    expect(api.leaveFamily).toHaveBeenCalled();
    expect(mockRouter.replace).toHaveBeenCalledWith('/(tabs)/family');
  });
});

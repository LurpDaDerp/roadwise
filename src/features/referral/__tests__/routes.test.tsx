import { render, screen } from '@testing-library/react-native';

import InviteRoute from '../../../../app/(app)/rewards/invite';
import JoinRoute from '../../../../app/join/[code]';

const mockParams = { current: {} as Record<string, unknown> };
jest.mock('expo-router', () => ({ useLocalSearchParams: () => mockParams.current }));
jest.mock('../JoinScreen', () => {
  const { Text: T } = jest.requireActual<typeof import('react-native')>('react-native');
  return { JoinScreen: ({ code }: { code: unknown }) => <T testID="join">{JSON.stringify(code ?? null)}</T> };
});
jest.mock('../InviteScreen', () => {
  const { Text: T } = jest.requireActual<typeof import('react-native')>('react-native');
  return { InviteScreen: () => <T testID="invite">invite</T> };
});


describe('the referral routes', () => {
  test('/join/<code> hands the raw param to the screen, which validates it', async () => {
    mockParams.current = { code: 'ABCD2345' };
    await render(<JoinRoute />);
    expect(screen.getByTestId('join').props.children).toBe('"ABCD2345"');
    mockParams.current = { code: ['A', 'B'] };
    await render(<JoinRoute />);
    expect(screen.getAllByTestId('join').at(-1)?.props.children).toBe('["A","B"]');
  });

  test('/rewards/invite is F10', async () => {
    await render(<InviteRoute />);
    expect(screen.getByTestId('invite')).toBeTruthy();
  });
});

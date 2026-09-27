import { act, fireEvent, screen } from '@testing-library/react-native';

import { clearInboxClients, inboxWorld, settleInbox } from '@/features/inbox/__fixtures__/harness';
import type { FlowContext } from '@/features/onboarding/flow';

import { FamilyStep } from '../FamilyStep';
import { family, fakeFamilyApi } from '../__fixtures__/world';

jest.mock('@/data/supabase/client', () => ({ supabase: {} }));
jest.mock('@/data/supabase/session', () => ({
  useSession: () => ({ session: { user: { id: '00000000-0000-4000-8000-00000000000a' } } }),
}));

afterEach(async () => {
  await clearInboxClients();
  jest.clearAllMocks();
});

const ctx = {} as FlowContext;

async function renderStep(snapshot: Parameters<typeof fakeFamilyApi>[0] = { family: null }) {
  const w = await inboxWorld();
  const server = fakeFamilyApi(snapshot);
  const onNext = jest.fn();
  await w.render(<FamilyStep ctx={ctx} onNext={onNext} deps={{ api: server.api }} />);
  await settleInbox();
  return { ...server, onNext };
}

describe('FamilyStep (A11)', () => {
  it('Not now moves on without asking anything', async () => {
    const { api, onNext } = await renderStep();
    await fireEvent.press(screen.getByTestId('family-step-next'));
    expect(onNext).toHaveBeenCalled();
    expect(api.joinFamily).not.toHaveBeenCalled();
    expect(api.setSharing).not.toHaveBeenCalled();
  });

  it('joining with a code moves on by itself, and turns no sharing on', async () => {
    const { api, onNext } = await renderStep();
    await fireEvent.changeText(screen.getByTestId('family-join-code'), 'ABC234');
    await act(async () => {
      fireEvent.press(screen.getByTestId('family-join'));
    });
    await settleInbox();
    expect(api.joinFamily).toHaveBeenCalledWith('ABC234');
    expect(onNext).toHaveBeenCalled();
    expect(api.setSharing).not.toHaveBeenCalled();
  });

  it('already in a family: says so, and continues', async () => {
    const { onNext } = await renderStep({ family: family() });
    expect(screen.getByTestId('family-step-member')).toHaveTextContent("You're in The Parks.");
    await fireEvent.press(screen.getByTestId('family-step-next'));
    expect(onNext).toHaveBeenCalled();
  });
});

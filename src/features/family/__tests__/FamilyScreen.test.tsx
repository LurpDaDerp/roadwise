import { act, fireEvent, screen } from '@testing-library/react-native';
import type { Alert } from 'react-native';

import { createSettingsRepo } from '@/data/db/settings';
import { clearInboxClients, inboxWorld, settleInbox } from '@/features/inbox/__fixtures__/harness';

import type { FamilySnapshot } from '../api';
import { FamilyScreen } from '../FamilyScreen';
import { FAMILY_SHARING_KEY } from '../location';
import { mapAvailable, resetAreaCache } from '../parts';
import { family, fakeFamilyApi, me, member, NOW, OTHER, place, UID } from '../__fixtures__/world';

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
  resetAreaCache();
  jest.clearAllMocks();
});

/** An Alert that presses the button labelled `choose`. */
const alertPressing = (choose: string) =>
  jest.fn((_t: string, _b?: string, buttons?: Parameters<typeof Alert.alert>[2]) => {
    buttons?.find((b) => b.text === choose)?.onPress?.();
  }) as unknown as typeof Alert.alert;

async function renderFamily(snapshot: FamilySnapshot = { family: family() }, alert?: typeof Alert.alert) {
  const w = await inboxWorld();
  const server = fakeFamilyApi(snapshot);
  const reverseGeocode = jest.fn(async () => [{ district: 'Capitol Hill' }]);
  await w.render(<FamilyScreen deps={{ api: server.api, now: () => NOW, reverseGeocode, alert }} />);
  await settleInbox();
  return { ...w, ...server, reverseGeocode };
}

describe('FamilyScreen', () => {
  it('with no family: what it is for, and join or start one', async () => {
    const { api } = await renderFamily({ family: null });
    expect(screen.getByTestId('family-start')).toBeOnTheScreen();
    expect(screen.getByTestId('family-join')).toBeDisabled();
    await fireEvent.changeText(screen.getByTestId('family-join-code'), 'abc-234');
    await act(async () => {
      fireEvent.press(screen.getByTestId('family-join'));
    });
    await settleInbox();
    expect(api.joinFamily).toHaveBeenCalledWith('abc-234');
    expect(screen.getByText('The Parks')).toBeOnTheScreen();
  });

  it('a refused code is said in words, under the field', async () => {
    const { api } = await renderFamily({ family: null });
    const { FamilyError } = jest.requireActual<typeof import('../api')>('../api');
    api.joinFamily.mockRejectedValueOnce(new FamilyError('invalid_code'));
    await fireEvent.changeText(screen.getByTestId('family-join-code'), 'ABC234');
    await act(async () => {
      fireEvent.press(screen.getByTestId('family-join'));
    });
    await settleInbox();
    expect(screen.getByTestId('family-join-code-error')).toHaveTextContent("That code didn't work. Check it and try again.");
  });

  it('starts a family with a name', async () => {
    const { api } = await renderFamily({ family: null });
    await fireEvent.changeText(screen.getByTestId('family-create-name'), '  Parks  ');
    await act(async () => {
      fireEvent.press(screen.getByTestId('family-create'));
    });
    await settleInbox();
    expect(api.createFamily).toHaveBeenCalledWith('Parks');
  });

  it('each member reads where they are, in words, with how long ago', async () => {
    await renderFamily({
      family: family({
        members: [
          me(),
          member(),
          member({ userId: '00000000-0000-4000-8000-00000000000c', name: 'Jo', sharing: false, location: null }),
        ],
        places: [place({ lat: 47.61, lng: -122.33 })],
      }),
    });
    expect(screen.getByTestId(`family-member-${OTHER}`)).toHaveTextContent(/At Home · 5 min ago/);
    expect(screen.getByTestId('family-member-00000000-0000-4000-8000-00000000000c')).toHaveTextContent(/Location sharing off/);
    expect(screen.getByTestId(`family-member-${UID}`)).toHaveTextContent(/You · Admin/);
  });

  it('away from every place: the coarse area the phone found', async () => {
    const { reverseGeocode } = await renderFamily({ family: family({ members: [me(), member()], places: [] }) });
    expect(reverseGeocode).toHaveBeenCalledWith({ latitude: 47.61, longitude: -122.33 });
    expect(screen.getByTestId(`family-member-${OTHER}`)).toHaveTextContent(/Near Capitol Hill · 5 min ago/);
  });

  it('turning sharing on asks first, then shares and records it on the phone', async () => {
    const alert = alertPressing('Share');
    const { api, db } = await renderFamily({ family: family() }, alert);
    expect(screen.getByTestId('family-sharing').props.value).toBe(false);
    await act(async () => {
      fireEvent(screen.getByTestId('family-sharing'), 'valueChange', true);
    });
    await settleInbox();
    expect(alert).toHaveBeenCalledWith('Share your location?', expect.any(String), expect.any(Array));
    expect(api.setSharing).toHaveBeenCalledWith(true);
    expect(await createSettingsRepo(db).get(FAMILY_SHARING_KEY)).toEqual({ uid: UID, on: true });
    expect(screen.getByTestId('family-sharing-hint')).toHaveTextContent('Your family can see where you are.');
  });

  it('declining the prompt changes nothing', async () => {
    const alert = alertPressing('Not now');
    const { api } = await renderFamily({ family: family() }, alert);
    await act(async () => {
      fireEvent(screen.getByTestId('family-sharing'), 'valueChange', true);
    });
    expect(api.setSharing).not.toHaveBeenCalled();
    expect(screen.getByTestId('family-sharing').props.value).toBe(false);
  });

  it('turning sharing off asks too, and says the last location is deleted', async () => {
    const alert = alertPressing('Stop sharing');
    const { api } = await renderFamily({ family: family({ mySharing: true, members: [me({ sharing: true })] }) }, alert);
    await act(async () => {
      fireEvent(screen.getByTestId('family-sharing'), 'valueChange', false);
    });
    await settleInbox();
    expect(alert).toHaveBeenCalledWith(
      'Stop sharing your location?',
      'Your family will no longer see where you are. Your last shared location is deleted now.',
      expect.any(Array)
    );
    expect(api.setSharing).toHaveBeenCalledWith(false);
  });

  it('places open their editor, and Add opens a new one', async () => {
    await renderFamily({ family: family({ places: [place()] }) });
    await fireEvent.press(screen.getByTestId(`family-place-${place().id}`));
    expect(mockRouter.push).toHaveBeenCalledWith(`/family/place?id=${place().id}`);
    await fireEvent.press(screen.getByTestId('family-add-place'));
    expect(mockRouter.push).toHaveBeenCalledWith('/family/place');
  });

  it('a failed load says so, with a retry', async () => {
    const w = await inboxWorld();
    const server = fakeFamilyApi();
    const { FamilyError } = jest.requireActual<typeof import('../api')>('../api');
    server.api.fetchSnapshot.mockRejectedValue(new FamilyError('offline'));
    await w.render(<FamilyScreen deps={{ api: server.api }} />);
    await settleInbox();
    expect(screen.getByTestId('family-error')).toBeOnTheScreen();
  });
});

describe('mapAvailable', () => {
  it('iOS always; Android only with a Google Maps key', () => {
    expect(mapAvailable('ios', undefined)).toBe(true);
    expect(mapAvailable('android', undefined)).toBe(false);
    expect(mapAvailable('android', ' ')).toBe(false);
    expect(mapAvailable('android', 'AIza-key')).toBe(true);
  });
});

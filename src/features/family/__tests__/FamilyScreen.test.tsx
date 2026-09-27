import { act, fireEvent, screen } from '@testing-library/react-native';
import type { Alert } from 'react-native';

import { DISCLOSURE_AFFIRMED_KEY } from '@/core/permissions/keys';
import { createSettingsRepo } from '@/data/db/settings';
import { DISCLOSURE_FAMILY_TEXT, DISCLOSURE_TEXT } from '@/features/drive/detectionCopy';
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

async function renderFamily(
  snapshot: FamilySnapshot = { family: family() },
  alert?: typeof Alert.alert,
  recordConsent: jest.Mock<Promise<unknown>, any[]> = jest.fn(async () => ({}))
) {
  const w = await inboxWorld();
  const server = fakeFamilyApi(snapshot);
  const reverseGeocode = jest.fn(async () => [{ district: 'Capitol Hill' }]);
  await w.render(<FamilyScreen deps={{ api: server.api, now: () => NOW, reverseGeocode, alert, recordConsent }} />);
  await settleInbox();
  return { ...w, ...server, reverseGeocode, recordConsent };
}

/** This account accepted the pd-1 disclosure (before family sharing existed). */
const PD1 = { version: 'pd-1', at: 1, uid: UID };

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

  it('turning sharing on shows pd-2\'s family words, records pd-2, then shares and records it on the phone', async () => {
    const alert = alertPressing('Share');
    const { api, db, recordConsent } = await renderFamily({ family: family() }, alert);
    await createSettingsRepo(db).set(DISCLOSURE_AFFIRMED_KEY, PD1);
    expect(screen.getByTestId('family-sharing').props.value).toBe(false);
    await act(async () => {
      fireEvent(screen.getByTestId('family-sharing'), 'valueChange', true);
    });
    await settleInbox();
    const body = (alert as unknown as jest.Mock).mock.calls[0][1] as string;
    expect((alert as unknown as jest.Mock).mock.calls[0][0]).toBe('Share your location?');
    expect(body).toContain(DISCLOSURE_FAMILY_TEXT);
    expect(body).toContain('even when the app is closed');
    // pd-1 was accepted: only the new words, not the whole disclosure again
    expect(body).not.toContain(DISCLOSURE_TEXT.heading);
    expect(recordConsent).toHaveBeenCalledWith(UID, { type: 'background_location', version: 'pd-2' });
    expect(recordConsent.mock.invocationCallOrder[0]).toBeLessThan(api.setSharing.mock.invocationCallOrder[0]!);
    expect(api.setSharing).toHaveBeenCalledWith(true);
    expect(await createSettingsRepo(db).get(DISCLOSURE_AFFIRMED_KEY)).toEqual({ version: 'pd-2', at: NOW, uid: UID });
    expect(await createSettingsRepo(db).get(FAMILY_SHARING_KEY)).toEqual({ uid: UID, on: true });
    expect(screen.getByTestId('family-sharing-hint')).toHaveTextContent('Your family can see where you are.');
  });

  it('an account that never saw the disclosure is shown all of pd-2', async () => {
    const alert = alertPressing('Not now');
    await renderFamily({ family: family() }, alert);
    await act(async () => {
      fireEvent(screen.getByTestId('family-sharing'), 'valueChange', true);
    });
    const body = (alert as unknown as jest.Mock).mock.calls[0][1] as string;
    expect(body).toContain(DISCLOSURE_TEXT.heading);
    expect(body).toContain(DISCLOSURE_TEXT.body);
  });

  it('when the consent cannot be recorded, sharing is not turned on', async () => {
    const alert = alertPressing('Share');
    const failing = jest.fn(async (_uid: string, _consent: { type: 'background_location'; version: string }): Promise<unknown> => {
      throw new Error('offline');
    });
    const { api, db } = await renderFamily({ family: family() }, alert, failing);
    await act(async () => {
      fireEvent(screen.getByTestId('family-sharing'), 'valueChange', true);
    });
    await settleInbox();
    expect(api.setSharing).not.toHaveBeenCalled();
    expect(await createSettingsRepo(db).get(DISCLOSURE_AFFIRMED_KEY)).toBeNull();
    expect(screen.getByTestId('family-sharing-error')).toHaveTextContent(/Couldn't save your agreement/);
    expect(screen.getByTestId('family-sharing').props.value).toBe(false);
  });

  it('declining the prompt changes nothing', async () => {
    const alert = alertPressing('Not now');
    const { api, recordConsent } = await renderFamily({ family: family() }, alert);
    await act(async () => {
      fireEvent(screen.getByTestId('family-sharing'), 'valueChange', true);
    });
    expect(recordConsent).not.toHaveBeenCalled();
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

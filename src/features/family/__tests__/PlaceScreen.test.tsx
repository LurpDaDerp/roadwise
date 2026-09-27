import { act, fireEvent, screen } from '@testing-library/react-native';
import type { Alert } from 'react-native';

import { clearInboxClients, inboxWorld, settleInbox } from '@/features/inbox/__fixtures__/harness';

import { PlaceScreen, type Geocode } from '../PlaceScreen';
import { family, fakeFamilyApi, place, PLACE_ID } from '../__fixtures__/world';

jest.mock('@/data/supabase/client', () => ({ supabase: {} }));
jest.mock('@/data/supabase/session', () => ({
  useSession: () => ({ session: { user: { id: '00000000-0000-4000-8000-00000000000a' } } }),
}));
const mockRouter = { push: jest.fn(), back: jest.fn(), replace: jest.fn(), canGoBack: jest.fn(() => true) };
jest.mock('expo-router', () => ({ useRouter: () => mockRouter }));

afterEach(async () => {
  await clearInboxClients();
  jest.clearAllMocks();
});

async function renderPlace(
  id?: string,
  geocode: Geocode = jest.fn(async () => ({ lat: 47.6, lng: -122.3 })),
  alert?: typeof Alert.alert
) {
  const w = await inboxWorld();
  const server = fakeFamilyApi({ family: family({ places: [place()] }) });
  await w.render(<PlaceScreen id={id} deps={{ api: server.api, geocode, alert }} />);
  await settleInbox();
  return { ...w, ...server, geocode };
}

describe('PlaceScreen', () => {
  it('finds the address on the phone, then saves the place with its radius', async () => {
    const { api, geocode } = await renderPlace();
    await fireEvent.changeText(screen.getByTestId('family-place-name'), 'School');
    await fireEvent.changeText(screen.getByTestId('family-place-address'), '1 School Rd, Seattle');
    expect(screen.getByTestId('family-place-save')).toBeDisabled();
    await act(async () => {
      fireEvent.press(screen.getByTestId('family-place-find'));
    });
    expect(geocode).toHaveBeenCalledWith('1 School Rd, Seattle');
    expect(screen.getByTestId('family-place-found')).toHaveTextContent('Found: 47.6000, -122.3000');
    await fireEvent.press(screen.getByTestId('family-place-radius-300'));
    await act(async () => {
      fireEvent.press(screen.getByTestId('family-place-save'));
    });
    await settleInbox();
    expect(api.savePlace).toHaveBeenCalledWith({
      id: undefined,
      name: 'School',
      address: '1 School Rd, Seattle',
      lat: 47.6,
      lng: -122.3,
      radiusM: 300,
    });
    expect(mockRouter.back).toHaveBeenCalled();
  });

  it('an address the phone cannot find says so, and nothing can be saved', async () => {
    await renderPlace(undefined, jest.fn(async () => null));
    await fireEvent.changeText(screen.getByTestId('family-place-name'), 'School');
    await fireEvent.changeText(screen.getByTestId('family-place-address'), 'nowhere');
    await act(async () => {
      fireEvent.press(screen.getByTestId('family-place-find'));
    });
    expect(screen.getByTestId('family-place-error')).toHaveTextContent(/Couldn't find that address. Check it and try again./);
    expect(screen.getByTestId('family-place-save')).toBeDisabled();
  });

  it('edits an existing place, and deletes it after asking', async () => {
    const alert = jest.fn((_t: string, _b?: string, buttons?: Parameters<typeof Alert.alert>[2]) => {
      buttons?.find((b) => b.text === 'Delete')?.onPress?.();
    }) as unknown as typeof Alert.alert;
    const { api } = await renderPlace(PLACE_ID, undefined, alert);
    expect(screen.getByTestId('family-place-name').props.value).toBe('Home');
    await act(async () => {
      fireEvent.press(screen.getByTestId('family-place-delete'));
    });
    await settleInbox();
    expect(api.deletePlace).toHaveBeenCalledWith(PLACE_ID);
  });
});

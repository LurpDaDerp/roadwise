/**
 * The car link's screens on Android, over the fake detector's car link: the same screens as on
 * iPhone (carLink.test.tsx), with Android's words (this phone, Android Auto) and Nearby devices asked
 * before Use this car (ruling 14), never after.
 */
import { act, screen, waitFor } from '@testing-library/react-native';

import { createFakeDriveDetect, type CarLinkState, type CarOutput } from '@drive-sense';
import { appWorld, clearQueryClients, tap } from '@/features/permissions/__fixtures__/harness';
import { runAs } from '@/lib/__fixtures__/platform';

import { carCopy } from '../copy';
import { CarScreen } from '../CarScreen';
import { CarSettingRow } from '../CarSettingRow';
import { HomeCarCard } from '../PairCarCard';

let mockDetect = createFakeDriveDetect();
jest.mock('../port', () => ({
  readCarLink: () => mockDetect.carLinkState().catch(() => null),
  pairCar: (uid: string) => mockDetect.pairCar(uid),
  forgetCar: (uid: string) => mockDetect.forgetCar(uid),
  notMyCar: (uid: string) => mockDetect.notMyCar(uid),
  onCarLink: (fn: (s: CarLinkState) => void) => {
    const sub = mockDetect.addListener('carLink', fn);
    return () => sub.remove();
  },
}));
const mockAskBluetooth = jest.fn(async () => {});
const mockAskNearby = jest.fn(async () => {});
jest.mock('../bluetoothAsk', () => ({ askBluetoothOnPair: () => mockAskBluetooth(), askBluetoothBeforePair: () => mockAskNearby() }));
let mockAuto: { state: string } = { state: 'on' };
jest.mock('@/features/autoDrives/useAutoDrives', () => ({
  useAutoDrives: () => mockAuto,
  autoDrivesOn: (a: { state: string }) => a.state === 'on',
}));
const mockPush = jest.fn();
jest.mock('@/data/supabase/client', () => ({ supabase: {} }));
jest.mock('expo-router', () => ({
  useRouter: () => ({ back: jest.fn(), push: mockPush, canGoBack: () => true }),
  useFocusEffect: (fn: () => void | (() => void)) => {
    // eslint-disable-next-line @typescript-eslint/no-require-imports -- the real React inside a mock factory
    const { useEffect } = require('react') as typeof import('react');
    useEffect(() => fn(), [fn]);
  },
}));


beforeEach(() => {
  mockDetect = createFakeDriveDetect();
  mockAuto = { state: 'on' };
  mockPush.mockClear();
  mockAskBluetooth.mockReset();
  mockAskBluetooth.mockImplementation(async () => {});
  mockAskNearby.mockReset();
  mockAskNearby.mockImplementation(async () => {});
});
afterEach(() => clearQueryClients());

describe('on Android (the same screens; Android Auto in CarPlay’s place, Nearby devices before Use this car)', () => {
  runAs('android');
  const auto: CarOutput = { uid: 'android-auto', name: 'Android Auto', type: 'carAudio' };
  const civicAndroid: CarOutput = { uid: '00:11:22:33:44:55', name: 'Civic', type: 'bluetoothA2DP' };

  it('says this phone and Android Auto; Use this car asks Nearby devices first, then pairs, and asks nothing after', async () => {
    mockDetect.setCarRoute([civicAndroid]);
    let pairedWhenAsked: number | null = null;
    mockAskNearby.mockImplementation(async () => {
      pairedWhenAsked = mockDetect.carLink.cars.length;
    });
    const w = await appWorld();
    await w.render(<CarScreen />);
    expect(await screen.findByText('Turn on your car and connect this phone to its Bluetooth or Android Auto, then tap Use this car.')).toBeTruthy();
    await waitFor(() => expect(screen.getByTestId('car-ask')).toHaveTextContent('Connected to Civic. Use this car?'));
    expect(mockAskNearby).not.toHaveBeenCalled();
    await tap('car-use');
    await waitFor(() => expect(screen.getByTestId('car-paired-0')).toHaveTextContent(/Civic/));
    expect(mockAskNearby).toHaveBeenCalledTimes(1);
    expect(pairedWhenAsked).toBe(0);
    expect(mockAskBluetooth).not.toHaveBeenCalled();
    // A denial (or a failure) pairs all the same.
    await tap('car-forget-0');
    await waitFor(() => expect(screen.queryByTestId('car-paired')).toBeNull());
    mockAskNearby.mockImplementation(async () => {
      throw new Error('denied');
    });
    await tap('car-use');
    await waitFor(() => expect(mockDetect.carLink.cars.map((c) => c.uid)).toEqual([civicAndroid.uid]));
  });

  it('names Android Auto with no Bluetooth name, and nothing connected in Android words', async () => {
    const w = await appWorld();
    await w.render(<CarScreen />);
    await waitFor(() => expect(screen.getByTestId('car-nothing')).toHaveTextContent(/No Bluetooth or Android Auto audio is connected right now\./));
    await act(async () => mockDetect.setCarRoute([{ ...auto, name: '' }]));
    await waitFor(() => expect(screen.getByTestId('car-output-0')).toHaveTextContent(/Android Auto/));
    expect(carCopy.kind('carAudio')).toBe('Android Auto');
    expect(carCopy.kind('bluetoothHFP')).toBe('Bluetooth');
  });

  it("Settings › Your car's row shows and never asks by itself; Home suggests Android Auto after one drive", async () => {
    mockDetect.setCarRoute([civicAndroid]);
    await mockDetect.pairCar(civicAndroid.uid);
    const w = await appWorld();
    await w.render(<CarSettingRow />);
    await waitFor(() => expect(screen.getByTestId('settings-car')).toHaveTextContent(/Civic/));
    await act(async () => {});
    expect(mockAskBluetooth).not.toHaveBeenCalled();
    expect(mockAskNearby).not.toHaveBeenCalled();
    await mockDetect.forgetCar(civicAndroid.uid);
    mockDetect.seeCarDrive([auto]);
    await w.render(<HomeCarCard hidden={false} />);
    await waitFor(() => expect(screen.getByTestId('home-car-ask')).toHaveTextContent(/Is Android Auto your car\?/));
    await tap('home-car-use');
    await waitFor(() => expect(mockDetect.carLink.cars.map((c) => c.uid)).toEqual([auto.uid]));
    expect(mockAskNearby).toHaveBeenCalledTimes(1);
  });
});

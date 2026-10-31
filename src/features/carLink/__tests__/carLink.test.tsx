/**
 * The car link's screens (iPhone): the rules (what is offered first, headphones, the suggestion),
 * Settings › Your car, the pairing screen and Home's card, over the fake detector's car link.
 */
import { act, screen, waitFor } from '@testing-library/react-native';
import { Platform } from 'react-native';

import { createFakeDriveDetect, type CarLinkState, type CarOutput } from '@drive-sense';
import { appWorld, clearQueryClients, tap } from '@/features/permissions/__fixtures__/harness';

import { carCopy } from '../copy';
import { CarScreen } from '../CarScreen';
import { CarSettingRow } from '../CarSettingRow';
import { CAR_CARD_DISMISSED_KEY, carRowLine, carSuggestion, looksLikeHeadphones, preselect } from '../model';
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

const civic: CarOutput = { uid: '00:11:22:33:44:55-tacl', name: 'Civic', type: 'bluetoothA2DP' };
const carplay: CarOutput = { uid: 'carplay-1', name: '', type: 'carAudio' };
const pods: CarOutput = { uid: 'AA:BB:CC:DD:EE:FF-tacl', name: "Sam's AirPods Pro", type: 'bluetoothA2DP' };
const base: CarLinkState = { current: [], cars: [], linked: false, goneSince: null, drives: [], notMine: [] };
const drive = (outputs: CarOutput[], i: number) => ({ driveId: `0f8fad5b-d9cb-469f-a165-7086772895${String(i).padStart(2, '0')}`, endedAt: i, outputs });

beforeEach(() => {
  mockDetect = createFakeDriveDetect();
  mockAuto = { state: 'on' };
  mockPush.mockClear();
});
afterEach(() => clearQueryClients());

describe('the rules', () => {
  it('reads headphones and earbuds as headphones, a car as a car', () => {
    for (const n of ["Sam's AirPods Pro", 'Beats Studio', 'Galaxy Buds2 Pro', 'WH-1000XM5', 'Bose QuietComfort 45', 'JBL Earbuds', 'Jabra headset']) expect({ n, h: looksLikeHeadphones(n) }).toEqual({ n, h: true });
    for (const n of ['Civic', 'Toyota RAV4', 'CarPlay', 'MY VW', 'Uconnect']) expect({ n, h: looksLikeHeadphones(n) }).toEqual({ n, h: false });
  });

  it('offers CarPlay or an unpaired output first, and keeps a choice while it stays connected', () => {
    const s = { ...base, current: [civic, carplay], cars: [] };
    expect(preselect(s, null)?.uid).toBe(carplay.uid);
    expect(preselect(s, civic.uid)?.uid).toBe(civic.uid);
    expect(preselect({ ...s, current: [civic, pods], cars: [{ ...civic, pairedAt: 1 }] }, null)?.uid).toBe(pods.uid);
    expect(preselect(base, 'gone')).toBeNull();
  });

  it('suggests an output from most of 2 of the last 3 drives (CarPlay after 1), never paired, Not my car, headphones, or past 3 cars', () => {
    expect(carSuggestion({ ...base, drives: [drive([civic], 1)] })).toBeNull();
    expect(carSuggestion({ ...base, drives: [drive([civic], 1), drive([], 2), drive([civic], 3)] })?.uid).toBe(civic.uid);
    expect(carSuggestion({ ...base, drives: [drive([civic], 1), drive([civic], 2), drive([], 3), drive([], 4)] })).toBeNull();
    expect(carSuggestion({ ...base, drives: [drive([carplay], 1)] })?.uid).toBe(carplay.uid);
    expect(carSuggestion({ ...base, drives: [drive([civic], 1), drive([civic], 2)], notMine: [civic.uid] })).toBeNull();
    expect(carSuggestion({ ...base, drives: [drive([pods], 1), drive([pods], 2)] })).toBeNull();
    const three = [1, 2, 3].map((i) => ({ uid: `u${i}`, name: `Car ${i}`, type: 'bluetoothA2DP' as const, pairedAt: i }));
    expect(carSuggestion({ ...base, cars: three, drives: [drive([civic], 1), drive([civic], 2)] })).toBeNull();
    expect(carRowLine({ ...base, cars: three.slice(0, 2) })).toBe('Car 1, Car 2');
    expect(carRowLine(base)).toBe(carCopy.row.none);
  });
});

describe('Settings › Your car', () => {
  it('names the paired car and opens the pairing screen', async () => {
    mockDetect.setCarRoute([civic]);
    await mockDetect.pairCar(civic.uid);
    const w = await appWorld();
    await w.render(<CarSettingRow />);
    await waitFor(() => expect(screen.getByTestId('settings-car')).toHaveTextContent(/Civic/));
    await tap('settings-car');
    expect(mockPush).toHaveBeenCalledWith('/settings/car');
  });

  it('hides on a native build without the car link', async () => {
    mockDetect = createFakeDriveDetect({ available: false });
    const w = await appWorld();
    await w.render(<CarSettingRow />);
    await waitFor(() => expect(screen.queryByTestId('settings-car')).toBeNull());
  });
});

describe('the pairing screen', () => {
  it('shows the connected output preselected, pairs it on the tap, and forgets it', async () => {
    mockDetect.setCarRoute([civic]);
    const w = await appWorld();
    await w.render(<CarScreen />);
    expect(screen.getByText(carCopy.screen.intro)).toBeTruthy();
    await waitFor(() => expect(screen.getByTestId('car-ask')).toHaveTextContent('Connected to Civic. Use this car?'));
    expect(mockDetect.carLink.cars).toEqual([]);
    await tap('car-use');
    await waitFor(() => expect(screen.getByTestId('car-paired-0')).toHaveTextContent(/Civic/));
    expect(screen.getByTestId('car-ask')).toHaveTextContent('Civic is paired.');
    expect(screen.queryByTestId('car-use')).toBeNull();
    await tap('car-forget-0');
    await waitFor(() => expect(screen.queryByTestId('car-paired')).toBeNull());
    expect(mockDetect.carLink.cars).toEqual([]);
  });

  it('warns about headphones but still lets them be used; with several outputs each can be chosen', async () => {
    mockDetect.setCarRoute([pods, civic]);
    const w = await appWorld();
    await w.render(<CarScreen />);
    await waitFor(() => expect(screen.getByTestId('car-ask')).toHaveTextContent(/AirPods/));
    expect(screen.getByTestId('car-headphones')).toBeTruthy();
    expect(screen.getByText(carCopy.screen.headphones)).toBeTruthy();
    await tap('car-output-1');
    await waitFor(() => expect(screen.getByTestId('car-ask')).toHaveTextContent('Connected to Civic. Use this car?'));
    expect(screen.queryByTestId('car-headphones')).toBeNull();
    await tap('car-output-0');
    await tap('car-use');
    await waitFor(() => expect(mockDetect.carLink.cars.map((c) => c.uid)).toEqual([pods.uid]));
  });

  it('follows the route live, says when nothing is connected, and stops at 3 cars', async () => {
    const w = await appWorld();
    await w.render(<CarScreen />);
    await waitFor(() => expect(screen.getByTestId('car-nothing')).toBeTruthy());
    expect(screen.queryByTestId('car-use')).toBeNull();
    for (const uid of ['a', 'b', 'c']) {
      await act(async () => mockDetect.setCarRoute([{ uid, name: uid.toUpperCase(), type: 'bluetoothA2DP' }]));
      await tap('car-use');
      await waitFor(() => expect(mockDetect.carLink.cars.some((c) => c.uid === uid)).toBe(true));
    }
    await act(async () => mockDetect.setCarRoute([civic]));
    await waitFor(() => expect(screen.getByText(carCopy.screen.full)).toBeTruthy());
    expect(screen.getByTestId('car-use')).toBeDisabled();
    expect(screen.getByTestId('car-note')).toHaveTextContent(/can’t wake your iPhone on its own/);
  });
});

describe("Home's car card", () => {
  it('asks to pair while automatic drives are on and no car is paired; a tap opens Your car; ✕ closes it for good', async () => {
    const w = await appWorld();
    await w.render(<HomeCarCard hidden={false} />);
    await tap('home-car');
    expect(mockPush).toHaveBeenCalledWith('/settings/car');
    await tap('home-car-dismiss');
    expect(screen.queryByTestId('home-car')).toBeNull();
    await waitFor(async () => expect(await w.settings.get(CAR_CARD_DISMISSED_KEY)).toBe(true));
  });

  it('turns into "Is <name> your car?" from the drives; Not my car never asks again', async () => {
    mockDetect.seeCarDrive([civic]);
    mockDetect.seeCarDrive([civic]);
    const w = await appWorld();
    const r = await w.render(<HomeCarCard hidden={false} />);
    await waitFor(() => expect(screen.getByTestId('home-car-ask')).toHaveTextContent(/Is Civic your car\?/));
    await tap('home-car-not-mine');
    await waitFor(() => expect(screen.getByTestId('home-car')).toBeTruthy());
    expect(mockDetect.carLink.notMine).toEqual([civic.uid]);
    r.unmount();
  });

  it('suggests CarPlay after one drive; Use it pairs it and the card goes', async () => {
    mockDetect.seeCarDrive([carplay]);
    const w = await appWorld();
    await w.render(<HomeCarCard hidden={false} />);
    await waitFor(() => expect(screen.getByTestId('home-car-ask')).toHaveTextContent(/Is CarPlay your car\?/));
    await tap('home-car-use');
    await waitFor(() => expect(mockDetect.carLink.cars.map((c) => c.uid)).toEqual([carplay.uid]));
    await waitFor(() => expect(screen.queryByTestId('home-car-ask')).toBeNull());
  });

  it('never shows during a drive, with automatic drives off, once a car is paired, once closed, or on Android', async () => {
    const w = await appWorld({ settings: { [CAR_CARD_DISMISSED_KEY]: true } });
    const closed = await w.render(<HomeCarCard hidden={false} />);
    await act(async () => {});
    expect(screen.queryByTestId('home-car')).toBeNull();
    closed.unmount();
    const w2 = await appWorld();
    const during = await w2.render(<HomeCarCard hidden />);
    await act(async () => {});
    expect(screen.queryByTestId('home-car')).toBeNull();
    during.unmount();
    mockAuto = { state: 'disabled' };
    const off = await w2.render(<HomeCarCard hidden={false} />);
    await act(async () => {});
    expect(screen.queryByTestId('home-car')).toBeNull();
    off.unmount();
    mockAuto = { state: 'on' };
    mockDetect.setCarRoute([civic]);
    await mockDetect.pairCar(civic.uid);
    const paired = await w2.render(<HomeCarCard hidden={false} />);
    await act(async () => {});
    expect(screen.queryByTestId('home-car')).toBeNull();
    paired.unmount();
    const os = Platform.OS;
    Object.defineProperty(Platform, 'OS', { value: 'android', configurable: true });
    try {
      await mockDetect.forgetCar(civic.uid);
      await w2.render(<HomeCarCard hidden={false} />);
      await act(async () => {});
      expect(screen.queryByTestId('home-car')).toBeNull();
    } finally {
      Object.defineProperty(Platform, 'OS', { value: os, configurable: true });
    }
  });
});

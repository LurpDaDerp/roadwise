/**
 * The paired cars the drive lists read (iPhone): the names they show, the car a row names, and the
 * one store every row shares, over the fake detector's car link.
 */
import { act, render, screen } from '@testing-library/react-native';
import { AppState, Platform, Text, type AppStateStatus } from 'react-native';

import { createFakeDriveDetect, type CarLinkState, type CarOutput, type PairedCar } from '@drive-sense';

import { CAR_LIST_MIN, driveCarLabel, pairedCarLabels, resetPairedCars, usePairedCarLabels, usePairedCars } from '../usePairedCars';

let mockDetect = createFakeDriveDetect();
/** Each read of the car link (`readCarLink`); by default the fake's state. */
const mockRead = jest.fn((): Promise<CarLinkState | null> => mockDetect.carLinkState().catch(() => null));
let mockOff = jest.fn();
jest.mock('../port', () => ({
  readCarLink: () => mockRead(),
  onCarLink: (fn: (s: CarLinkState) => void) => {
    const sub = mockDetect.addListener('carLink', fn);
    mockOff = jest.fn(() => sub.remove());
    return mockOff;
  },
}));

const civic: CarOutput = { uid: '00:11:22:33:44:55-tacl', name: 'Civic', type: 'bluetoothA2DP' };
const volvo: CarOutput = { uid: '66:77:88:99:AA:BB-tacl', name: 'Volvo XC60', type: 'bluetoothHFP' };
const carplay: CarOutput = { uid: 'carplay-1', name: '', type: 'carAudio' };
const paired = (o: CarOutput, at = 1): PairedCar => ({ ...o, pairedAt: at });

let appListeners: ((s: AppStateStatus) => void)[] = [];
let restoreOS: (() => void) | null = null;

beforeEach(() => {
  resetPairedCars();
  mockDetect = createFakeDriveDetect();
  mockRead.mockReset();
  mockRead.mockImplementation(() => mockDetect.carLinkState().catch(() => null));
  appListeners = [];
  jest.spyOn(AppState, 'addEventListener').mockImplementation((_type, fn) => {
    appListeners.push(fn as (s: AppStateStatus) => void);
    return { remove: () => (appListeners = appListeners.filter((l) => l !== fn)) } as ReturnType<typeof AppState.addEventListener>;
  });
});
afterEach(() => {
  restoreOS?.();
  restoreOS = null;
  jest.restoreAllMocks();
});

/** Pairs each output with the phone on its route (the fake pairs only what it has seen). */
async function pairAll(...outputs: CarOutput[]) {
  for (const o of outputs) {
    mockDetect.setCarRoute([o]);
    await mockDetect.pairCar(o.uid);
  }
  mockDetect.setCarRoute([]);
}

const onRender = jest.fn();
function Probe() {
  onRender();
  const labels = usePairedCarLabels();
  const cars = usePairedCars();
  return (
    <>
      <Text testID="labels">{labels.map((l) => `${l.uid}=${l.label}`).join('|')}</Text>
      <Text testID="cars">{String(cars.length)}</Text>
    </>
  );
}

const flush = () => act(async () => {});

describe('the names the lists show', () => {
  test('nothing with fewer than 2 cars paired', () => {
    expect(CAR_LIST_MIN).toBe(2);
    expect(pairedCarLabels([])).toEqual([]);
    expect(pairedCarLabels([paired(civic)])).toEqual([]);
  });

  test("each car by the phone's name for it (trimmed), or its kind, in the order paired", () => {
    expect(pairedCarLabels([paired({ ...civic, name: '  Civic ' }), paired(carplay), paired(volvo)])).toEqual([
      { uid: civic.uid, label: 'Civic' },
      { uid: carplay.uid, label: 'CarPlay' },
      { uid: volvo.uid, label: 'Volvo XC60' },
    ]);
    expect(pairedCarLabels([paired({ ...civic, name: '' }), paired(volvo)])[0]).toEqual({ uid: civic.uid, label: 'Bluetooth audio' });
  });

  test('two cars of one name are told apart by a number, whatever the case', () => {
    expect(pairedCarLabels([paired(carplay), paired({ ...carplay, uid: 'carplay-2' })]).map((l) => l.label)).toEqual(['CarPlay', 'CarPlay 2']);
    expect(pairedCarLabels([paired(civic), paired({ ...volvo, name: 'civic' }), paired({ ...carplay, name: 'CIVIC' })]).map((l) => l.label)).toEqual([
      'Civic',
      'civic 2',
      'CIVIC 3',
    ]);
    // A numbered name a car already has is skipped.
    expect(pairedCarLabels([paired({ ...civic, name: 'Civic 2' }), paired(volvo, 2), paired({ ...carplay, name: 'Civic' }), paired({ ...carplay, uid: 'x', name: 'Civic' })]).map((l) => l.label)).toEqual([
      'Civic 2',
      'Volvo XC60',
      'Civic',
      'Civic 3',
    ]);
  });
});

describe('the car a row names', () => {
  const labels = pairedCarLabels([paired(civic), paired(volvo)]);

  test("the car's name now while it is paired (a renamed car shows its new name)", () => {
    expect(driveCarLabel({ carUid: civic.uid, carName: 'Old Civic name' }, labels)).toBe('Civic');
    expect(driveCarLabel({ carUid: volvo.uid, carName: null }, labels)).toBe('Volvo XC60');
  });

  test('a car no longer paired: the name it had on that drive, else nothing', () => {
    expect(driveCarLabel({ carUid: 'gone', carName: ' Mom’s Jeep ' }, labels)).toBe('Mom’s Jeep');
    expect(driveCarLabel({ carUid: 'gone', carName: '  ' }, labels)).toBeNull();
    expect(driveCarLabel({ carUid: 'gone', carName: null }, labels)).toBeNull();
    expect(driveCarLabel({ carUid: 'gone' }, labels)).toBeNull();
  });

  test('a drive with no car, and any drive with fewer than 2 cars paired, names none', () => {
    expect(driveCarLabel({ carUid: null, carName: 'Civic' }, labels)).toBeNull();
    expect(driveCarLabel({ carUid: '', carName: 'Civic' }, labels)).toBeNull();
    expect(driveCarLabel({}, labels)).toBeNull();
    expect(driveCarLabel({ carUid: civic.uid, carName: 'Civic' }, [])).toBeNull();
    expect(driveCarLabel({ carUid: civic.uid, carName: 'Civic' }, pairedCarLabels([paired(civic)]))).toBeNull();
  });
});

describe('the store', () => {
  test('reads the paired cars when the first list shows, and names them', async () => {
    await pairAll(civic, volvo);
    await render(<Probe />);
    await flush();
    expect(screen.getByTestId('labels')).toHaveTextContent(`${civic.uid}=Civic|${volvo.uid}=Volvo XC60`);
    expect(screen.getByTestId('cars')).toHaveTextContent('2');
    expect(mockRead).toHaveBeenCalledTimes(1);
  });

  test('one car paired: the cars, no names', async () => {
    await pairAll(civic);
    await render(<Probe />);
    await flush();
    expect(screen.getByTestId('cars')).toHaveTextContent('1');
    expect(screen.getByTestId('labels')).toHaveTextContent('');
  });

  test('a pairing, a forget and a rename arrive by the car link event', async () => {
    await pairAll(civic);
    await render(<Probe />);
    await flush();
    expect(screen.getByTestId('labels')).toHaveTextContent('');
    await act(async () => {
      mockDetect.setCarRoute([volvo]);
      await mockDetect.pairCar(volvo.uid);
    });
    expect(screen.getByTestId('labels')).toHaveTextContent(`${civic.uid}=Civic|${volvo.uid}=Volvo XC60`);
    await act(async () => {
      await mockDetect.forgetCar(civic.uid);
    });
    expect(screen.getByTestId('labels')).toHaveTextContent('');
    expect(screen.getByTestId('cars')).toHaveTextContent('1');
  });

  test('a route change alone re-renders no row', async () => {
    await pairAll(civic, volvo);
    await render(<Probe />);
    await flush();
    const before = onRender.mock.calls.length;
    await act(async () => {
      mockDetect.setCarRoute([civic]);
      mockDetect.setCarRoute([civic, volvo]);
      mockDetect.setCarRoute([]);
      mockDetect.setCarGoneSince(5);
    });
    expect(onRender).toHaveBeenCalledTimes(before);
  });

  test('a read that fails keeps what is known', async () => {
    await pairAll(civic, volvo);
    await render(<Probe />);
    await flush();
    mockRead.mockImplementationOnce(async () => null);
    await act(async () => appListeners.forEach((l) => l('active')));
    expect(screen.getByTestId('labels')).toHaveTextContent(`${civic.uid}=Civic|${volvo.uid}=Volvo XC60`);
    mockRead.mockImplementationOnce(() => Promise.reject(new Error('boom')));
    await act(async () => appListeners.forEach((l) => l('active')));
    expect(screen.getByTestId('cars')).toHaveTextContent('2');
  });

  test('coming back to the front reads it again (a car renamed in iOS Settings)', async () => {
    await pairAll(civic, volvo);
    await render(<Probe />);
    await flush();
    const renamed: CarLinkState = { ...mockDetect.carLink, cars: [paired({ ...civic, name: 'Family Civic' }), paired(volvo)] };
    mockRead.mockImplementationOnce(async () => renamed);
    await act(async () => appListeners.forEach((l) => l('background')));
    expect(mockRead).toHaveBeenCalledTimes(1);
    await act(async () => appListeners.forEach((l) => l('active')));
    expect(mockRead).toHaveBeenCalledTimes(2);
    expect(screen.getByTestId('labels')).toHaveTextContent(`${civic.uid}=Family Civic|${volvo.uid}=Volvo XC60`);
  });

  test('a slow read never overwrites a newer event', async () => {
    await pairAll(civic, volvo);
    let answer: (s: CarLinkState | null) => void = () => {};
    const stale = mockDetect.carLink;
    mockRead.mockImplementationOnce(() => new Promise((r) => (answer = r)));
    await render(<Probe />);
    await act(async () => {
      await mockDetect.forgetCar(volvo.uid);
    });
    expect(screen.getByTestId('cars')).toHaveTextContent('1');
    await act(async () => answer(stale));
    expect(screen.getByTestId('cars')).toHaveTextContent('1');
    expect(screen.getByTestId('labels')).toHaveTextContent('');
  });

  test('every row shares one subscription and one read; the last one gone stops listening', async () => {
    await pairAll(civic, volvo);
    const view = await render(
      <>
        <Probe />
        <Probe />
        <Probe />
      </>
    );
    await flush();
    expect(mockRead).toHaveBeenCalledTimes(1);
    expect(appListeners).toHaveLength(1);
    await view.unmount();
    expect(mockOff).toHaveBeenCalledTimes(1);
    expect(appListeners).toHaveLength(0);
    // Shown again: read afresh (what it held shows at once meanwhile).
    await render(<Probe />);
    expect(screen.getByTestId('cars')).toHaveTextContent('2');
    await flush();
    expect(mockRead).toHaveBeenCalledTimes(2);
  });

  test('Android: never reads, never listens, no cars', async () => {
    restoreOS = jest.replaceProperty(Platform, 'OS', 'android').restore;
    await pairAll(civic, volvo);
    await render(<Probe />);
    await flush();
    expect(mockRead).not.toHaveBeenCalled();
    expect(appListeners).toHaveLength(0);
    expect(screen.getByTestId('cars')).toHaveTextContent('0');
  });

  test('a build without the car link: no cars', async () => {
    mockRead.mockImplementation(async () => null);
    await render(<Probe />);
    await flush();
    expect(screen.getByTestId('cars')).toHaveTextContent('0');
    expect(screen.getByTestId('labels')).toHaveTextContent('');
  });
});

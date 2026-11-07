/**
 * Drives by car (iPhone): with 2 or more cars paired, each drive row names its car and Drive history
 * filters by car; with fewer, nothing shows. Over the fake detector's car link.
 */
import { act, screen, within } from '@testing-library/react-native';
import { Platform } from 'react-native';

import { createFakeDriveDetect, type CarLinkState, type CarOutput } from '@drive-sense';
import { pairedCarLabels, resetPairedCars } from '@/features/carLink/usePairedCars';
import { RecentDrives } from '@/features/home/HomeSections';

import { DAY, draw, drive, NOW, press } from '../__fixtures__/drives';
import { DriveRow } from '../DriveRow';
import { HistoryView, type HistoryViewProps } from '../HistoryView';

let mockDetect = createFakeDriveDetect();
jest.mock('@/features/carLink/port', () => ({
  readCarLink: () => mockDetect.carLinkState().catch(() => null),
  onCarLink: (fn: (s: CarLinkState) => void) => {
    const sub = mockDetect.addListener('carLink', fn);
    return () => sub.remove();
  },
}));

const civic: CarOutput = { uid: '00:11:22:33:44:55-tacl', name: 'Civic', type: 'bluetoothA2DP' };
const volvo: CarOutput = { uid: '66:77:88:99:AA:BB-tacl', name: 'Volvo XC60', type: 'bluetoothA2DP' };
const carplay: CarOutput = { uid: 'carplay-1', name: '', type: 'carAudio' };

async function pairAll(...outputs: CarOutput[]) {
  for (const o of outputs) {
    mockDetect.setCarRoute([o]);
    await mockDetect.pairCar(o.uid);
  }
  mockDetect.setCarRoute([]);
}

const settle = () => act(async () => {});

let restoreOS: (() => void) | null = null;
beforeEach(() => {
  resetPairedCars();
  mockDetect = createFakeDriveDetect();
});
afterEach(() => {
  restoreOS?.();
  restoreOS = null;
});

const drives = [
  drive({ clientTripId: 'a', startedAt: NOW - 1000, carUid: civic.uid, carName: 'Civic' }),
  drive({ clientTripId: 'b', startedAt: NOW - 2 * DAY, carUid: volvo.uid, carName: 'Volvo' }),
  drive({ clientTripId: 'c', startedAt: NOW - 3 * DAY, carUid: null, carName: null }),
  drive({ clientTripId: 'd', startedAt: NOW - 4 * DAY, carUid: 'forgotten', carName: 'Old Jeep' }),
];

const props = (over: Partial<HistoryViewProps> = {}): HistoryViewProps => ({
  drives,
  loading: false,
  error: false,
  filter: 'all',
  onFilter: jest.fn(),
  onOpen: jest.fn(),
  onBack: jest.fn(),
  onHome: jest.fn(),
  now: NOW,
  ...over,
});

describe('the drive row', () => {
  test('2 cars paired: each row names its car, a forgotten one by its name then, a drive with no car none', async () => {
    await pairAll(civic, volvo);
    await draw(<HistoryView {...props()} />);
    await settle();
    expect(within(screen.getByTestId('drive-a-car')).getByText('Civic')).toBeOnTheScreen();
    expect(within(screen.getByTestId('drive-b-car')).getByText('Volvo XC60')).toBeOnTheScreen();
    expect(screen.queryByTestId('drive-c-car')).toBeNull();
    expect(within(screen.getByTestId('drive-d-car')).getByText('Old Jeep')).toBeOnTheScreen();
  });

  test('the spoken row says the car after the route', async () => {
    await pairAll(civic, volvo);
    await draw(<HistoryView {...props()} />);
    await settle();
    expect(screen.getByTestId('drive-a').props.accessibilityLabel).toContain('Home to School, in Civic, ');
    expect(screen.getByTestId('drive-c').props.accessibilityLabel).not.toContain(' in ');
  });

  test('1 car paired, or none: no row names a car', async () => {
    await pairAll(civic);
    await draw(<HistoryView {...props()} />);
    await settle();
    expect(screen.queryByTestId('drive-a-car')).toBeNull();
    expect(screen.queryByTestId('drive-d-car')).toBeNull();
    expect(screen.getByTestId('drive-a').props.accessibilityLabel).not.toContain('Civic');
  });

  test('the chips come and go with the pairing while the list is open', async () => {
    await pairAll(civic);
    await draw(<HistoryView {...props()} />);
    await settle();
    expect(screen.queryByTestId('drive-a-car')).toBeNull();
    await act(async () => {
      mockDetect.setCarRoute([volvo]);
      await mockDetect.pairCar(volvo.uid);
    });
    expect(screen.getByTestId('drive-a-car')).toBeOnTheScreen();
    await act(async () => {
      await mockDetect.forgetCar(civic.uid);
    });
    expect(screen.queryByTestId('drive-a-car')).toBeNull();
  });

  test("Home's recent drives name the car too", async () => {
    await pairAll(civic, carplay);
    await draw(<RecentDrives drives={[drives[0]!, drive({ clientTripId: 'e', carUid: carplay.uid, carName: 'CarPlay' })]} onOpen={jest.fn()} onSeeAll={jest.fn()} />);
    await settle();
    expect(within(screen.getByTestId('recent-a-car')).getByText('Civic')).toBeOnTheScreen();
    expect(within(screen.getByTestId('recent-e-car')).getByText('CarPlay')).toBeOnTheScreen();
  });

  test('a row with no testID still draws its chip', async () => {
    await pairAll(civic, volvo);
    await draw(<DriveRow drive={drives[0]!} units="mi" onPress={jest.fn()} />);
    await settle();
    expect(screen.getByTestId('row-car')).toBeOnTheScreen();
  });

  test('Android: no car anywhere', async () => {
    await pairAll(civic, volvo);
    restoreOS = jest.replaceProperty(Platform, 'OS', 'android').restore;
    await draw(<HistoryView {...props()} />);
    await settle();
    expect(screen.queryByTestId('drive-a-car')).toBeNull();
  });
});

describe('the history filter', () => {
  const cars = pairedCarLabels([
    civic,
    volvo,
  ]);

  test('one chip per paired car after Clean and Passenger, each toggling its car on and back off', async () => {
    const p = props({ cars });
    await draw(<HistoryView {...p} />);
    const chips = screen.getByLabelText('Filter drives');
    expect(within(chips).getAllByRole('button').map((b) => b.props.accessibilityLabel)).toEqual(['Clean', 'Passenger', 'Civic', 'Volvo XC60']);
    await press(screen.getByTestId(`filter-car:${civic.uid}`));
    expect(p.onFilter).toHaveBeenLastCalledWith(`car:${civic.uid}`);
    await draw(<HistoryView {...props({ cars, filter: `car:${volvo.uid}`, onFilter: p.onFilter })} />);
    expect(screen.getByTestId(`filter-car:${volvo.uid}`)).toBeSelected();
    expect(screen.getByTestId(`filter-car:${civic.uid}`)).not.toBeSelected();
    expect(screen.getByTestId('filter-clean')).not.toBeSelected();
    await press(screen.getByTestId(`filter-car:${volvo.uid}`));
    expect(p.onFilter).toHaveBeenLastCalledWith('all');
    // From a car to Clean: one filter at a time.
    await press(screen.getByTestId('filter-clean'));
    expect(p.onFilter).toHaveBeenLastCalledWith('clean');
  });

  test('fewer than 2 cars: only Clean and Passenger', async () => {
    await draw(<HistoryView {...props({ cars: pairedCarLabels([civic]) })} />);
    expect(within(screen.getByLabelText('Filter drives')).getAllByRole('button')).toHaveLength(2);
    await draw(<HistoryView {...props()} />);
    expect(within(screen.getByLabelText('Filter drives')).getAllByRole('button')).toHaveLength(2);
  });

  test("a car with no drives says so by its name and offers everything; never “in the last 6 months” (the archive clears the car)", async () => {
    const p = props({ cars, drives: [], filter: `car:${volvo.uid}`, archived: { all: true, clean: true, passenger: true } });
    await draw(<HistoryView {...p} />);
    const empty = screen.getByTestId(`history-empty-car:${volvo.uid}`);
    expect(within(empty).getByText('No drives in Volvo XC60')).toBeOnTheScreen();
    expect(within(empty).getByText('Drives with this car connected show up here.')).toBeOnTheScreen();
    expect(screen.queryByText(/last 6 months/)).toBeNull();
    await press(within(empty).getByText('Show all drives'));
    expect(p.onFilter).toHaveBeenCalledWith('all');
  });
});

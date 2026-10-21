import { act, render, screen } from '@testing-library/react-native';
import { AppState, Text, type AppStateStatus } from 'react-native';

import { autoDrivesFrom, readAutoDrives, resetAutoDrivesForTests, useAutoDrives, type AutoDetectStatus } from '../useAutoDrives';

const mockRead = jest.fn();
// The boot package's reader (the native status), through the screens' one door to it.
jest.mock('../port', () => ({ readAutoDetectStatus: () => mockRead() }));
let mockFocus: (() => void) | null = null;
jest.mock('expo-router', () => {
  const { useEffect } = jest.requireActual<typeof import('react')>('react');
  return {
    useFocusEffect: (fn: () => void) => {
      mockFocus = fn;
      useEffect(fn, [fn]);
    },
  };
});

const ALL = { location: 'always', precise: true, motion: 'granted', backgroundRefresh: 'available', liveActivities: true, canAskAlways: false } as const;
const status = (over: Partial<NonNullable<AutoDetectStatus>> = {}): AutoDetectStatus =>
  ({ armed: true, status: 'on', missing: [], permissions: { ...ALL }, ...over }) as NonNullable<AutoDetectStatus>;

beforeEach(() => {
  mockRead.mockReset();
  resetAutoDrivesForTests();
});

describe('autoDrivesFrom', () => {
  test('null (Android, or a read that failed) and an iPhone that cannot run it are unsupported', () => {
    expect(autoDrivesFrom(null)).toEqual({ state: 'unsupported' });
    expect(autoDrivesFrom(status({ status: 'unavailable', armed: false }))).toEqual({ state: 'unsupported' });
  });

  test('on when the native side senses', () => {
    expect(autoDrivesFrom(status())).toEqual({ state: 'on' });
  });

  test('what is missing, in display order, from the native list and the permissions themselves', () => {
    expect(
      autoDrivesFrom(status({ status: 'needs', armed: false, missing: ['backgroundRefresh', 'motion', 'locationAlways', 'locationPrecise', 'liveActivities'] }))
    ).toEqual({ state: 'off', missing: ['locationAlways', 'precise', 'motion', 'backgroundRefresh'] });
    expect(autoDrivesFrom(status({ status: 'off', armed: false, permissions: { ...ALL, location: 'whenInUse', motion: 'denied' } }))).toEqual({
      state: 'off',
      missing: ['locationAlways', 'motion'],
    });
    // Live Activities never stop a drive; a restricted Background App Refresh is not the driver's to fix
    expect(autoDrivesFrom(status({ status: 'needs', armed: false, missing: ['liveActivities'], permissions: { ...ALL, backgroundRefresh: 'restricted' } }))).toEqual({
      state: 'unknown',
    });
  });

  test('not armed yet with nothing missing reads as unknown (the next foreground arms it)', () => {
    expect(autoDrivesFrom(status({ status: 'off', armed: false }))).toEqual({ state: 'unknown' });
  });
});

test('readAutoDrives never rejects: a throw reads as unknown', async () => {
  mockRead.mockRejectedValue(new Error('bridge'));
  await expect(readAutoDrives()).resolves.toEqual({ state: 'unknown' });
  mockRead.mockResolvedValue(null);
  await expect(readAutoDrives()).resolves.toEqual({ state: 'unsupported' });
});

describe('useAutoDrives', () => {
  function Probe() {
    const a = useAutoDrives();
    return <Text testID="auto">{a.state === 'off' ? `off:${a.missing.join(',')}` : a.state}</Text>;
  }
  let listeners: ((s: AppStateStatus) => void)[] = [];
  beforeEach(() => {
    listeners = [];
    jest.spyOn(AppState, 'addEventListener').mockImplementation((_t, fn) => {
      listeners.push(fn as (s: AppStateStatus) => void);
      return { remove: () => {} } as never;
    });
  });
  afterEach(() => jest.restoreAllMocks());

  test('unknown until read, then read on focus and again on return to the front', async () => {
    mockRead.mockResolvedValue(status({ status: 'needs', armed: false, missing: ['locationAlways'] }));
    await render(<Probe />);
    await act(async () => {});
    expect(screen.getByTestId('auto')).toHaveTextContent('off:locationAlways');
    mockRead.mockResolvedValue(status());
    await act(async () => {
      for (const fn of listeners) fn('active');
    });
    expect(screen.getByTestId('auto')).toHaveTextContent('on');
    mockRead.mockResolvedValue(null);
    await act(async () => mockFocus?.());
    expect(screen.getByTestId('auto')).toHaveTextContent('unsupported');
    expect(mockRead).toHaveBeenCalledTimes(3);
  });

  test('a screen that mounts later starts from the last reading', async () => {
    mockRead.mockResolvedValue(status());
    await readAutoDrives();
    mockRead.mockReturnValue(new Promise(() => {}));
    await render(<Probe />);
    expect(screen.getByTestId('auto')).toHaveTextContent('on');
  });
});

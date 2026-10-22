import { act, render, screen } from '@testing-library/react-native';
import { AppState, Text, type AppStateStatus } from 'react-native';

import { autoDrivesFrom, autoDrivesOn, readAutoDrives, resetAutoDrivesForTests, setAutoDrivesEnabled, useAutoDrives, type AutoDetectStatus } from '../useAutoDrives';

const mockRead = jest.fn();
const mockSetEnabled = jest.fn(async (_on: boolean) => 'on');
// The boot package's reader (the native status), through the screens' one door to it.
jest.mock('../port', () => ({ readAutoDetectStatus: () => mockRead(), setAutoDetectEnabled: (on: boolean) => mockSetEnabled(on) }));
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
  mockSetEnabled.mockClear();
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

describe('the Automatic drives switch', () => {
  test('off by choice reads as disabled, before anything missing; never as on', () => {
    expect(autoDrivesFrom(status({ enabled: false, status: 'off', armed: false }))).toEqual({ state: 'disabled' });
    expect(autoDrivesFrom(status({ enabled: false, status: 'needs', armed: false, missing: ['locationAlways'] }))).toEqual({ state: 'disabled' });
    expect(autoDrivesOn({ state: 'disabled' })).toBe(false);
    // an iPhone that cannot run it, and Android, stay unsupported whatever the switch says
    expect(autoDrivesFrom(status({ enabled: false, status: 'unavailable', armed: false }))).toEqual({ state: 'unsupported' });
    // switched on (or a status without the field): as before
    expect(autoDrivesFrom(status({ enabled: true }))).toEqual({ state: 'on' });
    expect(autoDrivesFrom(status({ enabled: true, status: 'needs', armed: false, missing: ['motion'] }))).toEqual({ state: 'off', missing: ['motion'] });
  });

  test('setAutoDrivesEnabled stores the choice, then every mounted screen reads the new status', async () => {
    function Probe({ id }: { id: string }) {
      const a = useAutoDrives();
      return <Text testID={id}>{a.state}</Text>;
    }
    mockRead.mockResolvedValue(status());
    await render(
      <>
        <Probe id="a" />
        <Probe id="b" />
      </>
    );
    await act(async () => {});
    expect(screen.getByTestId('a')).toHaveTextContent('on');
    mockRead.mockResolvedValue(status({ enabled: false, status: 'off', armed: false }));
    await act(async () => {
      await expect(setAutoDrivesEnabled(false)).resolves.toEqual({ state: 'disabled' });
    });
    expect(mockSetEnabled).toHaveBeenCalledWith(false);
    expect(screen.getByTestId('a')).toHaveTextContent('disabled');
    expect(screen.getByTestId('b')).toHaveTextContent('disabled');
  });

  test('a read that started before the switch and lands after it never replaces the newer reading', async () => {
    let answer: (s: AutoDetectStatus) => void = () => {};
    mockRead.mockReturnValueOnce(new Promise<AutoDetectStatus>((r) => (answer = r)));
    const stale = readAutoDrives();
    mockRead.mockResolvedValueOnce(status({ enabled: false, status: 'off', armed: false }));
    await expect(setAutoDrivesEnabled(false)).resolves.toEqual({ state: 'disabled' });
    answer(status());
    await expect(stale).resolves.toEqual({ state: 'disabled' });
    mockRead.mockReturnValue(new Promise(() => {}));
    function Probe() {
      return <Text testID="auto">{useAutoDrives().state}</Text>;
    }
    await render(<Probe />);
    expect(screen.getByTestId('auto')).toHaveTextContent('disabled');
  });
});

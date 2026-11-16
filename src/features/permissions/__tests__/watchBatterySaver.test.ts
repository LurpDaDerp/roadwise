/**
 * Battery Saver switched while RoadWise is open (Android's quick settings leave it in front, so no
 * return to the front reads the phone): the drive detector's `batterySaver` state is what tells the
 * permission board to read again. Nothing on iOS.
 */
import { Platform } from 'react-native';

import { watchBatterySaver } from '../usePermissionBoard';

jest.mock('@/data/supabase/client', () => ({ supabase: {} }));

const mockListeners: ((e: { reason: string }) => void)[] = [];
const mockRemove = jest.fn();
jest.mock('@drive-sense', () => ({
  DriveDetect: {
    available: true,
    addListener: (event: string, fn: (e: { reason: string }) => void) => {
      if (event === 'detectState') mockListeners.push(fn);
      return { remove: mockRemove };
    },
  },
}));

afterEach(() => {
  mockListeners.length = 0;
  mockRemove.mockClear();
});

test('Android: reads again on the detector state sent for Battery Saver, never for its other states', () => {
  const os = jest.replaceProperty(Platform, 'OS', 'android');
  try {
    const onChange = jest.fn();
    const stop = watchBatterySaver(onChange);
    expect(mockListeners).toHaveLength(1);
    mockListeners[0]!({ reason: 'armed' });
    mockListeners[0]!({ reason: 'wake:app' });
    expect(onChange).not.toHaveBeenCalled();
    mockListeners[0]!({ reason: 'batterySaver' });
    expect(onChange).toHaveBeenCalledTimes(1);
    stop();
    expect(mockRemove).toHaveBeenCalledTimes(1);
  } finally {
    os.restore();
  }
});

test('iOS: nothing', () => {
  const os = jest.replaceProperty(Platform, 'OS', 'ios');
  try {
    watchBatterySaver(jest.fn())();
    expect(mockListeners).toHaveLength(0);
  } finally {
    os.restore();
  }
});

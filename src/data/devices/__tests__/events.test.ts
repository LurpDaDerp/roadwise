import { act, renderHook } from '@testing-library/react-native';

import { registerDriveStateSource, useDriveStateReported } from '../driveStateStore';
import { onDeviceSyncRequested, requestDeviceSync } from '../events';

describe('device sync requests', () => {
  it('reach every listener until it unsubscribes', () => {
    const a = jest.fn();
    const b = jest.fn();
    const offA = onDeviceSyncRequested(a);
    onDeviceSyncRequested(b);
    requestDeviceSync();
    offA();
    requestDeviceSync();
    expect(a).toHaveBeenCalledTimes(1);
    expect(b).toHaveBeenCalledTimes(2);
  });

  it('a listener that throws costs the others nothing', () => {
    const b = jest.fn();
    onDeviceSyncRequested(() => {
      throw new Error('boom');
    });
    onDeviceSyncRequested(b);
    expect(() => requestDeviceSync()).not.toThrow();
    expect(b).toHaveBeenCalled();
  });
});

describe('useDriveStateReported', () => {
  it('is false without a source, true while one is registered', async () => {
    const { result } = await renderHook(() => useDriveStateReported());
    expect(result.current).toBe(false);
    let release!: () => void;
    await act(() => {
      release = registerDriveStateSource();
    });
    expect(result.current).toBe(true);
    await act(() => release());
    expect(result.current).toBe(false);
  });

  it('counts sources, and a double release is harmless', async () => {
    const { result } = await renderHook(() => useDriveStateReported());
    let a!: () => void;
    let b!: () => void;
    await act(() => {
      a = registerDriveStateSource();
      b = registerDriveStateSource();
    });
    await act(() => {
      a();
      a();
    });
    expect(result.current).toBe(true);
    await act(() => b());
    expect(result.current).toBe(false);
  });
});

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

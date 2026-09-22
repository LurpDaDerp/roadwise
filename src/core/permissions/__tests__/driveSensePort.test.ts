import { createFakeDriveSense } from '@drive-sense';

import { createDriveSenseResolver, resolveDriveSense } from '../driveSensePort';

describe('createDriveSenseResolver', () => {
  it('is null when the native module is absent (Jest, Expo Go, web), without loading the wrapper', async () => {
    const loadWrapper = jest.fn(async () => createFakeDriveSense());
    const resolve = createDriveSenseResolver({ loadNative: async () => null, loadWrapper });
    expect(await resolve()).toBeNull();
    expect(loadWrapper).not.toHaveBeenCalled();
  });

  it('exposes isIgnoringBatteryOptimizations only when the native module has it', async () => {
    const ds = createFakeDriveSense({ platform: 'android' });
    ds.setIgnoringBatteryOptimizations(true);
    const withIt = await createDriveSenseResolver({
      loadNative: async () => ({ getState() {}, isIgnoringBatteryOptimizations() {} }),
      loadWrapper: async () => ds,
    })();
    expect(withIt?.isIgnoringBatteryOptimizations).toBeDefined();
    expect(await withIt?.isIgnoringBatteryOptimizations?.()).toBe(true);

    const without = await createDriveSenseResolver({
      loadNative: async () => ({ getState() {} }),
      loadWrapper: async () => ds,
    })();
    expect(without).not.toBeNull();
    expect(without?.isIgnoringBatteryOptimizations).toBeUndefined();
  });

  it('forwards getState and requestMotionPermission to the wrapper', async () => {
    const ds = createFakeDriveSense({ platform: 'ios' });
    const port = await createDriveSenseResolver({
      loadNative: async () => ({}),
      loadWrapper: async () => ds,
    })();
    expect((await port!.getState()).motion).toBe('undetermined');
    expect(await port!.requestMotionPermission()).toBe('granted');
    expect(ds.calls).toEqual(['requestMotionPermission']);
  });

  it('resolves once and reuses the port', async () => {
    const loadNative = jest.fn(async () => ({}));
    const resolve = createDriveSenseResolver({ loadNative, loadWrapper: async () => createFakeDriveSense() });
    const a = await resolve();
    const b = await resolve();
    expect(a).toBe(b);
    expect(loadNative).toHaveBeenCalledTimes(1);
  });

  it('a failed load is null and is retried next time', async () => {
    const loadNative = jest
      .fn<Promise<Record<string, unknown> | null>, []>()
      .mockRejectedValueOnce(new Error('import failed'))
      .mockResolvedValueOnce({});
    const resolve = createDriveSenseResolver({ loadNative, loadWrapper: async () => createFakeDriveSense() });
    expect(await resolve()).toBeNull();
    expect(await resolve()).not.toBeNull();
  });
});

describe('resolveDriveSense (default)', () => {
  it('is null under Jest, where no native DriveSense module exists', async () => {
    expect(await resolveDriveSense()).toBeNull();
  });
});

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

  it("exposes Android's getUnusedAppRestrictions only when the native module has it, refusing an answer outside the contract", async () => {
    const ds = createFakeDriveSense({ platform: 'android' });
    let answer: unknown = 'enabled';
    const native = { getState() {}, getUnusedAppRestrictions: jest.fn(async () => answer) };
    const port = await createDriveSenseResolver({ loadNative: async () => native, loadWrapper: async () => ds })();
    expect(await port?.getUnusedAppRestrictions?.()).toBe('enabled');
    answer = 'disabled';
    expect(await port?.getUnusedAppRestrictions?.()).toBe('disabled');
    answer = 42;
    await expect(port?.getUnusedAppRestrictions?.()).rejects.toThrow('unexpected answer');
    const without = await createDriveSenseResolver({ loadNative: async () => ({ getState() {} }), loadWrapper: async () => ds })();
    expect(without?.getUnusedAppRestrictions).toBeUndefined();
  });

  it("exposes Android's openUnusedAppRestrictionsSettings only when the native module has it, true only for a true answer", async () => {
    const ds = createFakeDriveSense({ platform: 'android' });
    let answer: unknown = true;
    const native = { getState() {}, openUnusedAppRestrictionsSettings: jest.fn(async () => answer) };
    const port = await createDriveSenseResolver({ loadNative: async () => native, loadWrapper: async () => ds })();
    expect(await port?.openUnusedAppRestrictionsSettings?.()).toBe(true);
    answer = false;
    expect(await port?.openUnusedAppRestrictionsSettings?.()).toBe(false);
    answer = 'yes';
    expect(await port?.openUnusedAppRestrictionsSettings?.()).toBe(false);
    expect(native.openUnusedAppRestrictionsSettings).toHaveBeenCalledTimes(3);
    const without = await createDriveSenseResolver({ loadNative: async () => ({ getState() {} }), loadWrapper: async () => ds })();
    expect(without?.openUnusedAppRestrictionsSettings).toBeUndefined();
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

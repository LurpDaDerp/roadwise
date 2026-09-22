import {
  ensureDrivePermissions,
  readLocationPermission,
  type PermissionDeps,
} from '@/features/drive/permissions';

type LocStatus = 'granted' | 'denied' | 'undetermined';

function deps(opts: {
  location: LocStatus;
  afterRequest?: LocStatus;
  motion?: 'granted' | 'denied' | 'undetermined' | 'unavailable';
  motionAnswer?: 'granted' | 'denied' | 'unavailable';
}) {
  let location = opts.location;
  const calls: string[] = [];
  const d: PermissionDeps = {
    location: {
      getForegroundPermissionsAsync: jest.fn(async () => {
        calls.push('location:get');
        return { status: location };
      }),
      requestForegroundPermissionsAsync: jest.fn(async () => {
        calls.push('location:request');
        location = opts.afterRequest ?? 'denied';
        return { status: location };
      }),
    },
    driveSense: {
      getState: jest.fn(async () => {
        calls.push('motion:get');
        return { motion: opts.motion ?? 'granted' };
      }),
      requestMotionPermission: jest.fn(async () => {
        calls.push('motion:request');
        return opts.motionAnswer ?? 'granted';
      }),
    },
  };
  return { d, calls };
}

describe('ensureDrivePermissions', () => {
  test('already granted: no prompt of any kind', async () => {
    const { d, calls } = deps({ location: 'granted', motion: 'granted' });
    await expect(ensureDrivePermissions(d)).resolves.toEqual({ location: 'granted', motion: 'granted' });
    expect(calls).toEqual(['location:get', 'motion:get']);
  });

  test('undetermined location is asked once; granted then goes on to motion', async () => {
    const { d, calls } = deps({ location: 'undetermined', afterRequest: 'granted', motion: 'undetermined' });
    await expect(ensureDrivePermissions(d)).resolves.toEqual({ location: 'granted', motion: 'granted' });
    expect(calls).toEqual(['location:get', 'location:request', 'motion:get', 'motion:request']);
  });

  test('denied location is never re-prompted and motion is not asked', async () => {
    const { d, calls } = deps({ location: 'denied' });
    await expect(ensureDrivePermissions(d)).resolves.toEqual({ location: 'denied', motion: 'undetermined' });
    expect(d.location.requestForegroundPermissionsAsync).not.toHaveBeenCalled();
    expect(calls).toEqual(['location:get']);
  });

  test('a refusal at the prompt is reported as denied; a second call does not prompt again', async () => {
    const { d } = deps({ location: 'undetermined', afterRequest: 'denied' });
    await expect(ensureDrivePermissions(d)).resolves.toMatchObject({ location: 'denied' });
    await expect(ensureDrivePermissions(d)).resolves.toMatchObject({ location: 'denied' });
    expect(d.location.requestForegroundPermissionsAsync).toHaveBeenCalledTimes(1);
  });

  test('denied motion does not block and is never re-prompted', async () => {
    const { d, calls } = deps({ location: 'granted', motion: 'denied' });
    await expect(ensureDrivePermissions(d)).resolves.toEqual({ location: 'granted', motion: 'denied' });
    expect(calls).not.toContain('motion:request');
  });

  test('a motion read that fails (no native module) counts as unavailable, not as a blocker', async () => {
    const { d } = deps({ location: 'granted' });
    (d.driveSense.getState as jest.Mock).mockRejectedValueOnce(new Error('E_UNAVAILABLE'));
    await expect(ensureDrivePermissions(d)).resolves.toEqual({ location: 'granted', motion: 'unavailable' });
  });
});

describe('readLocationPermission', () => {
  test('reads without prompting (the return-from-Settings check)', async () => {
    const { d } = deps({ location: 'undetermined' });
    await expect(readLocationPermission(d)).resolves.toBe('undetermined');
    expect(d.location.requestForegroundPermissionsAsync).not.toHaveBeenCalled();
  });
});

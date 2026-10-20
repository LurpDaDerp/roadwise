/** @jest-environment node */
import { createSqlJsDb } from '@/data/db/__fixtures__/sqljsDriver';
import { createSettingsRepo, createTripsRepo, migrate, type Db } from '@/data/db';
import { readDeviceOwner } from '@/boot/device';
import { watchDeviceOwner, type AuthWatchable } from '@/boot/ownerWatch';

let db: Db;
beforeEach(async () => {
  db = await createSqlJsDb();
  await migrate(db);
});

function fakeAuth() {
  let listener: ((event: string, session: { user: { id: string } } | null) => void) | null = null;
  const supabase: AuthWatchable = {
    auth: {
      onAuthStateChange(fn) {
        listener = fn;
        return { data: { subscription: { unsubscribe: () => (listener = null) } } };
      },
    },
  };
  const emit = async (event: string, uid: string | null) => {
    listener?.(event, uid === null ? null : { user: { id: uid } });
    for (let i = 0; i < 20; i++) await new Promise<void>((resolve) => setImmediate(resolve));
  };
  return { supabase, emit };
}

test("the owner's SIGNED_IN (and the first sign-in on an empty phone, once recorded) is announced; token refreshes, another driver and a sign-out are not", async () => {
  const { supabase, emit } = fakeAuth();
  const onOwnerSignIn = jest.fn();
  const onHandover = jest.fn();
  const stop = watchDeviceOwner(db, { supabase, onHandover, onOwnerSignIn });

  await emit('SIGNED_IN', 'user-1');
  expect(await readDeviceOwner(db)).toBe('user-1');
  expect(onOwnerSignIn).toHaveBeenCalledWith('user-1');

  await emit('TOKEN_REFRESHED', 'user-1');
  await emit('INITIAL_SESSION', 'user-1');
  await emit('SIGNED_OUT', null);
  expect(onOwnerSignIn).toHaveBeenCalledTimes(1);

  await emit('SIGNED_IN', 'user-1');
  expect(onOwnerSignIn).toHaveBeenCalledTimes(2);

  await emit('SIGNED_IN', 'user-2');
  expect(onHandover).toHaveBeenCalledWith('user-2');
  expect(onOwnerSignIn).toHaveBeenCalledTimes(2);
  stop();
});

test('an unowned phone that holds drives is a handover, not an owner sign-in', async () => {
  await createTripsRepo(db).insert({ client_trip_id: 'trip-1', started_at: 1, tz: 'UTC', status: 'scored' }, 1);
  const { supabase, emit } = fakeAuth();
  const onOwnerSignIn = jest.fn();
  const onHandover = jest.fn();
  watchDeviceOwner(db, { supabase, onHandover, onOwnerSignIn });
  await emit('SIGNED_IN', 'user-1');
  expect(onHandover).toHaveBeenCalledWith('user-1');
  expect(onOwnerSignIn).not.toHaveBeenCalled();
  expect(await createSettingsRepo(db).get('device.pendingOwner')).toBe('user-1');
});

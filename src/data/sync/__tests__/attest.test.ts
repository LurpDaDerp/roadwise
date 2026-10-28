/** @jest-environment node */
// The runner's half of App Attest: a drive upload goes as its exact JSON bytes with the App Attest
// headers over them, and an `attest_required` answer has the phone attest (silently) and send the
// drive again at once, once.
import { createSqlJsDb } from '@/data/db/__fixtures__/sqljsDriver';
import { createQueueRepo, createSettingsRepo, createTripsRepo, migrate, type Db } from '@/data/db';
import { createAppAttest, type AppAttest, type UploadProof } from '@/data/devices/appAttest';
import { createFakeSupabase, functionsHttpError, invokeOk } from '@/data/sync/__fixtures__/fakes';
import { answer, finishedDrive, speeding, T0, uuid } from '@/data/sync/__fixtures__/drives';
import { markNotDriving } from '@/data/sync/driveActions';
import { createSyncRunner } from '@/data/sync/runner';

let db: Db;
beforeEach(async () => {
  db = await createSqlJsDb();
  await migrate(db);
  await createSettingsRepo(db).set('device.lastUserId', 'user-1');
  await finishedDrive(db, uuid(10), { t0: T0, events: [speeding(uuid(510), T0)] });
});

const NOW = T0 + 2_000_000;
const runner = (supabase: ReturnType<typeof createFakeSupabase>, attest?: AppAttest) =>
  createSyncRunner({ db, supabase, mayDrain: () => true, isRecording: () => false, now: () => NOW, ...(attest ? { attest } : {}) });

const ATTEST_REQUIRED = functionsHttpError(429, { code: 'attest_required' }, { 'Retry-After': '300' });

/** An App Attest whose proofs name a key generation: `k1` until `recover` makes `k2`, and so on. */
function stubAttest(opts: { recovers?: boolean } = {}) {
  let key = 1;
  const proved: { owner: string; body: string }[] = [];
  const recovered: UploadProof[] = [];
  const attest: AppAttest = {
    async prove(owner, body) {
      proved.push({ owner, body });
      return { keyId: `k${key}`, headers: { 'x-app-attest-key': `k${key}`, 'x-app-attest-assertion': `signed-by-k${key}` } };
    },
    async recover(_owner, proof) {
      recovered.push(proof);
      if (opts.recovers === false) return false;
      key += 1;
      return true;
    },
  };
  return { attest, proved, recovered };
}

test('an upload goes as its exact JSON bytes, with the App Attest headers made over those bytes', async () => {
  const s = stubAttest();
  const supabase = createFakeSupabase({ invoke: ({ body }) => invokeOk(answer((body as { clientTripId: string }).clientTripId)) });
  const r = runner(supabase, s.attest);
  await r.start();
  expect(await r.drainOnce()).toMatchObject({ done: 1 });
  const sent = supabase.invokes[0]!;
  expect(sent.name).toBe('finalize-trip');
  expect(s.proved).toEqual([{ owner: 'user-1', body: sent.raw }]);
  expect(sent.headers).toEqual({ 'Content-Type': 'application/json', 'x-app-attest-key': 'k1', 'x-app-attest-assertion': 'signed-by-k1' });
  // the same JSON supabase-js writes for an object body
  expect(sent.raw).toBe(JSON.stringify(sent.body));
  expect(sent.body).toMatchObject({ v: 5, clientTripId: uuid(10) });
  await r.stop();
});

test('attest_required: the phone attests and sends the drive again at once; it is scored in the same pass', async () => {
  const s = stubAttest();
  const supabase = createFakeSupabase({
    invoke: (call, index) => (index === 0 ? ATTEST_REQUIRED : invokeOk(answer((call.body as { clientTripId: string }).clientTripId))),
  });
  const r = runner(supabase, s.attest);
  await r.start();
  expect(await r.drainOnce()).toMatchObject({ done: 1, failed: 0, deferred: 0 });
  expect(supabase.invokes.map((i) => i.headers?.['x-app-attest-key'])).toEqual(['k1', 'k2']);
  // the same bytes both times
  expect(supabase.invokes[1]!.raw).toBe(supabase.invokes[0]!.raw);
  expect(s.recovered).toEqual([{ keyId: 'k1', headers: { 'x-app-attest-key': 'k1', 'x-app-attest-assertion': 'signed-by-k1' } }]);
  expect(await createTripsRepo(db).get(uuid(10))).toMatchObject({ status: 'scored', sync_error: null });
  await r.stop();
});

test.each([false, true])('attest_required that attesting cannot fix now is a retry, never a refusal: the drive stays pending, nothing loops (a fresh key: %s)', async (recovers) => {
  const s = stubAttest({ recovers });
  const supabase = createFakeSupabase({ invoke: () => ATTEST_REQUIRED });
  const r = runner(supabase, s.attest);
  await r.start();
  expect(await r.drainOnce()).toMatchObject({ done: 0, failed: 0, deferred: 1 });
  // one send, or one more after a fresh key: never a third in the pass
  expect(supabase.invokes).toHaveLength(recovers ? 2 : 1);
  expect(s.recovered).toHaveLength(1);
  expect(await createTripsRepo(db).get(uuid(10))).toMatchObject({ status: 'pending', sync_error: null });
  const item = (await createQueueRepo(db).byKey(`trip:${uuid(10)}`))!;
  expect(item).toMatchObject({ status: 'pending', attempts: 1, last_error: 'attest_required' });
  expect(item.next_attempt_at).toBe(NOW + 300_000);
  await r.stop();
});

test('without App Attest (Android, tests) the upload is the same bytes with no App Attest header; a trip action is untouched', async () => {
  const supabase = createFakeSupabase({
    invoke: ({ name, body }) => {
      const b = body as { clientTripId: string };
      if (name === 'finalize-trip') return invokeOk(answer(b.clientTripId, { eventIds: [uuid(510)] }));
      return invokeOk({ tripId: uuid(77), clientTripId: b.clientTripId, notDrivingLeft: 1, rating: { safetyRating: null, ranked: false } });
    },
  });
  const r = runner(supabase);
  await r.start();
  await markNotDriving(uuid(10), { db, now: () => NOW });
  await r.drainOnce();
  expect(supabase.invokes.map((i) => i.name)).toEqual(['finalize-trip', 'trip-actions']);
  expect(supabase.invokes[0]!.headers).toEqual({ 'Content-Type': 'application/json' });
  expect(supabase.invokes[1]).toEqual({ name: 'trip-actions', body: { action: 'not_driving', clientTripId: uuid(10) } });
  await r.stop();
});

test('end to end on an iPhone: the first upload attests a key and signs; a server that refuses the key gets a fresh one and the drive', async () => {
  const keys: string[] = [];
  const native = {
    isSupported: true,
    generateKeyAsync: async () => {
      keys.push(`${String(keys.length + 1).padStart(43, 'K')}=`);
      return keys[keys.length - 1]!;
    },
    attestKeyAsync: async (keyId: string) => `att-${keyId}`,
    generateAssertionAsync: async (keyId: string, body: string) => `sig(${keyId.slice(-2)}:${body.length})`,
  };
  const items = new Map<string, string>();
  const store = { getItemAsync: async (k: string) => items.get(k) ?? null, setItemAsync: async (k: string, v: string) => void items.set(k, v) };
  let refuseFirstKey = true;
  const supabase = createFakeSupabase({
    invoke: ({ name, body, headers }) => {
      const b = body as { action?: string; clientTripId: string };
      if (name === 'app-attest') return invokeOk(b.action === 'challenge' ? { challenge: 'q6urq6urq6urq6urq6urq6urq6urq6urq6urq6urq6s' } : { status: 'attested' });
      if (refuseFirstKey && headers?.['x-app-attest-key'] === keys[0]) {
        refuseFirstKey = false;
        return ATTEST_REQUIRED;
      }
      return invokeOk(answer(b.clientTripId));
    },
  });
  const attest = createAppAttest({ platform: 'ios', native: () => native, store, invoke: (n, o) => supabase.functions.invoke(n, o), now: () => NOW });
  const r = runner(supabase, attest);
  await r.start();
  expect(await r.drainOnce()).toMatchObject({ done: 1 });
  expect(supabase.invokes.map((i) => `${i.name}${(i.body as { action?: string }).action ? ` ${(i.body as { action: string }).action}` : ''}`)).toEqual([
    'app-attest challenge',
    'app-attest attest',
    'finalize-trip',
    'app-attest challenge',
    'app-attest attest',
    'finalize-trip',
  ]);
  const uploads = supabase.invokes.filter((i) => i.name === 'finalize-trip');
  expect(uploads.map((u) => u.headers?.['x-app-attest-key'])).toEqual(keys);
  expect(uploads[1]!.headers?.['x-app-attest-assertion']).toBe(`sig(2=:${uploads[1]!.raw!.length})`);
  expect(await createTripsRepo(db).get(uuid(10))).toMatchObject({ status: 'scored' });
  await r.stop();
});

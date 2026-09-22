// Concurrency reproductions against the local stack (M2 final review, carry-over 9).
//
// EXPECTED TO FAIL UNTIL M8. These tests exist so the M8 hardening has a failing test to fix, not
// to pass today. The two writers' concurrency is documented and untested on both sides:
//
//   1. score_daily / baselines are last-writer-wins. finalize-trip reads the user's stored trips,
//      computes the day row and the long-term score in TypeScript, and hands them to apply_trip.
//      Two uploads for one user and one day that both read before either writes each compute a
//      day with only their own trip in it, and the later write stands: `trips_scored` ends at 1,
//      not 2, and the long-term score is computed over one of the two trips, not both.
//      Reproduced 2026-09-22 (M3 B4): trips_scored 1 (want 2), long-term 83 (want 86). FAILS.
//   2. The dispute allowance is checked and consumed under the `dispute_7d` rate_limits row lock
//      on READ COMMITTED. Two disputes that both pass trip-actions' allowance pre-check race into
//      record_dispute; the lock is meant to keep the allowance from being overspent. On the same
//      run this one PASSED: the lock serialises check-and-consume and each counting statement
//      takes a fresh snapshot, so exactly one dispute was accepted. It stays here as the guard
//      M8's hardening must keep green; the handler-level overshoot of the denied-dispute cap
//      (T2b security m-1) is a separate, still-untested race.
//
// Both races are forced deterministically: a barrier holds each handler at its writer call until
// the other one has also arrived, so both have read everything they are going to read.
//
// Ignored (not passed) unless RACE is set, and only ever against a local stack:
//
//   npx supabase status -o env        # SUPABASE_URL is API_URL, the key is SERVICE_ROLE_KEY
//   RACE=1 SUPABASE_URL=http://127.0.0.1:54321 SUPABASE_SERVICE_ROLE_KEY=<key> \
//     deno test --config supabase/functions/deno.json --allow-env --allow-net supabase/functions/_shared/race.test.ts
//
// It creates a throwaway auth user per test and deletes it afterwards (every table cascades from
// auth.users). It mutates the shared local database, so it counts as a stack-mutating gate.
import { assertEquals } from '@std/assert';
import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import { createActionsDb, type ActionsDb } from './actions_db.ts';
import { createDb, type Db } from './db.ts';
import { handleFinalizeTrip } from '../finalize-trip/handler.ts';
import { handleTripAction } from '../trip-actions/handler.ts';
import { longTermScore } from './scoring/index';
import { event, payload, T0, TRIP_DAY, workedExample } from './testing/fixtures.ts';
import type { FinalizeTripPayload } from './payload.ts';

const HOUR = 3_600_000;
const DAY_MS = 86_400_000;
const BARRIER_TIMEOUT_MS = 10_000;

/**
 * `deno test` runs the suite without --allow-env, where reading a variable throws (and would prompt
 * in a terminal); asking first keeps the default run silent and these tests reported as ignored.
 */
function raceEnabled(): boolean {
  if (Deno.permissions.querySync({ name: 'env', variable: 'RACE' }).state !== 'granted') return false;
  return Boolean(Deno.env.get('RACE'));
}

const silent = { warn: () => {}, error: () => {} };

function localClient(): SupabaseClient {
  const url = Deno.env.get('SUPABASE_URL') ?? '';
  const key = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? '';
  const host = url ? new URL(url).hostname : '';
  if (host !== '127.0.0.1' && host !== 'localhost') {
    throw new Error('race.test.ts runs only against a local stack (SUPABASE_URL on 127.0.0.1 or localhost)');
  }
  if (!key) throw new Error('race.test.ts needs SUPABASE_SERVICE_ROLE_KEY');
  return createClient(url, key, { auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false } });
}

async function withUser(client: SupabaseClient, fn: (userId: string) => Promise<void>): Promise<void> {
  const { data, error } = await client.auth.admin.createUser({
    email: `race-${crypto.randomUUID()}@example.com`,
    email_confirm: true,
  });
  if (error || !data.user) throw error ?? new Error('createUser returned no user');
  try {
    await fn(data.user.id);
  } finally {
    await client.auth.admin.deleteUser(data.user.id);
  }
}

/** Resolves for every caller once `n` have arrived (or the timeout passes, so a stray failure cannot hang the run). */
function barrier(n: number): () => Promise<void> {
  let arrived = 0;
  let release!: () => void;
  const gate = new Promise<void>((resolve) => (release = resolve));
  const timer = setTimeout(release, BARRIER_TIMEOUT_MS);
  return async () => {
    arrived += 1;
    if (arrived >= n) {
      clearTimeout(timer);
      release();
    }
    await gate;
  };
}

/** A consistent upload starting at `startedAt`, with its events moved along with it. */
function tripAt(startedAt: number, base: (o: Partial<FinalizeTripPayload>) => FinalizeTripPayload = payload): FinalizeTripPayload {
  const clientTripId = crypto.randomUUID();
  const template = base({});
  return base({
    clientTripId,
    startedAt,
    endedAt: startedAt + (template.endedAt - template.startedAt),
    tracePath: `${clientTripId}.bin.gz`,
    events: template.events.map((e) => event({ ...e, startedAt: startedAt + (e.startedAt - template.startedAt) })),
  });
}

const post = (body: unknown) =>
  new Request('http://local/race', {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: 'Bearer race' },
    body: JSON.stringify(body),
  });

Deno.test({
  name: 'RACE: two concurrent finalize-trip uploads for one user and day both count toward the day and the long-term score',
  ignore: !raceEnabled(),
  sanitizeOps: false,
  sanitizeResources: false,
  fn: async () => {
    const client = localClient();
    await withUser(client, async (userId) => {
      const nowMs = T0 + 2 * HOUR;
      const db = createDb(client);
      const deps = (d: Db) => ({ verifyJwt: () => Promise.resolve(userId), db: d, now: () => nowMs, log: silent });

      // Two earlier drives on days of their own, uploaded one after the other, so the long-term
      // score has the three trips and the hour of driving it needs before it is a number at all.
      for (const daysAgo of [2, 1]) {
        const res = await handleFinalizeTrip(post(tripAt(T0 - daysAgo * DAY_MS)), deps(db));
        assertEquals(res.status, 200, `seed trip ${daysAgo} days ago`);
        await res.body?.cancel();
      }

      // The race: one drive with a phone pickup (85) and one clean drive (100) on the fixture day.
      const wait = barrier(2);
      const racing: Db = { ...db, applyTrip: async (e) => (await wait(), db.applyTrip(e)) };
      const [a, b] = await Promise.all([
        handleFinalizeTrip(post(tripAt(T0)), deps(racing)),
        handleFinalizeTrip(post(tripAt(T0 + HOUR, (o) => payload({ ...o, events: [] }))), deps(racing)),
      ]);
      assertEquals([a.status, b.status], [200, 200]);
      await Promise.all([a.body?.cancel(), b.body?.cancel()]);

      const trips = await client
        .from('trips')
        .select('ended_at, score, exposure, duration_s')
        .eq('user_id', userId)
        .eq('status', 'final');
      if (trips.error) throw trips.error;
      assertEquals(trips.data.length, 4, 'all four drives are stored and scored');
      const expected = longTermScore(
        trips.data.map((t) => ({
          endedAt: Date.parse(t.ended_at),
          score: Number(t.score),
          exposure: Number(t.exposure),
          durationS: Number(t.duration_s),
        })),
        nowMs
      ).score;

      const day = await client
        .from('score_daily')
        .select('trips_scored, long_term_score')
        .eq('user_id', userId)
        .eq('day', TRIP_DAY)
        .single();
      if (day.error) throw day.error;
      assertEquals(
        { tripsScored: day.data.trips_scored, longTermScore: day.data.long_term_score },
        { tripsScored: 2, longTermScore: expected },
        'the day holds both racing drives and the long-term score is over every stored drive'
      );
    });
  },
});

Deno.test({
  name: 'RACE: two concurrent disputes cannot overspend the dispute allowance',
  ignore: !raceEnabled(),
  sanitizeOps: false,
  sanitizeResources: false,
  fn: async () => {
    const client = localClient();
    await withUser(client, async (userId) => {
      // record_dispute measures the window and the allowance against the database clock, so this
      // drive is a real one from three hours ago: three scored events, so a 30-day allowance of 1
      // (20 % of three, floored, with the floor of one).
      const nowMs = Date.now();
      const trip = tripAt(nowMs - 3 * HOUR, workedExample);
      const finalize = await handleFinalizeTrip(post(trip), {
        verifyJwt: () => Promise.resolve(userId),
        db: createDb(client),
        now: () => nowMs,
        log: silent,
      });
      assertEquals(finalize.status, 200);
      await finalize.body?.cancel();

      const db = createActionsDb(client);
      const wait = barrier(2);
      const racing: ActionsDb = {
        ...db,
        recordDispute: async (...args) => (await wait(), db.recordDispute(...args)),
      };
      const deps = { verifyJwt: () => Promise.resolve(userId), db: racing, now: () => nowMs, log: silent };
      const results = await Promise.all(
        ['p1', 's1'].map((clientEventId) =>
          handleTripAction(post({ action: 'dispute', clientEventId, reason: 'hazard' }), deps)
        )
      );
      assertEquals(results.map((r) => r.status), [200, 200]);
      await Promise.all(results.map((r) => r.body?.cancel()));

      const accepted = await client
        .from('event_disputes')
        .select('id', { count: 'exact', head: true })
        .eq('user_id', userId)
        .eq('auto_accepted', true);
      if (accepted.error) throw accepted.error;
      assertEquals(accepted.count, 1, 'exactly one of the two disputes spent the single allowance');
    });
  },
});

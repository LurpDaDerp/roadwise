/** @jest-environment node */
import { createSqlJsDb } from '@/data/db/__fixtures__/sqljsDriver';
import { migrate } from '@/data/db/migrate';
import { createSettingsRepo, type SettingsRepo } from '@/data/db/settings';
import { TERMS_VERSION } from '@/features/auth/legal';
import {
  PENDING_TERMS_KEY,
  PENDING_TERMS_TTL_MS,
  bindPendingTerms,
  clearTermsAccepted,
  flushTermsAcceptance,
  markTermsAccepted,
  startSignInVisit,
  type PendingTerms,
} from '@/features/auth/pendingConsent';

// The default RPC reaches for the app's Supabase client; nothing here may touch it.
jest.mock('@/data/supabase/client', () => ({
  supabase: new Proxy(
    {},
    {
      get: () => {
        throw new Error('the real client was used');
      },
    }
  ),
}));

const T0 = 1_760_000_000_000;
let settings: SettingsRepo;
let accept: jest.Mock<Promise<void>, [string]>;

beforeEach(async () => {
  const db = await createSqlJsDb();
  await migrate(db);
  settings = createSettingsRepo(db);
  accept = jest.fn(async (_version: string) => {});
});

const stored = () => settings.get<PendingTerms>(PENDING_TERMS_KEY);

test('a tick stores the current terms version and when, and nothing about age', async () => {
  await markTermsAccepted(settings, () => T0);
  expect(await stored()).toEqual({ version: TERMS_VERSION, at: T0 });
});

test('the signed-in account gets it once: accept_terms with the version, then marked sent', async () => {
  await markTermsAccepted(settings, () => T0);
  await bindPendingTerms(settings, 'u1');
  expect(await flushTermsAcceptance(settings, 'u1', accept, () => T0 + 1000)).toEqual({ sent: true });
  expect(accept).toHaveBeenCalledWith(TERMS_VERSION);
  expect(await stored()).toEqual({ version: TERMS_VERSION, at: T0, uid: 'u1', sent: true });

  expect(await flushTermsAcceptance(settings, 'u1', accept, () => T0 + 2000)).toEqual({ sent: false });
  expect(accept).toHaveBeenCalledTimes(1);
});

test('a failed send keeps the tick for the next launch, even past the TTL once bound', async () => {
  await markTermsAccepted(settings, () => T0);
  await bindPendingTerms(settings, 'u1');
  accept.mockRejectedValueOnce(new Error('offline'));
  await expect(flushTermsAcceptance(settings, 'u1', accept, () => T0)).rejects.toThrow('offline');
  expect((await stored())?.sent).toBeUndefined();

  const later = T0 + 3 * PENDING_TERMS_TTL_MS;
  expect(await flushTermsAcceptance(settings, 'u1', accept, () => later)).toEqual({ sent: true });
});

test('a tick bound to another account is never sent for this one, and is dropped', async () => {
  await markTermsAccepted(settings, () => T0);
  await bindPendingTerms(settings, 'u1');
  expect(await flushTermsAcceptance(settings, 'u2', accept, () => T0)).toEqual({ sent: false });
  expect(accept).not.toHaveBeenCalled();
  expect(await stored()).toBeNull();
});

test('binding: an unbound tick becomes this account’s; one bound elsewhere is dropped', async () => {
  await markTermsAccepted(settings, () => T0);
  await bindPendingTerms(settings, 'u1');
  expect((await stored())?.uid).toBe('u1');
  await bindPendingTerms(settings, 'u2');
  expect(await stored()).toBeNull();
});

test('an unbound tick older than the TTL, or from the future, is dropped unsent', async () => {
  await markTermsAccepted(settings, () => T0);
  expect(await flushTermsAcceptance(settings, 'u1', accept, () => T0 + PENDING_TERMS_TTL_MS + 1)).toEqual({
    sent: false,
  });
  await markTermsAccepted(settings, () => T0);
  expect(await flushTermsAcceptance(settings, 'u1', accept, () => T0 - 1)).toEqual({ sent: false });
  expect(accept).not.toHaveBeenCalled();
});

test('nothing stored sends nothing; a malformed value is removed', async () => {
  expect(await flushTermsAcceptance(settings, 'u1', accept)).toEqual({ sent: false });
  await settings.set(PENDING_TERMS_KEY, { version: 3 });
  expect(await flushTermsAcceptance(settings, 'u1', accept)).toEqual({ sent: false });
  expect(await stored()).toBeNull();
  expect(accept).not.toHaveBeenCalled();
});

test('a new sign-in visit drops an unbound tick, but keeps one already bound to an account', async () => {
  await markTermsAccepted(settings, () => T0);
  await startSignInVisit(settings);
  expect(await stored()).toBeNull();

  await markTermsAccepted(settings, () => T0);
  await bindPendingTerms(settings, 'u1');
  await startSignInVisit(settings);
  expect((await stored())?.uid).toBe('u1');
});

test('an untick or a sign-out clears it', async () => {
  await markTermsAccepted(settings, () => T0);
  await clearTermsAccepted(settings);
  expect(await stored()).toBeNull();
});

/** @jest-environment node */
import { createSqlJsDb } from '@/data/db/__fixtures__/sqljsDriver';
import type { Db } from '@/data/db/driver';
import { migrate } from '@/data/db/migrate';
import { createSettingsRepo, type SettingsRepo } from '@/data/db/settings';
import { DISCLAIMER_VERSION, legalState, type LegalState } from '@/features/auth/legal';
import {
  DISCLAIMER_ACK_KEY,
  PENDING_TERMS_KEY,
  flushPendingConsents,
  hasCurrentTerms,
  markTermsAccepted,
  type ConsentApi,
  type ConsentRow,
  type TermsConsent,
} from '@/features/auth/pendingConsent';

// The default API reaches for the app's Supabase client; nothing here may touch it.
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

const published: LegalState = legalState({
  onboarding: { tos_version: 't-2', privacy_version: 'p-3' },
  legal_urls: { terms: 'https://roadwise.example/terms', privacy: 'https://roadwise.example/privacy' },
});
const unpublished: LegalState = legalState({
  onboarding: { tos_version: 't-2', privacy_version: 'p-3' },
  legal_urls: { terms: 'https://roadwise.example/terms' },
});

/** A server that remembers what was recorded, so a second flush sees the first one's rows. */
function fakeServer(initial: ConsentRow[] = []) {
  const rows: ConsentRow[] = [...initial];
  const fetchConsents = jest.fn(async (_userId: string) => rows.map((r) => ({ ...r })));
  const recordConsent = jest.fn(async (_userId: string, c: TermsConsent) => {
    rows.push({ type: c.type, version: c.version, revoked_at: null });
  });
  const api: ConsentApi = { fetchConsents, recordConsent };
  return { rows, api, fetchConsents, recordConsent };
}

let db: Db;
let settings: SettingsRepo;

beforeEach(async () => {
  db = await createSqlJsDb();
  await migrate(db);
  settings = createSettingsRepo(db);
});

describe('markTermsAccepted', () => {
  test('published: keeps the accepted versions for the account, and the disclaimer acknowledgement', async () => {
    await markTermsAccepted(settings, published);
    await expect(settings.get(PENDING_TERMS_KEY)).resolves.toEqual({ tos: 't-2', privacy: 'p-3' });
    await expect(settings.get(DISCLAIMER_ACK_KEY)).resolves.toBe(DISCLAIMER_VERSION);
  });

  test('unpublished: stores the disclaimer acknowledgement only, no Terms or Privacy acceptance', async () => {
    await markTermsAccepted(settings, unpublished);
    await expect(settings.get(PENDING_TERMS_KEY)).resolves.toBeNull();
    await expect(settings.get(DISCLAIMER_ACK_KEY)).resolves.toBe(DISCLAIMER_VERSION);
  });

  test('unpublished: drops an acceptance stored while the documents were still published', async () => {
    await markTermsAccepted(settings, published);
    await markTermsAccepted(settings, unpublished);
    await expect(settings.get(PENDING_TERMS_KEY)).resolves.toBeNull();
  });
});

describe('flushPendingConsents', () => {
  test('unpublished: records nothing and asks the server nothing, even with an old acceptance stored', async () => {
    await settings.set(PENDING_TERMS_KEY, { tos: 't-2', privacy: 'p-3' });
    const { api, fetchConsents, recordConsent } = fakeServer();
    await expect(flushPendingConsents(db, 'u1', unpublished, api)).resolves.toEqual({ recorded: [] });
    expect(fetchConsents).not.toHaveBeenCalled();
    expect(recordConsent).not.toHaveBeenCalled();
  });

  test('published but never accepted on this phone: records nothing and asks nothing', async () => {
    const { api, fetchConsents, recordConsent } = fakeServer();
    await expect(flushPendingConsents(db, 'u1', published, api)).resolves.toEqual({ recorded: [] });
    expect(fetchConsents).not.toHaveBeenCalled();
    expect(recordConsent).not.toHaveBeenCalled();
  });

  test('published and accepted: records both, clears the acceptance, and flushing again is a no-op', async () => {
    await markTermsAccepted(settings, published);
    const { rows, api, fetchConsents, recordConsent } = fakeServer();

    await expect(flushPendingConsents(db, 'u1', published, api)).resolves.toEqual({
      recorded: ['tos', 'privacy'],
    });
    expect(fetchConsents).toHaveBeenCalledWith('u1');
    expect(recordConsent).toHaveBeenCalledWith('u1', { type: 'tos', version: 't-2' });
    expect(recordConsent).toHaveBeenCalledWith('u1', { type: 'privacy', version: 'p-3' });
    await expect(settings.get(PENDING_TERMS_KEY)).resolves.toBeNull();

    await expect(flushPendingConsents(db, 'u1', published, api)).resolves.toEqual({ recorded: [] });
    // Even with the acceptance stored again (ticked on a later sign-in), nothing is duplicated.
    await markTermsAccepted(settings, published);
    await expect(flushPendingConsents(db, 'u1', published, api)).resolves.toEqual({ recorded: [] });
    expect(rows).toHaveLength(2);
    await expect(settings.get(PENDING_TERMS_KEY)).resolves.toBeNull();
  });

  test('skips a consent already on the account at the current version, records the other', async () => {
    await markTermsAccepted(settings, published);
    const { api, recordConsent } = fakeServer([{ type: 'tos', version: 't-2', revoked_at: null }]);
    await expect(flushPendingConsents(db, 'u1', published, api)).resolves.toEqual({ recorded: ['privacy'] });
    expect(recordConsent).toHaveBeenCalledTimes(1);
  });

  test('an older or revoked consent on the account does not count', async () => {
    await markTermsAccepted(settings, published);
    const { api } = fakeServer([
      { type: 'tos', version: 't-1', revoked_at: null },
      { type: 'privacy', version: 'p-3', revoked_at: '2026-09-10T00:00:00Z' },
    ]);
    await expect(flushPendingConsents(db, 'u1', published, api)).resolves.toEqual({
      recorded: ['tos', 'privacy'],
    });
  });

  test('an acceptance of a version other than the one now published records nothing and is dropped', async () => {
    await settings.set(PENDING_TERMS_KEY, { tos: 't-1', privacy: 'p-3' });
    const { api, recordConsent } = fakeServer();
    await expect(flushPendingConsents(db, 'u1', published, api)).resolves.toEqual({ recorded: [] });
    expect(recordConsent).not.toHaveBeenCalled();
    await expect(settings.get(PENDING_TERMS_KEY)).resolves.toBeNull();
  });

  test('a failed write keeps the acceptance for the next flush, which does not repeat what landed', async () => {
    await markTermsAccepted(settings, published);
    const { rows, api, recordConsent } = fakeServer();
    recordConsent
      .mockImplementationOnce(async (_u: string, c: TermsConsent) => {
        rows.push({ type: c.type, version: c.version, revoked_at: null });
      })
      .mockImplementationOnce(async () => {
        throw new Error('offline');
      });

    await expect(flushPendingConsents(db, 'u1', published, api)).rejects.toThrow('offline');
    await expect(settings.get(PENDING_TERMS_KEY)).resolves.toEqual({ tos: 't-2', privacy: 'p-3' });

    await expect(flushPendingConsents(db, 'u1', published, api)).resolves.toEqual({ recorded: ['privacy'] });
    expect(rows.map((r) => r.type)).toEqual(['tos', 'privacy']);
  });

  test('a failed read records nothing and keeps the acceptance', async () => {
    await markTermsAccepted(settings, published);
    const { api, fetchConsents, recordConsent } = fakeServer();
    fetchConsents.mockRejectedValueOnce(new Error('offline'));
    await expect(flushPendingConsents(db, 'u1', published, api)).rejects.toThrow('offline');
    expect(recordConsent).not.toHaveBeenCalled();
    await expect(settings.get(PENDING_TERMS_KEY)).resolves.toEqual({ tos: 't-2', privacy: 'p-3' });
  });

  test('a stored value of the wrong shape is ignored and dropped', async () => {
    await settings.set(PENDING_TERMS_KEY, 'yes');
    const { api, recordConsent } = fakeServer();
    await expect(flushPendingConsents(db, 'u1', published, api)).resolves.toEqual({ recorded: [] });
    expect(recordConsent).not.toHaveBeenCalled();
    await expect(settings.get(PENDING_TERMS_KEY)).resolves.toBeNull();
  });
});

describe('hasCurrentTerms', () => {
  const tos: ConsentRow = { type: 'tos', version: 't-2', revoked_at: null };
  const privacy: ConsentRow = { type: 'privacy', version: 'p-3', revoked_at: null };

  test('published: both consents at the current versions, not revoked', () => {
    expect(hasCurrentTerms([tos, privacy], {}, published)).toBe(true);
    expect(hasCurrentTerms([tos], {}, published)).toBe(false);
    expect(hasCurrentTerms([tos, { ...privacy, version: 'p-2' }], {}, published)).toBe(false);
    expect(hasCurrentTerms([tos, { ...privacy, revoked_at: '2026-09-10T00:00:00Z' }], {}, published)).toBe(
      false
    );
    // An older revoked row beside a current live one still counts as current.
    expect(
      hasCurrentTerms([{ ...tos, revoked_at: '2026-09-10T00:00:00Z' }, tos, privacy], {}, published)
    ).toBe(true);
  });

  test('published: the disclaimer acknowledgement alone is not acceptance of the Terms', () => {
    expect(hasCurrentTerms([], { disclaimerAcknowledged: DISCLAIMER_VERSION }, published)).toBe(false);
  });

  test('unpublished: the current disclaimer acknowledgement, and nothing else, is enough', () => {
    expect(hasCurrentTerms([], { disclaimerAcknowledged: DISCLAIMER_VERSION }, unpublished)).toBe(true);
    expect(hasCurrentTerms([tos, privacy], {}, unpublished)).toBe(false);
    expect(hasCurrentTerms([], { disclaimerAcknowledged: '2026-01-01' }, unpublished)).toBe(false);
    expect(hasCurrentTerms([], null, unpublished)).toBe(false);
    expect(hasCurrentTerms([], undefined, unpublished)).toBe(false);
  });
});

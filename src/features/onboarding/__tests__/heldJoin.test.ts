import { createSettingsRepo, type SettingsRepo } from '@/data/db/settings';
import { createTestDb } from '@/data/queries/__fixtures__/harness';
import { readPendingHref, savePendingHref } from '@/features/auth/authGuard';

import {
  bindHeldJoin,
  HELD_JOIN_KEY,
  HELD_JOIN_TTL_MS,
  holdJoin,
  joinHrefFor,
  ONBOARDING_PENDING_HREF_KEY,
  readHeldJoin,
  restoreCarriedHeldJoin,
  takeCarriableHeldJoin,
} from '../state';

const NOW = Date.parse('2026-09-23T12:00:00Z');
const JOIN = '/join/ABCD2345';

let settings: SettingsRepo;
beforeEach(async () => {
  settings = createSettingsRepo(await createTestDb());
});

describe('joinHrefFor: the one signed-out allowlist', () => {
  test.each([
    ['/join/ABCD2345', JOIN],
    ['/join/abcd2345', JOIN],
    ['/join/abcd-2345', JOIN],
    ['/join/ABCD%202345', JOIN],
  ])('%s → %s', (input, out) => {
    expect(joinHrefFor(input)).toBe(out);
  });

  test.each([['/join/IIII1111'], ['/join/ABCD234'], ['/join/ABCD2345/x'], ['/join/ABCD2345?x=1'], ['/inbox'], ['/join/'], [42], [null], ['/join/%E0%A4%A']])(
    'not an invite link: %p',
    (input) => {
      expect(joinHrefFor(input)).toBeNull();
    }
  );
});

describe('the held invite slot', () => {
  test('held unbound, canonical, one slot: a newer link replaces it', async () => {
    expect(HELD_JOIN_KEY).toBe('auth.heldJoin');
    expect(await holdJoin(settings, '/join/abcd2345', NOW)).toBe(true);
    expect(await settings.get(HELD_JOIN_KEY)).toEqual({ href: JOIN, heldAt: NOW, uid: null });
    await holdJoin(settings, '/join/MNPQ6789', NOW + 1);
    expect(await settings.get(HELD_JOIN_KEY)).toEqual({ href: '/join/MNPQ6789', heldAt: NOW + 1, uid: null });
    expect(await holdJoin(settings, '/inbox', NOW)).toBe(false);
    expect((await settings.get<{ href: string }>(HELD_JOIN_KEY))?.href).toBe('/join/MNPQ6789');
  });

  test('24 h: live just inside, gone at the limit; a future capture is expired too', async () => {
    await holdJoin(settings, JOIN, NOW);
    expect(await readHeldJoin(settings, NOW + HELD_JOIN_TTL_MS - 1, null)).not.toBeNull();
    expect(await readHeldJoin(settings, NOW + HELD_JOIN_TTL_MS, null)).toBeNull();
    expect(await settings.get(HELD_JOIN_KEY)).toBeNull();
    await holdJoin(settings, JOIN, NOW + 60_000);
    expect(await readHeldJoin(settings, NOW, null)).toBeNull();
    expect(await settings.get(HELD_JOIN_KEY)).toBeNull();
  });

  test.each([
    ['an extra key', { href: JOIN, heldAt: NOW, uid: null, code: 'X' }],
    ['a non-canonical href', { href: '/join/abcd2345', heldAt: NOW, uid: null }],
    ['another route', { href: '/inbox', heldAt: NOW, uid: null }],
    ['a bad uid', { href: JOIN, heldAt: NOW, uid: 7 }],
    ['a bare string', JOIN],
  ])('a tampered slot (%s) reads as none and is removed', async (_name, value) => {
    await settings.set(HELD_JOIN_KEY, value);
    expect(await readHeldJoin(settings, NOW, 'u1')).toBeNull();
    expect(await settings.get(HELD_JOIN_KEY)).toBeNull();
  });

  test('binds to the first account; the same account keeps it; another account removes it', async () => {
    await holdJoin(settings, JOIN, NOW);
    expect(await bindHeldJoin(settings, 'u1', NOW)).toEqual({ href: JOIN, heldAt: NOW, uid: 'u1' });
    expect(await bindHeldJoin(settings, 'u1', NOW + 1)).toEqual({ href: JOIN, heldAt: NOW, uid: 'u1' });
    expect(await bindHeldJoin(settings, 'u2', NOW + 2)).toBeNull();
    expect(await settings.get(HELD_JOIN_KEY)).toBeNull();
  });

  test('a bound slot is never read by nobody (signed out) or by another account', async () => {
    await settings.set(HELD_JOIN_KEY, { href: JOIN, heldAt: NOW, uid: 'u1' });
    expect(await readHeldJoin(settings, NOW, null)).toBeNull();
    expect(await settings.get(HELD_JOIN_KEY)).toBeNull();
  });
});

describe('the handover carry (security R4)', () => {
  test('an unbound, live hold is carried and then bound to the incoming account', async () => {
    await holdJoin(settings, JOIN, NOW);
    const carried = await takeCarriableHeldJoin(settings, NOW + 1, 'uB');
    expect(carried).toEqual({ href: JOIN, heldAt: NOW });
    // the wipe empties settings
    await settings.remove(HELD_JOIN_KEY);
    await restoreCarriedHeldJoin(settings, carried!, 'uB');
    expect(await settings.get(HELD_JOIN_KEY)).toEqual({ href: JOIN, heldAt: NOW, uid: 'uB' });
  });

  test('one already bound to the incoming account (the gate got there first) is carried', async () => {
    await settings.set(HELD_JOIN_KEY, { href: JOIN, heldAt: NOW, uid: 'uB' });
    expect(await takeCarriableHeldJoin(settings, NOW, 'uB')).toEqual({ href: JOIN, heldAt: NOW });
  });

  test("one bound to the previous owner, an expired one, or a tampered one is never carried", async () => {
    await settings.set(HELD_JOIN_KEY, { href: JOIN, heldAt: NOW, uid: 'uA' });
    expect(await takeCarriableHeldJoin(settings, NOW, 'uB')).toBeNull();
    await settings.set(HELD_JOIN_KEY, { href: JOIN, heldAt: NOW - HELD_JOIN_TTL_MS, uid: null });
    expect(await takeCarriableHeldJoin(settings, NOW, 'uB')).toBeNull();
    await settings.set(HELD_JOIN_KEY, { href: '/inbox', heldAt: NOW, uid: null });
    expect(await takeCarriableHeldJoin(settings, NOW, 'uB')).toBeNull();
  });
});

describe("M4's onboarding hold, bound to its account (T12 r1)", () => {
  test('saved as { uid, href }, allowlisted only', async () => {
    expect(await savePendingHref(settings, '/inbox', 'u1')).toBe(true);
    expect(await settings.get(ONBOARDING_PENDING_HREF_KEY)).toEqual({ uid: 'u1', href: '/inbox' });
    expect(await savePendingHref(settings, '/settings/delete-account', 'u1')).toBe(false);
  });

  test('returned only to its account; another account gets none and the key goes', async () => {
    await savePendingHref(settings, JOIN, 'u1');
    expect(await readPendingHref(settings, 'u1')).toBe(JOIN);
    expect(await readPendingHref(settings, 'u2')).toBeNull();
    expect(await settings.get(ONBOARDING_PENDING_HREF_KEY)).toBeNull();
  });

  test('a legacy bare string, or a stored link that is no longer allowlisted, is no hold and is removed', async () => {
    await settings.set(ONBOARDING_PENDING_HREF_KEY, '/inbox');
    expect(await readPendingHref(settings, 'u1')).toBeNull();
    expect(await settings.get(ONBOARDING_PENDING_HREF_KEY)).toBeNull();
    await settings.set(ONBOARDING_PENDING_HREF_KEY, { uid: 'u1', href: '/settings/delete-account' });
    expect(await readPendingHref(settings, 'u1')).toBeNull();
    expect(await settings.get(ONBOARDING_PENDING_HREF_KEY)).toBeNull();
  });
});

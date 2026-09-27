import { saveDisplayName } from '../profile';

jest.mock('@/data/supabase/client', () => ({ supabase: {} }));

test('saves the cleaned name, then refreshes the profile', async () => {
  const update = jest.fn(async () => ({}));
  const refresh = jest.fn(async () => {});
  expect(await saveDisplayName('u1', '  Maya‮  Chen\n', { update, refresh })).toEqual({ ok: true, name: 'Maya Chen' });
  expect(update).toHaveBeenCalledWith('u1', { display_name: 'Maya Chen' });
  expect(refresh).toHaveBeenCalled();
});

test('a name longer than 40 is cut to what the server accepts', async () => {
  const update = jest.fn(async () => ({}));
  const r = await saveDisplayName('u1', 'x'.repeat(60), { update, refresh: async () => {} });
  expect(r).toEqual({ ok: true, name: 'x'.repeat(40) });
});

test('nothing but spaces or invisible characters is refused before any request', async () => {
  const update = jest.fn(async () => ({}));
  expect(await saveDisplayName('u1', ' ​\t ', { update, refresh: async () => {} })).toEqual({ ok: false, reason: 'empty' });
  expect(update).not.toHaveBeenCalled();
});

test('a write that fails says so; a refresh that fails does not undo a saved name', async () => {
  const failing = jest.fn(async () => Promise.reject(new Error('offline')));
  expect(await saveDisplayName('u1', 'Maya', { update: failing, refresh: async () => {} })).toEqual({ ok: false, reason: 'failed' });
  const refresh = jest.fn(async () => Promise.reject(new Error('timeout')));
  expect(await saveDisplayName('u1', 'Maya', { update: jest.fn(async () => ({})), refresh })).toEqual({ ok: true, name: 'Maya' });
});

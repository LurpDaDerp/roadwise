import { RpcError } from '@/data/server/rpc';

import { friendlyError, GENERIC_ERROR, isNotFound, NETWORK_ERROR } from '../errors';

jest.mock('@/data/supabase/client', () => ({ supabase: {} }));

describe('friendlyError', () => {
  it.each([
    ['too many requests', '42501', 'Slow down a little, then try again in a minute.'],
    ['username is taken', '23505', 'Someone already has that username. Try another.'],
    ['this clan is full', '42501', 'That clan is full. Clans max out at 30 drivers.'],
    ['you have reached the friend limit', '42501', "You've hit the 200-friend limit. Remove someone to add someone new."],
  ])('maps the server’s %p', (message, code, line) => {
    expect(friendlyError(new RpcError(message, code))).toBe(line);
  });

  it('says "try again" for a server error it does not know, and "connection" for no answer', () => {
    expect(friendlyError(new RpcError('something new', 'XX000'))).toBe(GENERIC_ERROR);
    expect(friendlyError(new TypeError('Network request failed'))).toBe(NETWORK_ERROR);
  });

  it('knows not found (which is also how a block looks)', () => {
    expect(isNotFound(new RpcError('profile not found', 'P0002'))).toBe(true);
    expect(isNotFound(new RpcError('too many requests', '42501'))).toBe(false);
    expect(isNotFound(new Error('profile not found'))).toBe(false);
  });
});

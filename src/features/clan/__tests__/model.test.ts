import { RpcError } from '@/data/server/rpc';

import { clanMember, myClan } from '../__fixtures__/data';
import {
  friendlyError,
  GENERIC_ERROR,
  goalProgress,
  inviteLink,
  inviteMessage,
  isValidCode,
  leaveMessage,
  manageActions,
  memberStat,
  nextLeaderAfterLeave,
  normalizeCode,
  sortMembers,
  validateClanName,
  type MemberSort,
} from '../model';

// the RPC helper loads the Supabase client, which needs env this suite doesn't have
jest.mock('@/data/supabase/client', () => ({ supabase: {} }));

describe('sortMembers', () => {
  const members = [
    clanMember('cam', { safety_rating: 91, points: 500, week_points: 20, miles_30d: 40, clean_pct: 50, streak: 2 }),
    clanMember('ana', { safety_rating: 97, points: 100, week_points: 300, miles_30d: 10, clean_pct: 100, streak: 9 }),
    clanMember('new', {
      ranked: false,
      safety_rating: 100,
      points: -20,
      week_points: 0,
      miles_30d: 3,
      clean_pct: null,
      streak: 0,
    }),
    clanMember('bea', { safety_rating: 91, points: 800, week_points: 120, miles_30d: 220, clean_pct: 80, streak: 4 }),
  ];
  const names = (key: MemberSort) => sortMembers(members, key).map((m) => m.username);

  test('Safety Rating: highest first, ties by username, unranked last', () => {
    expect(names('rating')).toEqual(['ana', 'bea', 'cam', 'new']);
  });
  test('Points (negative totals sort low)', () => expect(names('points')).toEqual(['bea', 'cam', 'ana', 'new']));
  test('This week', () => expect(names('week')).toEqual(['ana', 'bea', 'cam', 'new']));
  test('Miles', () => expect(names('miles')).toEqual(['bea', 'cam', 'ana', 'new']));
  test('Clean % (no drives last)', () => expect(names('clean')).toEqual(['ana', 'bea', 'cam', 'new']));
  test('Streak', () => expect(names('streak')).toEqual(['ana', 'bea', 'cam', 'new']));
  test('does not touch the input', () => {
    const before = members.map((m) => m.username);
    sortMembers(members, 'points');
    expect(members.map((m) => m.username)).toEqual(before);
  });
});

test('memberStat shows the sorted number and never a rating for an unranked driver', () => {
  const rookie = clanMember('rookie', { ranked: false, safety_rating: 99, clean_pct: null });
  expect(memberStat(rookie, 'rating').value).toBe('Unranked');
  expect(memberStat(rookie, 'clean')).toMatchObject({ value: '–', spoken: 'No drives in 30 days' });
  expect(memberStat(clanMember('a', { points: -1234 }), 'points')).toMatchObject({ value: '−1,234', unit: 'pts' });
  expect(memberStat(clanMember('a', { miles_30d: 1234.6 }), 'miles')).toMatchObject({ value: '1,235', unit: 'mi' });
  expect(memberStat(clanMember('a', { safety_rating: 88.04 }), 'rating').value).toBe('88.0');
});

test('goalProgress', () => {
  expect(goalProgress({ week: 'w', target_clean_miles: 500, clean_miles: 312.9 })).toEqual({
    fraction: 312 / 500,
    text: '312 / 500 clean miles this week',
    done: false,
  });
  expect(goalProgress({ week: 'w', target_clean_miles: 50, clean_miles: 75 })).toMatchObject({ fraction: 1, done: true });
  expect(goalProgress({ week: 'w', target_clean_miles: 1500, clean_miles: 0 }).text).toBe(
    '0 / 1,500 clean miles this week'
  );
});

test('validateClanName mirrors the server shape rules', () => {
  expect(validateClanName('ab')).toBe('length');
  expect(validateClanName('  ab  ')).toBe('length');
  expect(validateClanName('x'.repeat(25))).toBe('length');
  expect(validateClanName('Night Owls')).toBeNull();
  expect(validateClanName("D'Angelo's Crew")).toBeNull();
  expect(validateClanName('Team 5.')).toBeNull();
  expect(validateClanName('-dash')).toBe('characters');
  expect(validateClanName('Night  Owls')).toBe('characters');
  expect(validateClanName('emoji \u{1F697}')).toBe('characters');
  expect(validateClanName('trail_')).toBe('characters');
});

test('codes and invite links', () => {
  expect(normalizeCode(' abcd-2345 ')).toBe('ABCD2345');
  expect(normalizeCode('roadwise://clan/ABCD2345')).toBe('ABCD2345');
  expect(isValidCode('ABCD2345')).toBe(true);
  expect(isValidCode('ABCD0345')).toBe(false); // 0 is not in the alphabet
  expect(isValidCode('ABC')).toBe(false);
  expect(inviteLink('ABCD2345')).toBe('roadwise://clan/ABCD2345');
  expect(inviteMessage('Night Owls', 'ABCD2345')).toContain('roadwise://clan/ABCD2345');
});

test('manageActions mirrors the server', () => {
  expect(manageActions('leader', { role: 'member' })).toEqual(['promote', 'transfer', 'remove']);
  expect(manageActions('leader', { role: 'coleader' })).toEqual(['demote', 'transfer', 'remove']);
  expect(manageActions('coleader', { role: 'member' })).toEqual(['remove']);
  expect(manageActions('coleader', { role: 'coleader' })).toEqual([]);
  expect(manageActions('coleader', { role: 'leader' })).toEqual([]);
  expect(manageActions('member', { role: 'member' })).toEqual([]);
});

describe('leaving', () => {
  test('the longest-serving co-leader takes over, else the longest-serving member', () => {
    const c = myClan();
    expect(nextLeaderAfterLeave(c.members, 'id-me')?.username).toBe('copilot');
    const noCo = c.members.filter((m) => m.role !== 'coleader');
    expect(nextLeaderAfterLeave(noCo, 'id-me')?.username).toBe('rookie');
    expect(nextLeaderAfterLeave(c.members.slice(0, 1), 'id-me')).toBeNull();
  });

  test('the confirm text explains the hand-off', () => {
    expect(leaveMessage(myClan(), 'id-me')).toBe(
      "You're the leader. If you leave, copilot becomes the leader automatically."
    );
    expect(leaveMessage(myClan({ my_role: 'member' }), 'id-me')).toMatch(/join again/);
    const solo = myClan();
    solo.clan.member_count = 1;
    solo.members = solo.members.slice(0, 1);
    expect(leaveMessage(solo, 'id-me')).toMatch(/deleted/);
    const hidden = myClan();
    hidden.clan.member_count = 5; // two members I blocked are hidden from me
    expect(leaveMessage(hidden, 'id-me')).not.toMatch(/copilot/);
  });
});

test('friendlyError maps server messages and hides everything else', () => {
  expect(friendlyError(new RpcError('clan name is taken', '23505'))).toBe('That name is taken. Try another one.');
  expect(friendlyError(new RpcError('name must be 3 to 24 characters', '22023'))).toBe(
    "That name isn't allowed. Try another one."
  );
  expect(friendlyError(new RpcError('this clan is full', '42501'))).toMatch(/full/);
  expect(friendlyError(new RpcError('too many requests', '42501'))).toMatch(/Wait a bit/);
  expect(friendlyError(new RpcError('duplicate key value violates unique constraint "x"', '23505'))).toBe(
    GENERIC_ERROR
  );
  expect(friendlyError(new TypeError('Network request failed'))).toBe(GENERIC_ERROR);
  // a report on a clan that's gone is not a bad invite code
  expect(friendlyError(new RpcError('clan not found', 'P0002'), 'report')).toBe("That clan doesn't exist anymore.");
  expect(friendlyError(new RpcError('too many requests', '42501'), 'report')).toMatch(/Wait a bit/);
  expect(friendlyError(new RpcError('clan not found', 'P0002'))).toMatch(/with that code/);
});

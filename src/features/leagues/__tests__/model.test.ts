import type { FriendsBoardRow } from '../api';
import { percentileText, rankFriendsBoard, rankText, ratingText } from '../model';

test('ratingText never shows a number for an unranked driver', () => {
  expect(ratingText(91.73, true)).toBe('92');
  expect(ratingText(100, true)).toBe('100');
  expect(ratingText(98, false)).toBe('Unranked');
  expect(ratingText(null, true)).toBe('Unranked');
});

test('percentileText', () => {
  expect(percentileText(8)).toBe("You're in the top 8%");
});

test('rankText', () => {
  expect(rankText(1234)).toBe('#1,234');
});

describe('rankFriendsBoard', () => {
  const row = (username: string, value: number | null, ranked: boolean, rank: number): FriendsBoardRow => ({
    rank,
    user_id: username,
    username,
    level: 1,
    value,
    ranked,
    is_me: false,
  });

  test('week points keep the server order', () => {
    const rows = [row('b', 50, false, 2), row('a', 90, true, 1)];
    expect(rankFriendsBoard(rows, 'week').map((r) => [r.username, r.rank])).toEqual([
      ['a', 1],
      ['b', 2],
    ]);
  });

  test('rating: ranked first by rating, unranked after with no place', () => {
    const rows = [
      row('newbie', 99.5, false, 1),
      row('zed', 88, true, 2),
      row('amy', 92.1, true, 3),
      row('bob', 88, true, 4),
      row('nomiles', null, false, 5),
    ];
    expect(rankFriendsBoard(rows, 'rating').map((r) => [r.username, r.rank])).toEqual([
      ['amy', 1],
      ['bob', 2],
      ['zed', 3],
      ['newbie', null],
      ['nomiles', null],
    ]);
  });
});

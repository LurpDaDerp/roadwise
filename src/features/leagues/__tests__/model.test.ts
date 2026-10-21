import { friendRow } from '../__fixtures__/data';
import { rankFriendsBoard, ratingText } from '../model';

test('ratingText never shows a number for a driver without a rating', () => {
  expect(ratingText(91.73, true)).toBe('92');
  expect(ratingText(100, true)).toBe('100');
  expect(ratingText(98, false)).toBe('No rating yet');
  expect(ratingText(null, true)).toBe('No rating yet');
});

test('rankFriendsBoard: ranked first by Safety Rating (ties by name), those without a rating after with no place', () => {
  const rows = [
    friendRow('newbie', { value: 99.5, ranked: false, rank: 1 }),
    friendRow('zed', { value: 88, rank: 2 }),
    friendRow('amy', { value: 92.1, rank: 3 }),
    friendRow('bob', { value: 88, rank: 4 }),
    friendRow('nomiles', { value: null, ranked: false, rank: 5 }),
  ];
  expect(rankFriendsBoard(rows).map((r) => [r.username, r.rank])).toEqual([
    ['amy', 1],
    ['bob', 2],
    ['zed', 3],
    ['newbie', null],
    ['nomiles', null],
  ]);
});

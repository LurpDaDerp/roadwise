import { league, leagueMember as member } from '../__fixtures__/data';
import type { FriendsBoardRow } from '../api';
import {
  drivesToMoveUp,
  endsInLabel,
  formatEndsIn,
  lastResultText,
  leagueBoardItems,
  leagueZone,
  msToNextMinute,
  needsDrivesText,
  percentileText,
  previousWeekKey,
  rankFriendsBoard,
  ratingText,
} from '../model';

describe('leagueZone', () => {
  test('top 7 move up, bottom 5 of 30 move down, the rest stay', () => {
    const l = league();
    expect(leagueZone(1, l)).toBe('up');
    expect(leagueZone(7, l)).toBe('up');
    expect(leagueZone(8, l)).toBe('stay');
    expect(leagueZone(25, l)).toBe('stay');
    expect(leagueZone(26, l)).toBe('down');
    expect(leagueZone(30, l)).toBe('down');
  });

  test('nobody moves up from Diamond or down from Bronze', () => {
    expect(leagueZone(1, league({ tier: 'diamond' }))).toBe('stay');
    expect(leagueZone(30, league({ tier: 'diamond' }))).toBe('down');
    expect(leagueZone(30, league({ tier: 'bronze' }))).toBe('stay');
    expect(leagueZone(1, league({ tier: 'bronze' }))).toBe('up');
  });

  test('a small group never demotes the promotion zone', () => {
    const l = league({ size: 9 });
    expect(leagueZone(5, l)).toBe('up');
    expect(leagueZone(7, l)).toBe('up');
    expect(leagueZone(8, l)).toBe('down');
    expect(leagueZone(3, league({ size: 4 }))).toBe('up');
  });
});

describe('leagueBoardItems', () => {
  test('a "Moves up" line after rank 7 and a "Moves down" line before rank 26', () => {
    const items = leagueBoardItems(league());
    const kinds = items.map((i) => (i.kind === 'divider' ? `--${i.zone}` : i.member.rank));
    expect(kinds.slice(0, 9)).toEqual([1, 2, 3, 4, 5, 6, 7, '--up', 8]);
    expect(kinds.slice(-7)).toEqual([25, '--down', 26, 27, 28, 29, 30]);
    expect(items.filter((i) => i.kind === 'divider')).toHaveLength(2);
  });

  test('no line without rows on both sides', () => {
    const items = leagueBoardItems(league({ members: [member(1), member(2)], size: 2 }));
    expect(items.every((i) => i.kind === 'row')).toBe(true);
  });

  test('blocked members are missing but zones follow the server ranks and size', () => {
    const members = league().members.filter((m) => m.rank !== 7 && m.rank !== 26);
    const items = leagueBoardItems(league({ members }));
    const idxUp = items.findIndex((i) => i.kind === 'divider' && i.zone === 'up');
    const before = items[idxUp - 1];
    expect(before?.kind === 'row' && before.member.rank).toBe(6);
    const idxDown = items.findIndex((i) => i.kind === 'divider' && i.zone === 'down');
    const after = items[idxDown + 1];
    expect(after?.kind === 'row' && after.member.rank).toBe(27);
  });
});

test('a top spot short of the drive minimum is not shown as moving up; the line stays at rank 7', () => {
  const members = league().members.map((m) => (m.rank === 2 ? { ...m, drives: 1 } : m));
  const items = leagueBoardItems(league({ members }));
  const second = items.find((i) => i.kind === 'row' && i.member.rank === 2);
  expect(second).toMatchObject({ zone: 'stay', needs: 2 });
  const first = items.find((i) => i.kind === 'row' && i.member.rank === 1);
  expect(first).toMatchObject({ zone: 'up', needs: 0 });
  const kinds = items.map((i) => (i.kind === 'divider' ? `--${i.zone}` : i.member.rank));
  expect(kinds.slice(6, 9)).toEqual([7, '--up', 8]);
  expect(needsDrivesText(2)).toBe('needs 2 more drives');
  expect(needsDrivesText(1)).toBe('needs 1 more drive');
});

test('drivesToMoveUp', () => {
  expect(drivesToMoveUp(0, 3)).toBe(3);
  expect(drivesToMoveUp(2, 3)).toBe(1);
  expect(drivesToMoveUp(5, 3)).toBe(0);
});

describe('countdown', () => {
  const end = Date.parse('2026-10-12T04:00:00.000Z');
  const ago = (ms: number) => end - ms;
  const M = 60_000;
  const H = 60 * M;
  const D = 24 * H;

  test('days and hours, then hours and minutes, then minutes', () => {
    expect(formatEndsIn(end, ago(2 * D + 4 * H + 59 * M))).toBe('Ends in 2d 4h');
    expect(formatEndsIn(end, ago(3 * H + 12 * M + 30_000))).toBe('Ends in 3h 12m');
    expect(formatEndsIn(end, ago(5 * M + 1))).toBe('Ends in 5m');
    expect(formatEndsIn(end, ago(20_000))).toBe('Ends in 1m');
    expect(formatEndsIn(end, end)).toBe('Ending now');
    expect(formatEndsIn(end, end + H)).toBe('Ending now');
    expect(formatEndsIn(Number.NaN, end)).toBe('Ending now');
  });

  test('spoken in words', () => {
    expect(endsInLabel(end, ago(D + H))).toBe('League week ends in 1 day 1 hour');
    expect(endsInLabel(end, ago(2 * H + 3 * M))).toBe('League week ends in 2 hours 3 minutes');
  });

  test('the minute clock lands on the next whole minute', () => {
    expect(msToNextMinute(Date.parse('2026-10-05T10:00:45.000Z'))).toBe(15_000);
    expect(msToNextMinute(Date.parse('2026-10-05T10:00:00.000Z'))).toBe(60_000);
  });
});

test('ratingText never shows a number for an unranked driver', () => {
  expect(ratingText(91.73, true)).toBe('92');
  expect(ratingText(100, true)).toBe('100');
  expect(ratingText(98, false)).toBe('Unranked');
  expect(ratingText(null, true)).toBe('Unranked');
});

test('percentileText', () => {
  expect(percentileText(8)).toBe("You're in the top 8%");
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

describe('last week', () => {
  test('previousWeekKey crosses years with 52 and 53 week years', () => {
    expect(previousWeekKey('2026-W41')).toBe('2026-W40');
    expect(previousWeekKey('2026-W10')).toBe('2026-W09');
    expect(previousWeekKey('2027-W01')).toBe('2026-W53');
    expect(previousWeekKey('2026-W01')).toBe('2025-W52');
    expect(previousWeekKey('nonsense')).toBe('');
  });

  test('only last week’s result shows, in plain words', () => {
    const up = league({ last_result: { week: '2026-W40', result: 'promoted', final_rank: 3, tier: 'silver' } });
    expect(lastResultText(up)).toBe('You finished #3 last week and moved up to Gold!');
    const down = league({ last_result: { week: '2026-W40', result: 'demoted', final_rank: 28, tier: 'gold' } });
    expect(lastResultText(down)).toBe('You finished #28 last week and moved down to Silver. New week, fresh start.');
    const stay = league({ last_result: { week: '2026-W40', result: 'stayed', final_rank: 12, tier: 'gold' } });
    expect(lastResultText(stay)).toBe('You finished #12 last week and stayed in Gold.');
    const old = league({ last_result: { week: '2026-W30', result: 'promoted', final_rank: 1, tier: 'bronze' } });
    expect(lastResultText(old)).toBeNull();
    expect(lastResultText(league())).toBeNull();
  });
});

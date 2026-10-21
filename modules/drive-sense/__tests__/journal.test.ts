/** @jest-environment node */
// The row journal's format (plan §3.2) as JS reads it: each line kind parses, a torn last line and
// a seq out of order are dropped (never fatal), and anything that is not a journal line is refused.
import { journalLine, listedEnd, parseJournalLine, readJournal } from '../src/detect/journal';

const ID = '0f8fad5b-d9cb-469f-a165-70867728950e';
const start = { k: 'start', v: 1, driveId: ID, origin: 'auto', startedAt: 1_760_000_000_000, startSource: 'trace', startLat: 47.6, startLng: -122.33, continues: false, confirmedAt: 1_760_000_045_000, nativeBuild: '412' };
const row = (seq: number) => ({ k: 'row', seq, ts: 1_760_000_000_000 + seq * 1000, speed: 9, mock: false });
const end = { k: 'end', endedAt: 1_760_000_900_000, cause: 'still', decidedAt: 1_760_000_960_000, lastRowTs: 1_760_000_959_000, lastSeq: 3 };

describe('parseJournalLine', () => {
  test('reads start, row, gap and end lines', () => {
    expect(parseJournalLine(JSON.stringify(start))).toEqual(start);
    expect(parseJournalLine(JSON.stringify(row(1)))).toEqual({ k: 'row', seq: 1, row: { seq: 1, ts: 1_760_000_001_000, speed: 9, mock: false } });
    expect(parseJournalLine('{"k":"gap","from":1,"to":2}')).toEqual({ k: 'gap', from: 1, to: 2 });
    expect(parseJournalLine(JSON.stringify(end))).toEqual(end);
    expect(parseJournalLine(JSON.stringify({ ...end, cause: 'js', lastRowTs: null }))).toMatchObject({ cause: 'js', lastRowTs: null });
    expect(parseJournalLine(JSON.stringify({ ...start, origin: 'manual', startSource: 'wake', startLat: null, startLng: null }))).toMatchObject({ startLat: null });
  });

  test('refuses anything else', () => {
    for (const bad of [
      '',
      'not json',
      '{"k":"row","seq":1',
      '[]',
      'null',
      '{"k":"nope"}',
      JSON.stringify({ ...row(1), seq: 0 }),
      JSON.stringify({ ...row(1), seq: 1.5 }),
      JSON.stringify({ ...start, v: 2 }),
      JSON.stringify({ ...start, origin: 'pocket' }),
      JSON.stringify({ ...start, startSource: 'guess' }),
      JSON.stringify({ ...end, cause: 'phone' }),
      JSON.stringify({ ...end, endedAt: 1.5 }),
      '{"k":"gap","from":"1","to":2}',
    ]) {
      expect({ bad, line: parseJournalLine(bad) }).toEqual({ bad, line: null });
    }
  });
});

describe('readJournal', () => {
  test('a whole drive: the start, its rows in order with their seq, a gap and the end', () => {
    const text = [start, row(1), row(2), { k: 'gap', from: 1, to: 2 }, row(3), end].map(journalLine).join('');
    const j = readJournal(text);
    expect(j.start).toEqual(start);
    expect(j.rows.map((r) => r.seq)).toEqual([1, 2, 3]);
    expect(j.rows[0]).not.toHaveProperty('k');
    expect(j.gaps).toEqual([{ k: 'gap', from: 1, to: 2 }]);
    expect(j.end).toEqual(end);
    expect(j.dropped).toBe(0);
  });

  test('a torn last line is dropped (a power loss mid-write)', () => {
    const text = [start, row(1), row(2)].map(journalLine).join('') + '{"k":"row","seq":3,"ts":17600';
    const j = readJournal(text);
    expect(j.rows.map((r) => r.seq)).toEqual([1, 2]);
    expect(j.end).toBeNull();
    expect(j.dropped).toBe(1);
  });

  test('a seq that is not the last plus one is dropped, the rest kept', () => {
    const text = [start, row(1), row(3), row(2), row(2), row(3)].map(journalLine).join('');
    const j = readJournal(text);
    expect(j.rows.map((r) => r.seq)).toEqual([1, 2, 3]);
    expect(j.dropped).toBe(2);
  });

  test('an unreadable line in the middle is dropped; an empty file reads empty', () => {
    expect(readJournal(journalLine(start) + 'garbage\n' + journalLine(row(1))).dropped).toBe(1);
    expect(readJournal('')).toEqual({ start: null, rows: [], gaps: [], end: null, dropped: 0 });
  });

  test('a line is the JSON and a newline', () => {
    expect(journalLine({ k: 'gap', from: 1, to: 2 })).toBe('{"k":"gap","from":1,"to":2}\n');
  });
});

describe('listedEnd (what listDrives reports as the end)', () => {
  const text = (...lines: object[]) => lines.map((l) => journalLine(l as Record<string, unknown>)).join('');

  test('a file with its end line: that end, live or not', () => {
    const j = readJournal(text(start, row(1), row(2), row(3), end));
    expect(listedEnd(j, false)).toEqual({ endedAt: end.endedAt, cause: 'still', decidedAt: end.decidedAt });
    expect(listedEnd(j, true)).toEqual({ endedAt: end.endedAt, cause: 'still', decidedAt: end.decidedAt });
  });

  test('the live drive with no end: none (it still records)', () => {
    expect(listedEnd(readJournal(text(start, row(1), row(2))), true)).toBeNull();
  });

  test('an orphan (no end, not the live drive): ended as an orphan at its last row, else its start (review M6)', () => {
    expect(listedEnd(readJournal(text(start, row(1), row(2))), false)).toEqual({ endedAt: row(2).ts, cause: 'orphan', decidedAt: row(2).ts });
    expect(listedEnd(readJournal(text(start)), false)).toEqual({ endedAt: start.startedAt, cause: 'orphan', decidedAt: start.startedAt });
  });

  test('a file with no start line is never listed as anything', () => {
    expect(listedEnd(readJournal(text(row(1))), false)).toBeNull();
  });
});

describe('a resume (review M7)', () => {
  test('a gap line may carry the seq the rows go on after; anything else there is refused', () => {
    expect(parseJournalLine('{"k":"gap","from":1,"to":2,"lastSeq":1042}')).toEqual({ k: 'gap', from: 1, to: 2, lastSeq: 1042 });
    expect(parseJournalLine('{"k":"gap","from":1,"to":2}')).toEqual({ k: 'gap', from: 1, to: 2 });
    for (const bad of ['{"k":"gap","from":1,"to":2,"lastSeq":"1042"}', '{"k":"gap","from":1,"to":2,"lastSeq":-1}', '{"k":"gap","from":1,"to":2,"lastSeq":1.5}']) {
      expect({ bad, line: parseJournalLine(bad) }).toEqual({ bad, line: null });
    }
  });

  test('rows go on after the gap’s seq; a seq the gap reserved is never read', () => {
    const gap = { k: 'gap', from: 1_760_000_003_000, to: 1_760_000_100_000, lastSeq: 1003 };
    const text = [start, row(1), row(2), row(3), gap, row(4), row(1004), row(1005)].map((l) => journalLine(l as Record<string, unknown>)).join('');
    const j = readJournal(text);
    expect(j.rows.map((r) => r.seq)).toEqual([1, 2, 3, 1004, 1005]);
    expect(j.gaps).toEqual([gap]);
    expect(j.dropped).toBe(1);
  });
});

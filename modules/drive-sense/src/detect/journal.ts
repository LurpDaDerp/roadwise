// The row journal's format (plan §3.2), JS side: what `ios/RowJournal.swift` writes, one JSON object
// per `\n`-terminated line in `<Application Support>/drivesense/journal/<driveId>.ndjson`:
//
//   {"k":"start","v":1,"driveId":…,"origin":…,"startedAt":…,"startSource":…,"startLat":…,"startLng":…,"continues":…,"confirmedAt":…,"nativeBuild":…}
//   {"k":"row","seq":1, …the `row` event payload…}
//   {"k":"gap","from":…,"to":…,"lastSeq":…}           (a relaunch resumed the drive; rows go on after lastSeq)
//   {"k":"end","endedAt":…,"cause":…,"decidedAt":…,"lastRowTs":…,"lastSeq":…}
//
// `seq` starts at 1 and rises by one, except across a resume's `gap`, after which the rows go on
// from its `lastSeq` + 1. A reader drops a torn last line (no `\n`, or not JSON) and any row whose
// `seq` is not the last one plus one. A file with no `end` that is not the live drive is
// an orphan, listed as ended (`listedEnd`). Used by the fake detector, the tests and the
// diagnostics screen; native reads its own files.
import type { DriveOrigin, EndCauseNative, JournaledDrive, StartSource } from './types';

export interface JournalStart {
  k: 'start';
  v: 1;
  driveId: string;
  origin: DriveOrigin;
  startedAt: number;
  startSource: StartSource;
  startLat: number | null;
  startLng: number | null;
  continues: boolean;
  confirmedAt: number;
  nativeBuild: string;
}

/** A row line: the `row` event payload with its `seq`. */
export interface JournalRow {
  k: 'row';
  seq: number;
  row: Record<string, unknown>;
}

export interface JournalGap {
  k: 'gap';
  from: number;
  to: number;
  /**
   * The seq the resumed rows go on after (`resumeSeq`): the journal's highest plus a gap, so a row
   * JS took in that the journal lost is never reused. Absent in a gap written before it existed.
   */
  lastSeq?: number;
}

export interface JournalEnd {
  k: 'end';
  endedAt: number;
  cause: EndCauseNative | 'js';
  decidedAt: number;
  lastRowTs: number | null;
  lastSeq: number;
}

export type JournalLine = JournalStart | JournalRow | JournalGap | JournalEnd;

const isInt = (v: unknown): v is number => typeof v === 'number' && Number.isSafeInteger(v) && v >= 0;
const isNum = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);
const isNumOrNull = (v: unknown): v is number | null => v === null || isNum(v);
const ORIGINS: ReadonlySet<unknown> = new Set(['auto', 'manual']);
const SOURCES: ReadonlySet<unknown> = new Set(['trace', 'motion', 'wake']);
const CAUSES: ReadonlySet<unknown> = new Set(['still', 'walking', 'limit', 'orphan', 'cancelled', 'js']);

/** One line (without its `\n`) as a journal line, or null when it is not one. Never throws. */
export function parseJournalLine(line: string): JournalLine | null {
  let o: unknown;
  try {
    o = JSON.parse(line);
  } catch {
    return null;
  }
  if (o === null || typeof o !== 'object' || Array.isArray(o)) return null;
  const r = o as Record<string, unknown>;
  switch (r.k) {
    case 'start':
      if (
        r.v !== 1 ||
        typeof r.driveId !== 'string' ||
        !ORIGINS.has(r.origin) ||
        !isInt(r.startedAt) ||
        !SOURCES.has(r.startSource) ||
        !isNumOrNull(r.startLat) ||
        !isNumOrNull(r.startLng) ||
        typeof r.continues !== 'boolean' ||
        !isInt(r.confirmedAt) ||
        typeof r.nativeBuild !== 'string'
      ) {
        return null;
      }
      return {
        k: 'start',
        v: 1,
        driveId: r.driveId,
        origin: r.origin as DriveOrigin,
        startedAt: r.startedAt,
        startSource: r.startSource as StartSource,
        startLat: r.startLat,
        startLng: r.startLng,
        continues: r.continues,
        confirmedAt: r.confirmedAt,
        nativeBuild: r.nativeBuild,
      };
    case 'row': {
      if (!isInt(r.seq) || r.seq < 1) return null;
      const row: Record<string, unknown> = { ...r };
      delete row.k;
      return { k: 'row', seq: r.seq, row };
    }
    case 'gap':
      if (!isInt(r.from) || !isInt(r.to) || !(r.lastSeq === undefined || isInt(r.lastSeq))) return null;
      return r.lastSeq === undefined ? { k: 'gap', from: r.from, to: r.to } : { k: 'gap', from: r.from, to: r.to, lastSeq: r.lastSeq };
    case 'end':
      if (!isInt(r.endedAt) || !CAUSES.has(r.cause) || !isInt(r.decidedAt) || !(r.lastRowTs === null || isInt(r.lastRowTs)) || !isInt(r.lastSeq)) return null;
      return { k: 'end', endedAt: r.endedAt, cause: r.cause as JournalEnd['cause'], decidedAt: r.decidedAt, lastRowTs: r.lastRowTs, lastSeq: r.lastSeq };
    default:
      return null;
  }
}

export interface ReadJournal {
  start: JournalStart | null;
  /** The row payloads in order, each with its `seq`. */
  rows: Record<string, unknown>[];
  gaps: JournalGap[];
  end: JournalEnd | null;
  /** Lines dropped: torn, unreadable, or a `seq` out of order. */
  dropped: number;
}

/** A whole journal file's text, read as native reads it. Never throws. */
export function readJournal(text: string): ReadJournal {
  const out: ReadJournal = { start: null, rows: [], gaps: [], end: null, dropped: 0 };
  const parts = text.split('\n');
  // The piece after the last `\n` is empty, or a torn line.
  const torn = parts.pop();
  if (torn !== undefined && torn !== '') out.dropped += 1;
  let last = 0;
  for (const raw of parts) {
    if (raw === '') continue;
    const line = parseJournalLine(raw);
    if (line === null) {
      out.dropped += 1;
      continue;
    }
    if (line.k === 'start') out.start = out.start ?? line;
    else if (line.k === 'gap') {
      out.gaps.push(line);
      // A resume: the rows go on after its seq.
      if (line.lastSeq !== undefined && line.lastSeq > last) last = line.lastSeq;
    } else if (line.k === 'end') out.end = line;
    else if (line.seq === last + 1) {
      out.rows.push(line.row);
      last = line.seq;
    } else out.dropped += 1;
  }
  return out;
}

/**
 * A journal's end as `listDrives` reports it: its `end` line; else, for a file that is not the live
 * drive (an orphan: the state record lost that drive, so nothing would ever end it), an `orphan` end
 * at its last row (else its start), for JS to adopt and finish like any drive native ended; else
 * null (the live drive, still recording).
 */
export function listedEnd(j: ReadJournal, live: boolean): JournaledDrive['ended'] {
  if (j.end !== null) return { endedAt: j.end.endedAt, cause: j.end.cause, decidedAt: j.end.decidedAt };
  if (live || j.start === null) return null;
  const last = j.rows[j.rows.length - 1];
  const at = typeof last?.ts === 'number' ? last.ts : j.start.startedAt;
  return { endedAt: at, cause: 'orphan', decidedAt: at };
}

/** A line as native writes it: the object's JSON and `\n`. */
export const journalLine = (line: Record<string, unknown>): string => `${JSON.stringify(line)}\n`;

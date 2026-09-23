// The replay CSV, format v1 (plan Task 12): one line per frame. The frame columns are the wire's
// FRAME_FIELDS (the record's own time as `tMs` in place of `tOffMs`, no `reserved`), in wire units; an
// empty cell is "not computed" (NaN on the wire). The context columns hold the 1 Hz drive-sense row that
// applies from that frame on, forward-filled; a new row is applied when `rowTs` changes. Test tooling.
import { FLAG, FRAME_FIELDS } from '../../../../modules/dms-vision/src/constants';
import type { DmsConfig } from '../engine/config';
import type { FeatureRowLike, RowExtras } from '../engine/context';
import type { DmsEngineInit } from '../engine/engine';
import type { EngineFrame, EyeFeatures, Rotation } from '../engine/types';
import { DEFAULT_INIT, replayItems, type ReplayResult } from './run';
import type { SynthItem } from './synth';

const WIRE = FRAME_FIELDS.filter((f) => f !== 'tOffMs' && f !== 'reserved');
export const FRAME_COLUMNS = ['tMs', ...WIRE] as const;
export const CONTEXT_COLUMNS = ['rowTs', 'speed', 'course', 'gnssValid', 'aLonMax', 'aLonMin', 'aLatMax', 'aLatMin', 'yawRateMax', 'jerkMax', 'gravityStability', 'orientationDelta', 'handlingScore', 'imuMoving', 'localMinutes', 'tripElapsedS'] as const;
export const CSV_HEADER = [...FRAME_COLUMNS, ...CONTEXT_COLUMNS].join(',');

type Cells = Record<string, number | null>;

const num = (x: number | null | undefined): string => (x === null || x === undefined || !Number.isFinite(x) ? '' : String(x));

function frameCells(f: EngineFrame): Cells {
  const c: Cells = { tMs: f.tMs, face: f.face ? 1 : 0 };
  if (!f.face) {
    for (const k of WIRE) if (!(k in c)) c[k] = null;
    return { ...c, frameLuma: f.frameLuma, rotationDeg: f.rotationDeg, latLandmarkMs: 0, latTotalMs: f.latTotalMs, flags: 0 };
  }
  const eye = (e: EyeFeatures | null, s: 'R' | 'L') => ({
    [`ear${s}`]: e?.ear ?? null,
    [`eyeW${s}`]: e?.widthPx ?? null,
    [`eyeLuma${s}`]: e?.luma ?? null,
    [`irisContrast${s}`]: e?.irisContrast ?? null,
    [`eyeSat${s}`]: e?.sat ?? null,
    [`irisOx${s}`]: e?.ox ?? null,
    [`irisOy${s}`]: e?.oy ?? null,
    [`irisIn${s}`]: e === null ? 0 : e.irisIn ? 1 : 0,
  });
  const flags = (f.net !== null ? FLAG.NET_RAN : 0) | (f.eyeR === null ? FLAG.EYE_CLIPPED_R : 0) | (f.eyeL === null ? FLAG.EYE_CLIPPED_L : 0) | (f.mouth === null ? FLAG.MOUTH_CLIPPED : 0) | (f.head === null ? FLAG.POSE_MISSING : 0);
  return {
    ...c,
    boxCx: f.box?.cx ?? null,
    boxCy: f.box?.cy ?? null,
    boxW: f.box?.w ?? null,
    boxH: f.box?.h ?? null,
    iod: f.iod,
    headYaw: f.head?.yaw ?? null,
    headPitch: f.head?.pitch ?? null,
    headRoll: f.head?.roll ?? null,
    netYaw: f.net?.yaw ?? null,
    netPitch: f.net?.pitch ?? null,
    ...eye(f.eyeR, 'R'),
    ...eye(f.eyeL, 'L'),
    faceLuma: f.faceLuma,
    blur: f.blur,
    mar: f.mouth?.mar ?? null,
    mouthW: f.mouth?.widthIod ?? null,
    frameLuma: f.frameLuma,
    rotationDeg: f.rotationDeg,
    latLandmarkMs: 0,
    latTotalMs: f.latTotalMs,
    flags,
  };
}

function cellsFrame(c: Cells): EngineFrame {
  const v = (k: string) => c[k] ?? null;
  const flags = v('flags') ?? 0;
  const base = { tMs: v('tMs')!, frameLuma: v('frameLuma')!, rotationDeg: v('rotationDeg') as Rotation, latTotalMs: v('latTotalMs')! };
  if (v('face') !== 1) return { ...base, face: false, box: null, iod: null, head: null, net: null, eyeR: null, eyeL: null, faceLuma: null, blur: null, mouth: null };
  const eye = (s: 'R' | 'L', clipped: number): EyeFeatures | null =>
    (flags & clipped) !== 0
      ? null
      : { ear: v(`ear${s}`)!, widthPx: v(`eyeW${s}`)!, luma: v(`eyeLuma${s}`)!, irisContrast: v(`irisContrast${s}`)!, sat: v(`eyeSat${s}`)!, ox: v(`irisOx${s}`)!, oy: v(`irisOy${s}`)!, irisIn: v(`irisIn${s}`) === 1 };
  return {
    ...base,
    face: true,
    box: { cx: v('boxCx')!, cy: v('boxCy')!, w: v('boxW')!, h: v('boxH')! },
    iod: v('iod'),
    head: (flags & FLAG.POSE_MISSING) !== 0 ? null : { yaw: v('headYaw')!, pitch: v('headPitch')!, roll: v('headRoll')! },
    net: (flags & FLAG.NET_RAN) !== 0 ? { yaw: v('netYaw')!, pitch: v('netPitch')! } : null,
    eyeR: eye('R', FLAG.EYE_CLIPPED_R),
    eyeL: eye('L', FLAG.EYE_CLIPPED_L),
    faceLuma: v('faceLuma'),
    blur: v('blur'),
    mouth: (flags & FLAG.MOUTH_CLIPPED) !== 0 ? null : { mar: v('mar')!, widthIod: v('mouthW')! },
  };
}

function rowCells(r: { row: FeatureRowLike; ex: RowExtras } | null): Cells {
  if (r === null) return Object.fromEntries(CONTEXT_COLUMNS.map((k) => [k, null]));
  const { row, ex } = r;
  return {
    rowTs: row.ts,
    speed: row.speed,
    course: row.course,
    gnssValid: row.gnssValid ? 1 : 0,
    aLonMax: row.aLonMax,
    aLonMin: row.aLonMin,
    aLatMax: row.aLatMax,
    aLatMin: row.aLatMin,
    yawRateMax: row.yawRateMax,
    jerkMax: row.jerkMax,
    gravityStability: row.gravityStability,
    orientationDelta: row.orientationDelta,
    handlingScore: row.handlingScore,
    imuMoving: ex.imuMoving ? 1 : 0,
    localMinutes: ex.localMinutes,
    tripElapsedS: ex.tripElapsedS,
  };
}

function cellsRow(c: Cells): { row: FeatureRowLike; ex: RowExtras } {
  const v = (k: string) => c[k] ?? 0;
  return {
    row: {
      ts: v('rowTs'),
      speed: v('speed'),
      course: v('course'),
      gnssValid: v('gnssValid') === 1,
      aLonMax: v('aLonMax'),
      aLonMin: v('aLonMin'),
      aLatMax: v('aLatMax'),
      aLatMin: v('aLatMin'),
      yawRateMax: v('yawRateMax'),
      jerkMax: v('jerkMax'),
      gravityStability: v('gravityStability'),
      orientationDelta: v('orientationDelta'),
      handlingScore: v('handlingScore'),
    },
    ex: { imuMoving: v('imuMoving') === 1, localMinutes: c.localMinutes ?? null, tripElapsedS: v('tripElapsedS') },
  };
}

/** Frames and rows → CSV text (the context columns forward-filled). */
export function toCsv(items: readonly SynthItem[]): string {
  const lines = [CSV_HEADER];
  let row: { row: FeatureRowLike; ex: RowExtras } | null = null;
  for (const it of items) {
    if (it.row !== undefined) row = it.row;
    const c = { ...frameCells(it.frame), ...rowCells(row) };
    lines.push([...FRAME_COLUMNS, ...CONTEXT_COLUMNS].map((k) => num(c[k])).join(','));
  }
  return lines.join('\n') + '\n';
}

/** CSV text → frames and rows (a row wherever `rowTs` changes). Throws on a header mismatch. */
export function parseCsv(text: string): SynthItem[] {
  const lines = text.split(/\r?\n/).filter((l) => l.length > 0);
  if (lines[0] !== CSV_HEADER) throw new Error('replay csv: unexpected header (format v1)');
  const cols = lines[0]!.split(',');
  const out: SynthItem[] = [];
  let lastTs: number | null = null;
  for (const line of lines.slice(1)) {
    const cells = line.split(',');
    if (cells.length !== cols.length) throw new Error('replay csv: wrong column count');
    const c: Cells = {};
    cols.forEach((k, i) => (c[k] = cells[i] === '' ? null : Number(cells[i])));
    const item: SynthItem = { frame: cellsFrame(c) };
    if (c.rowTs !== null && c.rowTs !== lastTs) {
      item.row = cellsRow(c);
      lastTs = c.rowTs ?? null;
    }
    out.push(item);
  }
  return out;
}

/** Replays a CSV through the engine: events, commands and the summary. */
export function replayCsv(text: string, cfg: DmsConfig, init: DmsEngineInit = DEFAULT_INIT): ReplayResult {
  return replayItems(parseCsv(text), cfg, init);
}

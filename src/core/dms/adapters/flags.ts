// The payload's DMS flags (plan §3 `dmsOn`, `dmsFaceSeen`; product spec v3 "DMS on = 1.25× gains", "Wasn't
// driving … can't be used on a drive where DMS saw a face in the driver's seat"). Both are shares of the drive's
// MOVING time (rows at or above 5 mph), so turning DMS on with the camera covered claims nothing:
// - `dmsOn`: DMS was on for the drive AND a face was tracked for at least 80 % of the moving time;
// - `dmsFaceSeen`: a face was tracked in the driver's seat for at least 50 % of the moving time.
// Pure; the drive engine's finalize calls it with the session's counters.

export const DMS_ON_MIN_FACE_SHARE = 0.8;
export const DMS_FACE_SEEN_MIN_SHARE = 0.5;

export interface DmsFlagInputs {
  /** DMS was on for the drive (the Start tap's `dmsOn`). */
  dmsOn: boolean;
  /** rows with a known speed at or above 5 mph */
  movingRows: number;
  /** of those, the rows on which the DMS tracked a face in the driver's seat */
  dmsFaceRows: number;
}

/** The share of the moving time a face was tracked, 0..1 (0 with no moving rows). */
export function faceShare(s: Pick<DmsFlagInputs, 'movingRows' | 'dmsFaceRows'>): number {
  if (!(s.movingRows > 0)) return 0;
  return Math.max(0, Math.min(1, s.dmsFaceRows / s.movingRows));
}

export function dmsPayloadFlags(s: DmsFlagInputs): { dmsOn: boolean; dmsFaceSeen: boolean } {
  const share = faceShare(s);
  return { dmsOn: s.dmsOn && share >= DMS_ON_MIN_FACE_SHARE, dmsFaceSeen: share >= DMS_FACE_SEEN_MIN_SHARE };
}

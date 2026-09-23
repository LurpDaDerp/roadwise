// The Android focal length for the gaze net's camera context (plan rev1: m11), ported to
// android/.../Focal.kt and pinned by the `focal-android` vector. `focalScale` = fx / upright width.
// - From the camera characteristics (LENS_INFO_AVAILABLE_FOCAL_LENGTHS[0], SENSOR_INFO_PHYSICAL_SIZE,
//   SENSOR_INFO_PIXEL_ARRAY_SIZE, SENSOR_INFO_ACTIVE_ARRAY_SIZE) by the AOSP centred-crop rule: the
//   stream is a centred crop of the active array with the stream's aspect ratio, and
//   fx = focal_mm · outWidth / cropWidth_mm.
// - Otherwise from a 70° horizontal field of view over the buffer width (square pixels).
// It feeds only the gaze net (internal builds). iOS takes fx from the sample's intrinsic matrix and
// answers `skipped` for this vector.

export interface SensorGeometry {
  focalLengthMm: number;
  physicalWidthMm: number;
  physicalHeightMm: number;
  pixelArrayWidth: number;
  pixelArrayHeight: number;
  activeWidth: number;
  activeHeight: number;
}

export const DEFAULT_HFOV_DEG = 70;

/** [fx, fy] of a `width` × `height` buffer, or null when a field is missing or unusable. */
export function focalFromSensor(s: SensorGeometry | null, width: number, height: number): [number, number] | null {
  if (s === null || width <= 0 || height <= 0) return null;
  if (!(s.focalLengthMm > 0) || !(s.physicalWidthMm > 0) || !(s.physicalHeightMm > 0)) return null;
  if (s.pixelArrayWidth <= 0 || s.pixelArrayHeight <= 0 || s.activeWidth <= 0 || s.activeHeight <= 0) return null;
  const activeWidthMm = s.activeWidth * (s.physicalWidthMm / s.pixelArrayWidth);
  const activeHeightMm = s.activeHeight * (s.physicalHeightMm / s.pixelArrayHeight);
  const outAspect = width / height;
  const activeAspect = activeWidthMm / activeHeightMm;
  let cropWidthMm: number;
  let cropHeightMm: number;
  if (outAspect > activeAspect) {
    cropWidthMm = activeWidthMm;
    cropHeightMm = activeWidthMm / outAspect;
  } else {
    cropHeightMm = activeHeightMm;
    cropWidthMm = activeHeightMm * outAspect;
  }
  const fx = (s.focalLengthMm * width) / cropWidthMm;
  const fy = (s.focalLengthMm * height) / cropHeightMm;
  if (!Number.isFinite(fx) || !Number.isFinite(fy) || fx <= 1 || fy <= 1) return null;
  return [fx, fy];
}

/** fx / upright width: the sensor's focal lengths, else the field of view. */
export function focalScale(s: SensorGeometry | null, width: number, height: number, rotationDeg: number): number {
  const swapped = rotationDeg % 180 !== 0;
  const uprightWidth = swapped ? height : width;
  if (uprightWidth <= 0) return 0;
  const f = focalFromSensor(s, width, height);
  if (f !== null) return (swapped ? f[1] : f[0]) / uprightWidth;
  const fxBuffer = width / (2 * Math.tan((DEFAULT_HFOV_DEG * Math.PI) / 360));
  return fxBuffer / uprightWidth;
}

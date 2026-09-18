'use strict';
/**
 * The camera metadata carried by every landmark frame (`focalScale`, `isMirrored`,
 * `orientation`, `intrinsicsSource`) and the decision of what to adopt from it.
 *
 * Why this is a module and not three lines in the hook: both native layers report a PLACEHOLDER
 * for the intrinsics until a frame has actually been processed (iOS `focalScale: 0`, Android
 * `0.714` on a 1x1 buffer), and the rule engine is built from these values - a latched
 * placeholder silently runs the whole drive on the wrong focal length and, worse, on the wrong
 * `image_right_is_driver_left`, which mirrors every asymmetric zone
 * (docs/dms/DETECTION_DESIGN.md §2, §4).  The natives now report `null` until the first frame;
 * this helper additionally adopts a LATER value that disagrees with the cached one, so a wrong
 * first read (or a camera that reports its true intrinsics only after a few frames) is corrected
 * and the engine is rebuilt exactly once per change.
 *
 * Pure and device free: `node --test` covers it.
 */

/** A relative change larger than this makes the focal scale worth a rebuild. */
const FOCAL_REL_TOL = 0.01;

/** The starting cache: nothing is known until a frame says so. */
function emptyFrameMeta() {
  return { focalScale: null, isMirrored: null, orientation: null, intrinsicsSource: 'default' };
}

function usableFocal(value) {
  return Number.isFinite(value) && value > 0;
}

/**
 * What a frame's metadata changes in the cached metadata.
 *
 * @param {object} cached  the current `{focalScale, isMirrored, orientation, intrinsicsSource}`
 * @param {object} frame   a landmark frame (or the `getIntrinsics()` report)
 * @returns {{focalScale:number|null, isMirrored:boolean|null, orientation:string|null,
 *            intrinsicsSource:string, focalChanged:boolean, mirrorChanged:boolean,
 *            orientationChanged:boolean, firstOrientation:boolean, rebuild:boolean}}
 *   `rebuild` is true when the rule engine must be rebuilt (the focal scale or the mirror flag
 *   moved); `firstOrientation` is true the first time an orientation is seen at all.
 */
function decideFrameMeta(cached, frame) {
  const prev = cached || emptyFrameMeta();
  const f = frame || {};

  // --- focal scale: adopt when the cache holds no usable value or the frame disagrees by > 1 %
  let focalScale = prev.focalScale;
  let focalChanged = false;
  if (usableFocal(f.focalScale)) {
    if (!usableFocal(focalScale)) {
      focalScale = f.focalScale;
      focalChanged = true;
    } else if (Math.abs(f.focalScale - focalScale) > FOCAL_REL_TOL * Math.abs(focalScale)) {
      focalScale = f.focalScale;
      focalChanged = true;
    }
  }

  // --- mirror flag: adopt when the cache holds no boolean or the frame disagrees
  let isMirrored = typeof prev.isMirrored === 'boolean' ? prev.isMirrored : null;
  let mirrorChanged = false;
  if (typeof f.isMirrored === 'boolean' && f.isMirrored !== isMirrored) {
    isMirrored = f.isMirrored;
    mirrorChanged = true;
  }

  // --- orientation: the mount; a change re-validates the forward reference (§9)
  let orientation = prev.orientation || null;
  let orientationChanged = false;
  let firstOrientation = false;
  if (typeof f.orientation === 'string' && f.orientation && f.orientation !== orientation) {
    firstOrientation = orientation === null;
    orientation = f.orientation;
    orientationChanged = true;
  }

  const intrinsicsSource = typeof f.intrinsicsSource === 'string' && f.intrinsicsSource
    ? f.intrinsicsSource : (prev.intrinsicsSource || 'default');

  return {
    focalScale,
    isMirrored,
    orientation,
    intrinsicsSource,
    focalChanged,
    mirrorChanged,
    orientationChanged,
    firstOrientation,
    rebuild: focalChanged || mirrorChanged,
  };
}

/** Applies `decideFrameMeta` in place and returns the decision. */
function adoptFrameMeta(cached, frame) {
  const decision = decideFrameMeta(cached, frame);
  cached.focalScale = decision.focalScale;
  cached.isMirrored = decision.isMirrored;
  cached.orientation = decision.orientation;
  cached.intrinsicsSource = decision.intrinsicsSource;
  return decision;
}

module.exports = { FOCAL_REL_TOL, emptyFrameMeta, decideFrameMeta, adoptFrameMeta };

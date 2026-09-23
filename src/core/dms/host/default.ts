// The controller on the real native module (security T14 m-1). This file binds the DmsVision wrapper inside
// host/**, so M7 (and the dev diagnostics route) never import it or hold it: the wrapper's own start and
// setPolicy take a plain string token, and only the host's typed seam (gatedNative) requires a GateToken.
// Tests build createDmsController with the fake instead.
//
// One native owner (T15 r2 seat m1): the camera module is one per process, so every default controller
// shares one slot. A controller acquires it before its first native call of a drive and releases it at the
// drive's end and on dispose; another controller whose gate would open meanwhile stays closed (`busy`) and
// makes no native call. This is what keeps the dev panel from driving the camera under M7's drive.
import DmsVision from '../../../../modules/dms-vision';
import { createDmsController, type DmsController, type DmsControllerDeps, type DmsNativeOwner } from './controller';
import { createShadowComparator, type DmsShadowComparator, type DmsShadowOptions } from './shadow';

/** Everything the controller needs but the native module and its owner slot, which this binding supplies. */
export type DmsDefaultControllerDeps = Omit<DmsControllerDeps, 'native' | 'owner'>;

let holder: object | null = null;

function ownerFor(id: object): DmsNativeOwner {
  return {
    acquire() {
      if (holder === null) holder = id;
      return holder === id;
    },
    release() {
      if (holder === id) holder = null;
    },
  };
}

export function createDefaultDmsController(deps: DmsDefaultControllerDeps): DmsController {
  return createDmsController({ ...deps, native: DmsVision, owner: ownerFor({}) });
}

/**
 * The dev panel's shadow comparator on the real module (plan Task 16). It is handed `addListener` alone, never
 * the module (T16 r3, security m-2), and `opts.active` says when its paired controller owns the camera.
 */
export function createDefaultShadowComparator(opts: DmsShadowOptions = {}): DmsShadowComparator {
  return createShadowComparator({ addListener: DmsVision.addListener.bind(DmsVision) }, opts);
}

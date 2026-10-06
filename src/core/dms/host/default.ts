// The controller on the real native module (security T14 m-1). This file binds the DmsVision wrapper inside
// host/**, so the camera bridge never imports it or holds it: the wrapper's own start and setPolicy take a
// plain string token, and only the host's typed seam (gatedNative) requires a GateToken. Tests build
// createDmsController with the fake instead.
//
// One native owner (T15 r2 seat m1): the camera module is one per process, so every default controller
// shares one slot. A controller acquires it before its first native call of a drive and releases it at the
// drive's end and on dispose; another controller whose gate would open meanwhile stays closed (`busy`) and
// makes no native call.
import DmsVision from '../../../../modules/dms-vision';
import { createDmsController, type DmsController, type DmsControllerDeps, type DmsNativeOwner } from './controller';

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

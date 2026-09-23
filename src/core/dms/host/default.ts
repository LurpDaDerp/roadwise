// The controller on the real native module (security T14 m-1). This file binds the DmsVision wrapper inside
// host/**, so M7 (and the dev diagnostics route) never import it or hold it: the wrapper's own start and
// setPolicy take a plain string token, and only the host's typed seam (gatedNative) requires a GateToken.
// Tests build createDmsController with the fake instead.
import DmsVision from '../../../../modules/dms-vision';
import { createDmsController, type DmsController, type DmsControllerDeps } from './controller';

/** Everything the controller needs but the native module, which this binding supplies. */
export type DmsDefaultControllerDeps = Omit<DmsControllerDeps, 'native'>;

export function createDefaultDmsController(deps: DmsDefaultControllerDeps): DmsController {
  return createDmsController({ ...deps, native: DmsVision });
}

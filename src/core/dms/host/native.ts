// The host's native seam (plan rev1 S-M1; security T13 I-1). The module's own types take a plain string
// token (the module may not import from src/core); here start and setPolicy take a GateToken, which only
// the gate can mint, so a forged string does not type-check where the camera is started or driven.
import type { CapturePolicy, DmsVisionApi, StartOptions } from '../../../../modules/dms-vision/src/types';
import type { GateToken } from '../policy/gate';

export type GatedStart = Omit<StartOptions, 'gateToken'> & { gateToken: GateToken };
export type GatedPolicy = Omit<CapturePolicy, 'gateToken'> & { gateToken: GateToken };

export interface GatedNative {
  start(o: GatedStart): Promise<void>;
  setPolicy(p: GatedPolicy): Promise<void>;
  stop(): Promise<void>;
}

export function gatedNative(api: DmsVisionApi): GatedNative {
  return {
    start: (o) => api.start(o),
    setPolicy: (p) => api.setPolicy(p),
    stop: () => api.stop(),
  };
}

// The fail-closed privacy gate (plan Global Constraints "Privacy (hard)", Task 13; rev1 S-M1, S-M4).
// The camera may run only while all eight inputs hold: opted in, the remote `camera_beta` flag on, the
// age band 18_plus, a drive active, mounted mode, the driver role, the app active, and the camera
// permission granted. A missing or unknown input closes it.
//
// The remote flag is read at drive start only (driveActive false → true): a withdrawn flag takes effect at
// the next drive, never mid-drive. Every user or OS input applies on the next evaluation.
//
// The GateToken the native module requires on `start` and `setPolicy` is minted only here, from an
// injected random source, on each closed → open edge, and kept while the gate stays open. Nothing else can
// construct one: it is a branded string whose brand is not exported.

declare const gateTokenBrand: unique symbol;
export type GateToken = string & { readonly [gateTokenBrand]: true };

export type AgeBand = '18_plus' | 'other' | 'unknown';
export type PermissionStatus = 'granted' | 'denied' | 'undetermined';

export interface DmsGate {
  optedIn: boolean;
  cameraBeta: boolean;
  ageBand: AgeBand;
  driveActive: boolean;
  mode: 'mounted' | 'pocket' | 'auto';
  role: 'driver' | 'passenger' | 'unknown';
  appActive: boolean;
}

export type GateClosedReason = 'not_opted_in' | 'flag_off' | 'age' | 'no_drive' | 'mode' | 'role' | 'app_inactive' | 'permission';

export type GateResult = { open: true; token: GateToken } | { open: false; reason: GateClosedReason };

/** The first input that closes the gate (in this fixed order), or null when every input holds. */
export function gateClosedReason(g: DmsGate, permission: PermissionStatus, cameraBeta: boolean = g.cameraBeta): GateClosedReason | null {
  if (g.optedIn !== true) return 'not_opted_in';
  if (cameraBeta !== true) return 'flag_off';
  if (g.ageBand !== '18_plus') return 'age';
  if (g.driveActive !== true) return 'no_drive';
  if (g.mode !== 'mounted') return 'mode';
  if (g.role !== 'driver') return 'role';
  if (g.appActive !== true) return 'app_inactive';
  if (permission !== 'granted') return 'permission';
  return null;
}

/** The stateful gate: the flag latched at each drive start, and the session's token. */
export function createGate(random: () => string) {
  let driveWasActive = false;
  let latchedBeta = false;
  let token: GateToken | null = null;

  return {
    gateOpen(g: DmsGate, permission: PermissionStatus): GateResult {
      // The remote flag is read only on the drive-start edge.
      if (g.driveActive && !driveWasActive) latchedBeta = g.cameraBeta;
      driveWasActive = g.driveActive;
      const reason = gateClosedReason(g, permission, latchedBeta);
      if (reason !== null) {
        token = null;
        return { open: false, reason };
      }
      if (token === null) {
        const nonce = random();
        if (typeof nonce !== 'string' || nonce.length === 0) throw new Error('gate: the random source gave an empty nonce');
        token = nonce as GateToken;
      }
      return { open: true, token };
    },
  };
}

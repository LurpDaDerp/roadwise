// The fail-closed privacy gate (product spec v3 "Rules against false positives", DMS; plan §10 `dms.enabled`).
// The camera may run only while every input holds: DMS enabled for this drive (or the setup session), a
// drive (or the setup) active, the app in front, and the camera permission granted. A missing or unknown
// input closes it. Every input applies on the next evaluation: turning DMS off, the drive ending or the
// app leaving the front stops the camera at once.
//
// v3 removed the adult-only band and the remote beta flag (plan §1.9): DMS is available to every user,
// off by default, and the user's own switch is the only consent.
//
// The GateToken the native module requires on `start` and `setPolicy` is minted only here, from an
// injected random source, on each closed → open edge, and kept while the gate stays open. Nothing else can
// construct one: it is a branded string whose brand is not exported.

declare const gateTokenBrand: unique symbol;
export type GateToken = string & { readonly [gateTokenBrand]: true };

export type PermissionStatus = 'granted' | 'denied' | 'undetermined';

export interface DmsGate {
  /** DMS is on for this drive (the Start tap's `dmsOn`), or the setup session is running. */
  enabled: boolean;
  /** A drive is recording, or the setup session is running. */
  driveActive: boolean;
  appActive: boolean;
}

export type GateClosedReason = 'disabled' | 'no_drive' | 'app_inactive' | 'permission';

export type GateResult = { open: true; token: GateToken } | { open: false; reason: GateClosedReason };

/** The first input that closes the gate (in this fixed order), or null when every input holds. */
export function gateClosedReason(g: DmsGate, permission: PermissionStatus): GateClosedReason | null {
  if (g.enabled !== true) return 'disabled';
  if (g.driveActive !== true) return 'no_drive';
  if (g.appActive !== true) return 'app_inactive';
  if (permission !== 'granted') return 'permission';
  return null;
}

/** The stateful gate: the session's token. */
export function createGate(random: () => string) {
  let token: GateToken | null = null;

  /** The closing input; a closed gate forgets its token. Mints nothing. */
  function check(g: DmsGate, permission: PermissionStatus): GateClosedReason | null {
    const reason = gateClosedReason(g, permission);
    if (reason !== null) token = null;
    return reason;
  }

  return {
    /**
     * The same evaluation without a mint: the host's pre-check before any native call (the permission is
     * read from native only when every other input holds).
     */
    check,
    gateOpen(g: DmsGate, permission: PermissionStatus): GateResult {
      const reason = check(g, permission);
      if (reason !== null) return { open: false, reason };
      if (token === null) {
        const nonce = random();
        if (typeof nonce !== 'string' || nonce.length === 0) throw new Error('gate: the random source gave an empty nonce');
        token = nonce as GateToken;
      }
      return { open: true, token };
    },
  };
}

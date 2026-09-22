// What the phone reports in `devices.permissions` (Task 10 writes it; migration 0007's lapse
// trigger reads `location`, `motion`, `reportedFrom` and `ack`). Small by construction: at most
// nine scalar fields, far under the column's 2048-byte limit.
import type { PermissionSnapshot, ReportedFrom, ServerPermissions } from './types';

export function toServerPermissions(
  s: PermissionSnapshot,
  reportedFrom: ReportedFrom,
  ack = false,
  alwaysExcused = false
): ServerPermissions {
  return {
    v: 1,
    location: s.location,
    precise: s.precise,
    // A motion state that could not be checked is left out: a missing key is unknown, never a lapse.
    ...(s.motion === null ? {} : { motion: s.motion }),
    notifications: s.notifications,
    batteryOptimization: s.batteryOptimization,
    reportedFrom,
    ack,
    alwaysExcused,
    checkedAt: new Date(s.checkedAt).toISOString(),
  };
}

type Fingerprinted = Pick<
  PermissionSnapshot,
  'location' | 'precise' | 'notifications' | 'batteryOptimization'
> & { motion?: PermissionSnapshot['motion']; alwaysExcused?: boolean };

/**
 * A stable key over the reported permission states only — not the time, Low Power Mode,
 * can-ask-again, `reportedFrom` or `ack` — so a report is sent only when a permission changed, or
 * when whether losing Always is excused changed (final review I4: the server must know before the
 * next Always → While Using).
 * Accepts a snapshot or a `ServerPermissions` alike.
 */
export function permissionsFingerprint(p: Fingerprinted): string {
  return [
    'v1',
    p.location,
    p.precise === null ? 'null' : String(p.precise),
    p.motion ?? 'null',
    p.notifications,
    p.batteryOptimization,
    p.alwaysExcused === true ? 'excused' : 'wanted',
  ].join('|');
}

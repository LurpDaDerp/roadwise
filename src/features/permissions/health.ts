/**
 * v3 permission health: what a drive needs from the phone, row by row. Location "While Using" is
 * all v3 ever asks for (a drive starts only from the Start Drive tap and the OS keeps it running),
 * so there is no Always row and no battery row.
 */
import type { PermissionSnapshot } from '@/core/permissions';

export type RowId = 'location' | 'precise' | 'motion' | 'notifications';
export type RowStatus = 'ok' | 'attention' | 'off';
export type Fix = 'requestLocation' | 'requestMotion' | 'requestNotifications' | 'openSettings';

export interface HealthRowModel {
  id: RowId;
  status: RowStatus;
  fix: Fix | null;
}

/** The rows for one reading of the phone, in the order a driver should fix them. */
export function healthRows(s: PermissionSnapshot): HealthRowModel[] {
  const rows: HealthRowModel[] = [];
  const located = s.location === 'foreground' || s.location === 'always';

  if (located) rows.push({ id: 'location', status: 'ok', fix: null });
  else if (s.location === 'undetermined' && s.locationCanAskAgain) rows.push({ id: 'location', status: 'attention', fix: 'requestLocation' });
  else rows.push({ id: 'location', status: 'off', fix: s.locationCanAskAgain ? 'requestLocation' : 'openSettings' });

  if (located && s.precise !== null) {
    rows.push(s.precise ? { id: 'precise', status: 'ok', fix: null } : { id: 'precise', status: 'attention', fix: 'openSettings' });
  }

  if (s.motion === 'granted') rows.push({ id: 'motion', status: 'ok', fix: null });
  else if (s.motion === 'undetermined') rows.push({ id: 'motion', status: 'attention', fix: 'requestMotion' });
  else if (s.motion === 'denied') rows.push({ id: 'motion', status: 'off', fix: 'openSettings' });
  // `unavailable` (no sensor) or null (can't check): nothing the driver can do, so no row.

  if (s.notifications === 'granted' || s.notifications === 'provisional') rows.push({ id: 'notifications', status: 'ok', fix: null });
  else if (s.notifications === 'undetermined') rows.push({ id: 'notifications', status: 'attention', fix: 'requestNotifications' });
  else rows.push({ id: 'notifications', status: 'off', fix: s.notificationsCanAskAgain ? 'requestNotifications' : 'openSettings' });

  return rows;
}

/** The worst row decides the summary line. */
export function overall(rows: readonly HealthRowModel[]): 'ok' | 'attention' | 'broken' {
  if (rows.some((r) => r.id === 'location' && r.status !== 'ok')) return 'broken';
  return rows.every((r) => r.status === 'ok') ? 'ok' : 'attention';
}

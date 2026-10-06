/**
 * The permission screen's words. Each line says only what the reading supports and what it means
 * for recording a drive; nothing nags.
 */
import type { PermissionPlatform } from '@/core/permissions';

import type { Fix, RowId, RowStatus } from './health';

export const permissionsCopy = {
  title: 'Permissions',
  loading: 'Checking this phone',
  readError: "Couldn't check this phone's permissions.",
  retry: 'Try again',
  actionError: "That didn't work. Try again.",
  summary: {
    ok: 'Everything RoadWise needs is on',
    attention: 'A couple of things could be better',
    broken: "RoadWise can't record drives right now",
  },
  never: 'RoadWise only uses location while a drive you started is running. It never asks for “Always”.',
  status: { ok: 'On', attention: 'Needs a look', off: 'Off' } satisfies Record<RowStatus, string>,
  fix: {
    requestLocation: 'Allow location',
    requestMotion: 'Allow motion',
    requestNotifications: 'Allow notifications',
    openSettings: 'Open Settings',
  } satisfies Record<Fix, string>,
};

const TITLES: Record<RowId, string | Record<PermissionPlatform, string>> = {
  location: 'Location while using',
  precise: 'Precise location',
  motion: { ios: 'Motion & Fitness', android: 'Physical activity' },
  notifications: 'Notifications',
};

export function rowTitle(id: RowId, platform: PermissionPlatform): string {
  const t = TITLES[id];
  return typeof t === 'string' ? t : t[platform];
}

/** One line under a row's title: what this state means for a drive. */
export function rowDetail(id: RowId, status: RowStatus): string {
  switch (id) {
    case 'location':
      return status === 'ok' ? 'RoadWise can measure speed and miles on your drives.' : "Without it, RoadWise can't record drives.";
    case 'precise':
      return status === 'ok' ? 'Speed and distance are measured accurately.' : 'Approximate location makes speed and miles rough.';
    case 'motion':
      return status === 'ok' ? 'Catches hard braking and notices when your drive is over.' : "Without it, drives may not end on their own.";
    case 'notifications':
      return status === 'ok' ? 'Your weekly recap, league results and friend requests can reach you.' : "You won't get your weekly recap or league results.";
  }
}

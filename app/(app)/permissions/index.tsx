import { PermissionHealthScreen } from '@/features/permissions';

/**
 * `/permissions` — B2, permission health: the single repair place (product §8.3). Home's banner
 * and the permission-lapse push (Task 4, `url: '/permissions'`) both open it.
 */
export default function PermissionsRoute() {
  return <PermissionHealthScreen />;
}

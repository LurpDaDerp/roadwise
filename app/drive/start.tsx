import { useMemo } from 'react';

import { createSettingsRepo } from '@/data/db/settings';
import { useDb } from '@/data/queries';
import { defaultStartDeps, DriveStartScreen } from '@/features/drive/PreDriveSheet';

/**
 * C1 — `/drive/start`: the centre Drive tab lands here. Busy → Home; location denied → the
 * explainer; already moving → a pocket drive with no sheet; otherwise the pre-drive sheet.
 */
export default function DriveStartRoute() {
  const db = useDb();
  const deps = useMemo(() => defaultStartDeps(createSettingsRepo(db)), [db]);
  return <DriveStartScreen deps={deps} />;
}

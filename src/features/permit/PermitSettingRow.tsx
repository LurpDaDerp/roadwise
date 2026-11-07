// Settings › Driving › Permit mode: "Off", "On · 12.5 of 50 h" (the practice hours against the
// total target), or "On" without a total target. Opens `/settings/permit`.
import { useRouter } from 'expo-router';

import { LinkRow } from '@/features/settings/parts';
import { SETTINGS_HREFS } from '@/features/settings/routes';

import { permitCopy } from './copy';
import { hoursText, targetsOf, targetText, type PracticeLog } from './log';
import type { PermitPrefs } from './prefs';
import { usePermitPrefs, usePracticeLog } from './usePermit';

/** The row's subtitle. */
export function permitSubtitle(prefs: PermitPrefs | undefined, log: PracticeLog | undefined): string {
  if (!prefs?.enabled) return permitCopy.row.off;
  const { totalH } = targetsOf(prefs);
  if (totalH === null || log === undefined) return permitCopy.row.on;
  return permitCopy.row.progress(hoursText(log.totals.totalMin), targetText(totalH));
}

export function PermitSettingRow() {
  const router = useRouter();
  const { prefs } = usePermitPrefs();
  const { log } = usePracticeLog(prefs);
  return (
    <LinkRow icon="school-outline" title={permitCopy.row.title} subtitle={permitSubtitle(prefs, log)} onPress={() => router.push(SETTINGS_HREFS.permit)} testID="settings-permit" />
  );
}

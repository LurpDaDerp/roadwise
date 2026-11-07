// `/settings/practice-drives`: the drives in the practice log, newest first: the day, the time
// span, how long, the minutes at night and who supervised. A tap opens the drive's recap (an
// archived drive has none, so it opens nothing).
import { useRouter } from 'expo-router';
import { View } from 'react-native';

import { driveSummaryHref } from '@/features/drives/routes';
import { formatDay, formatDuration, formatTimeSpan } from '@/features/drives/format';
import { RowIcon, Section, TopBar } from '@/features/settings/parts';
import { EmptyState, ListRow, Screen, Skeleton, useTheme } from '@/ui';

import { permitCopy } from './copy';
import type { LogRow } from './log';
import { usePermitPrefs, usePracticeLog } from './usePermit';

const copy = permitCopy.drives;

/** A log row's two lines: "Mon, Oct 5 · 7:42 – 8:12 AM" over "30 min · 12 min at night · with Dad". */
export function practiceRowLines(r: LogRow): { title: string; subtitle: string } {
  const minutes = r.dayMin + r.nightMin;
  return {
    title: `${formatDay(r.drive.startedAt)} · ${formatTimeSpan(r.drive.startedAt, r.drive.endedAt)}`,
    subtitle: [formatDuration(minutes * 60), copy.nightLine(r.nightMin), ...(r.supervisor === null ? [] : [copy.with(r.supervisor)])].join(' · '),
  };
}

export function PracticeDrivesScreen() {
  const t = useTheme();
  const router = useRouter();
  const { prefs } = usePermitPrefs();
  const { log, loading } = usePracticeLog(prefs);
  const rows = log?.rows ?? [];

  return (
    <Screen scroll testID="practice-drives-screen">
      <TopBar title={copy.title} />
      {prefs === undefined || loading ? (
        <View style={{ gap: t.space.md }} testID="practice-drives-loading">
          <Skeleton width="100%" height={72} radius={t.radius.card} />
          <Skeleton width="100%" height={72} radius={t.radius.card} />
        </View>
      ) : rows.length === 0 ? (
        <EmptyState title={copy.empty} body={copy.emptyBody} icon="car-outline" />
      ) : (
        <Section testID="practice-drives-list">
          {rows.map((r) => {
            const { title, subtitle } = practiceRowLines(r);
            const open = r.drive.archived === true ? undefined : () => router.push(driveSummaryHref(r.drive.clientTripId));
            return (
              <ListRow
                key={r.drive.clientTripId}
                title={title}
                subtitle={subtitle}
                leading={<RowIcon name="car-outline" />}
                accessory={open ? 'chevron' : 'none'}
                onPress={open}
                testID={`practice-drive-${r.drive.clientTripId}`}
              />
            );
          })}
        </Section>
      )}
    </Screen>
  );
}

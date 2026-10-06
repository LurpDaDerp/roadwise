/**
 * Home wired to its data: the server summary for the header and challenges, local drives for
 * the first-run gate, stats and recent drives, the DMS setting for the chip, and the drive
 * controls for Start.
 */
import { useRouter } from 'expo-router';
import { useState } from 'react';

import { useDataSource, useDriveCount, useRecentDrives, useStatSums } from '@/data/queries';
import { useMySummary } from '@/data/server/summary';
import { useForgottenDriveNotice } from '@/drive/forgottenDrive';
import { useDriveControls } from '@/drive/useDrive';
import { sinceDays } from '@/features/drives/format';
import {
  ALL_STATS_HREF,
  DMS_SETUP_HREF,
  DRIVE_HISTORY_HREF,
  DRIVE_HREF,
  driveSummaryHref,
  HOW_POINTS_WORK_HREF,
  LEAGUES_HREF,
  PERMISSIONS_HREF,
} from '@/features/drives/routes';
import { Screen } from '@/ui';

import { HomeView } from './HomeView';
import type { StartRefusal } from './StartDrive';
import { useDmsSetting } from './useDmsSetting';

export function HomeScreen() {
  const router = useRouter();
  const { now } = useDataSource();
  const summary = useMySummary();
  const count = useDriveCount();
  const recent = useRecentDrives(5);
  const week = useStatSums(sinceDays(now(), 7));
  const month = useStatSums(sinceDays(now(), 30));
  const dms = useDmsSetting();
  const { start } = useDriveControls();
  const forgotten = useForgottenDriveNotice();
  const [starting, setStarting] = useState(false);
  const [refusal, setRefusal] = useState<StartRefusal | null>(null);

  const onStart = async () => {
    if (starting) return;
    setStarting(true);
    setRefusal(null);
    try {
      const res = await start({ dmsOn: dms.setting.enabled });
      if (res.ok) router.push(DRIVE_HREF);
      else setRefusal(res.reason);
    } catch {
      setRefusal('error');
    } finally {
      setStarting(false);
    }
  };

  const onToggleDms = () => {
    if (!dms.setting.calibrated) {
      router.push(DMS_SETUP_HREF);
      return;
    }
    void dms.setEnabled(!dms.setting.enabled);
  };

  const refreshing = summary.isRefetching || recent.isRefetching;

  return (
    <Screen padded={false} bottomInset={false}>
      <HomeView
        summary={summary.data}
        summaryLoading={summary.isLoading}
        summaryError={summary.isError}
        onRetrySummary={() => void summary.refetch()}
        driveCount={count.data}
        recent={recent.data}
        week={week.data}
        month={month.data}
        dmsOn={dms.setting.enabled}
        onToggleDms={onToggleDms}
        starting={starting}
        refusal={refusal}
        onStart={() => void onStart()}
        onRefusalAction={() => (refusal === 'permission' ? router.push(PERMISSIONS_HREF) : router.push(DRIVE_HREF))}
        onOpenDrive={(id) => router.push(driveSummaryHref(id))}
        onSeeAll={() => router.push(DRIVE_HISTORY_HREF)}
        onAllStats={() => router.push(ALL_STATS_HREF)}
        onHowPoints={() => router.push(HOW_POINTS_WORK_HREF)}
        onLeagues={() => router.navigate(LEAGUES_HREF)}
        forgottenDrive={forgotten}
        refreshing={refreshing}
        onRefresh={() => {
          void summary.refetch();
          void count.refetch();
          void recent.refetch();
          void week.refetch();
          void month.refetch();
        }}
      />
    </Screen>
  );
}

/**
 * The drive screens wired to their data: local drives from `@/data/queries` (plan §10), their
 * scores, the server summary for "Wasn't driving" uses left, and the drive actions.
 */
import { useQueryClient } from '@tanstack/react-query';
import { useLocalSearchParams, useRouter } from 'expo-router';
import { useState } from 'react';
import { View } from 'react-native';

import { useDataSource, useDb, useDriveDetail, useDriveHistory } from '@/data/queries';
import { useArchivedKinds } from '@/data/queries/archived';
import { useMySummary } from '@/data/server/summary';
import { markNotDriving, reportEvent } from '@/data/sync/driveActions';
import { autoDrivesOn, useAutoDrives } from '@/features/autoDrives/useAutoDrives';
import { EmptyState, Screen, Skeleton, useTheme } from '@/ui';

import { BackHeader } from './BackHeader';
import { HistoryView } from './HistoryView';
import type { HistoryFilter } from './model';
import { driveSummaryHref, HOME_HREF } from './routes';
import { SummaryView } from './SummaryView';
import { useDriveScores } from './useDriveScores';

function useBack() {
  const router = useRouter();
  return () => (router.canGoBack() ? router.back() : router.replace(HOME_HREF));
}

export function DriveHistoryScreen() {
  const router = useRouter();
  const back = useBack();
  const { now } = useDataSource();
  const [filter, setFilter] = useState<HistoryFilter>('all');
  const q = useDriveHistory(filter);
  const scores = useDriveScores(q.data);
  const archived = useArchivedKinds();
  const auto = useAutoDrives();
  return (
    <Screen padded={false}>
      <HistoryView
        drives={q.data}
        loading={q.isLoading}
        error={q.isError}
        filter={filter}
        onFilter={setFilter}
        onOpen={(id) => router.push(driveSummaryHref(id))}
        onBack={back}
        onHome={() => router.dismissTo(HOME_HREF)}
        onRefresh={() => void q.refetch()}
        refreshing={q.isRefetching}
        now={Math.floor(now() / 3_600_000) * 3_600_000}
        scores={scores}
        autoDrives={autoDrivesOn(auto)}
        {...(archived.data ? { archived: archived.data } : {})}
      />
    </Screen>
  );
}

export function DriveSummaryScreen() {
  const t = useTheme();
  const back = useBack();
  const qc = useQueryClient();
  const db = useDb();
  const { clientTripId, fresh } = useLocalSearchParams<{ clientTripId: string; fresh?: string }>();
  const detail = useDriveDetail(clientTripId ?? '');
  const summary = useMySummary();
  const { now } = useDataSource();
  // Animate only on the first render after a drive ends, not when coming back to it.
  const [isFresh] = useState(fresh === '1');

  if (!detail.data) {
    return (
      <Screen>
        <BackHeader title="Drive" onBack={back} />
        {detail.isLoading ? (
          <View style={{ gap: t.space.lg }} testID="summary-loading">
            <Skeleton width="100%" height={160} radius={t.radius.card} />
            <Skeleton width="100%" height={240} radius={t.radius.card} />
          </View>
        ) : (
          <EmptyState
            title={detail.isError ? "Couldn't open this drive" : 'Drive not found'}
            body={detail.isError ? 'Something went wrong. Try again in a moment.' : "This drive isn't on this phone."}
            icon="car-outline"
            action={{ label: 'Back', onPress: back }}
          />
        )}
      </Screen>
    );
  }

  const { drive, events } = detail.data;
  return (
    <Screen padded={false}>
      <SummaryView
        drive={drive}
        events={events}
        fresh={isFresh}
        notDrivingLeft={summary.data?.not_driving_left ?? null}
        now={now()}
        onBack={back}
        onReport={async (eventId, reason) => {
          const outcome = await reportEvent(drive.clientTripId, eventId, reason, { db, queryClient: qc });
          if (outcome === 'missing') throw new Error('event not found');
        }}
        onNotDriving={async () => {
          const outcome = await markNotDriving(drive.clientTripId, { db, queryClient: qc });
          if (outcome === 'missing') throw new Error('drive not found');
        }}
      />
    </Screen>
  );
}

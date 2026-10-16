import type { StatSums } from '@scoring';
import type { ReactNode } from 'react';
import { RefreshControl, ScrollView, View } from 'react-native';

import { useUnits, useUnitsFromServer } from '@/data/queries/units';
import type { MySummary } from '@/data/server/summary';
import type { LocalDrive } from '@/features/drives/model';
import { homeStats } from '@/features/drives/stats';
import { Text, useTheme } from '@/ui';

import { HomeHeader } from './HomeHeader';
import { ChallengesStrip, FirstRunCard, RecentDrives, StatsCard } from './HomeSections';
import { StartDriveBar, type StartBanner } from './StartDrive';

/** Scored drives before the stats card and the rest of Home appear. */
export const FIRST_RUN_DRIVES = 3;

export type HomeViewProps = {
  summary: MySummary | undefined;
  summaryLoading: boolean;
  summaryError: boolean;
  onRetrySummary: () => void;
  /** Scored drives; undefined while loading. */
  driveCount: number | undefined;
  recent: readonly LocalDrive[] | undefined;
  week: StatSums | undefined;
  month: StatSums | undefined;
  starting: boolean;
  refusal: StartBanner | null;
  /** The last drive was not kept: one line above Start until OK (a refusal outranks it). */
  dropNotice?: { message: string; onDismiss: () => void } | null;
  onStart: () => void;
  onRefusalAction: () => void;
  onOpenDrive: (clientTripId: string) => void;
  onSeeAll: () => void;
  onAllStats: () => void;
  onHowPoints: () => void;
  onLeagues: () => void;
  refreshing?: boolean;
  onRefresh?: () => void;
  /**
   * A drive is recording (the driver backed out to Home): the "drive in progress" strip takes
   * Start's place at the top, one tap back to the driving screen.
   */
  recording?: boolean;
  inProgress?: ReactNode;
};

/**
 * Home: the header answers "how am I doing?", Start drive sits at the bottom within thumb reach,
 * and the detail (stats, recent drives, challenges) sits between. Until 3 scored drives it shows
 * only the header, Start, a first-drive prompt and how it works.
 */
export function HomeView(p: HomeViewProps) {
  const t = useTheme();
  const units = useUnits();
  // A fresh install, or another phone changed units: the local mirror follows the server.
  useUnitsFromServer(p.summary?.profile.units);
  const firstRun = p.driveCount !== undefined && p.driveCount < FIRST_RUN_DRIVES;
  const full = p.driveCount !== undefined && !firstRun;
  const stats = full && p.week && p.month ? homeStats(p.week, p.month, units) : null;
  const name = p.summary?.profile.username;

  return (
    <View style={{ flex: 1 }}>
      <ScrollView
        testID="home"
        contentContainerStyle={{ padding: t.space.lg, gap: t.space.xl }}
        refreshControl={p.onRefresh ? <RefreshControl refreshing={p.refreshing ?? false} onRefresh={p.onRefresh} /> : undefined}
      >
        <Text variant="title1" accessibilityRole="header">
          {name ? `Hey, ${name}` : 'Home'}
        </Text>
        {p.recording ? p.inProgress : null}
        <HomeHeader summary={p.summary} loading={p.summaryLoading} error={p.summaryError} onLeagues={p.onLeagues} onRetry={p.onRetrySummary} />

        {firstRun ? (
          <>
            <FirstRunCard driveCount={p.driveCount ?? 0} onHowPoints={p.onHowPoints} />
            {p.recent && p.recent.length > 0 ? <RecentDrives drives={p.recent} onOpen={p.onOpenDrive} onSeeAll={p.onSeeAll} /> : null}
          </>
        ) : null}

        {full ? (
          <>
            {stats ? <StatsCard stats={stats.stats} window={stats.window} onAllStats={p.onAllStats} /> : null}
            <RecentDrives drives={p.recent ?? []} onOpen={p.onOpenDrive} onSeeAll={p.onSeeAll} />
            <ChallengesStrip challenges={p.summary?.challenges ?? []} freezeProgress={p.summary?.progress.freeze_progress} />
          </>
        ) : null}
      </ScrollView>
      {p.recording ? null : (
        <StartDriveBar
          onStart={p.onStart}
          starting={p.starting}
          refusal={p.refusal}
          onRefusalAction={p.onRefusalAction}
          notice={p.dropNotice ?? null}
        />
      )}
    </View>
  );
}

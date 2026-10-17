import type { StatSums } from '@scoring';
import type { ReactNode, RefObject } from 'react';
import { Pressable, RefreshControl, ScrollView, View } from 'react-native';

import { useUnits, useUnitsFromServer } from '@/data/queries/units';
import type { MySummary } from '@/data/server/summary';
import type { LocalDrive } from '@/features/drives/model';
import { homeStats } from '@/features/drives/stats';
import { Avatar, Text, useTheme } from '@/ui';

import { HomeHeader, ProgressStrip } from './HomeHeader';
import { ChallengesStrip, FirstRunCard, RecentDrives, StatsCard } from './HomeSections';
import { StartDriveButton, StartNotice, type StartBanner } from './StartDrive';

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
  /** The last drive was not kept: one line under the drive card until OK (a refusal outranks it). */
  dropNotice?: { message: string; onDismiss: () => void } | null;
  onStart: () => void;
  onRefusalAction: () => void;
  onOpenDrive: (clientTripId: string) => void;
  onSeeAll: () => void;
  onAllStats: () => void;
  onHowPoints: () => void;
  onLeagues: () => void;
  /** The avatar beside the greeting opens Profile. */
  onProfile?: () => void;
  refreshing?: boolean;
  onRefresh?: () => void;
  /**
   * A drive is recording (the driver backed out to Home): the "drive in progress" strip shows at
   * the top, one tap back to the driving screen, and the drive card carries no Start.
   */
  recording?: boolean;
  inProgress?: ReactNode;
  /** The permission card, right under the greeting (never while a drive records). */
  permissions?: ReactNode;
  /**
   * Home's DashPal slot (the new-phone card and the card of a DashPal ready to pair), under the
   * permission card. It stays mounted while a drive records: it hides its own cards then, and a
   * setup sheet it opened stays to say the drive stopped it.
   */
  dashpal?: ReactNode;
  /** Home's scroll, so it can return to the top when the permission card shows. */
  scrollRef?: RefObject<ScrollView | null>;
};

/**
 * Home, a dashboard in the travel-card mould: the greeting with your avatar, the one line about a
 * permission (or the drive in progress) and the DashPal card, your progress in a row of pills,
 * then the drive card, the screen's hero, with the Safety Rating, your league and Start drive.
 * Under it the detail: stats, recent drives and the week's challenges. Until 3 scored drives it
 * shows only the header, the drive card, a first-drive prompt and how it works.
 */
export function HomeView({ scrollRef, ...p }: HomeViewProps) {
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
        ref={scrollRef}
        testID="home"
        contentContainerStyle={{ paddingHorizontal: t.space.lg, paddingTop: t.space.md, paddingBottom: t.space.xxl, gap: t.space.xl }}
        refreshControl={p.onRefresh ? <RefreshControl refreshing={p.refreshing ?? false} onRefresh={p.onRefresh} tintColor={t.colors.accent} /> : undefined}
      >
        <View style={{ flexDirection: 'row', alignItems: 'center', gap: t.space.md }}>
          <Text variant="title1" accessibilityRole="header" style={{ flex: 1 }}>
            {name ? `Hey, ${name}` : 'Home'}
          </Text>
          {name && p.onProfile ? (
            <Pressable
              onPress={p.onProfile}
              accessibilityRole="button"
              accessibilityLabel="Profile"
              testID="home-avatar"
              hitSlop={t.space.xs}
              style={({ pressed }) => ({ borderRadius: 28, padding: 2, backgroundColor: t.colors.surface, boxShadow: t.elevation.card, opacity: pressed ? 0.8 : 1 })}
            >
              <Avatar username={name} size="md" />
            </Pressable>
          ) : null}
        </View>
        {p.recording ? p.inProgress : p.permissions}
        {p.dashpal}
        {p.summary ? <ProgressStrip summary={p.summary} /> : null}
        <View style={{ gap: t.space.md }}>
          <HomeHeader
            summary={p.summary}
            loading={p.summaryLoading}
            error={p.summaryError}
            onLeagues={p.onLeagues}
            onRetry={p.onRetrySummary}
            start={p.recording ? undefined : <StartDriveButton onStart={p.onStart} starting={p.starting} />}
          />
          {p.recording ? null : <StartNotice refusal={p.refusal} onRefusalAction={p.onRefusalAction} notice={p.dropNotice ?? null} />}
        </View>

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
    </View>
  );
}

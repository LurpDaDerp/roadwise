import type { StatSums } from '@scoring';
import type { ReactNode, RefObject } from 'react';
import { Pressable, RefreshControl, ScrollView, View } from 'react-native';
import Animated from 'react-native-reanimated';

import { useUnits, useUnitsFromServer } from '@/data/queries/units';
import type { MySummary } from '@/data/server/summary';
import type { LocalDrive } from '@/features/drives/model';
import { homeStats } from '@/features/drives/stats';
import { showsTip, type Coaching, type Level } from '@/features/analytics/model';
import { Avatar, ScreenTitle, useOnSky, useSkyScrollHandler, useTheme } from '@/ui';

import { CoachTipCard, StreakCard, type StreakNews } from './ActionCards';
import { HomeHeader, ProgressStrip } from './HomeHeader';
import { ChallengesStrip, FirstRunCard, HowItWorks, RecentDrives, StatsCard } from './HomeSections';
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
  /** "All stats" on the stats card: the Analytics tab. */
  onAllStats: () => void;
  onHowPoints: () => void;
  /** The Safety Rating badge and the coaching tip open the Analytics tab. */
  onAnalytics: () => void;
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
  /** The dangerous-weather card: the first action item under the drive card (it renders nothing when all is well). */
  weather?: ReactNode;
  /** The latest drive lost the streak or spent a freeze on it, until dismissed. */
  streakNews?: StreakNews | null;
  onDismissStreak?: () => void;
  /** The permission card, an action item after the streak card (never while a drive records). */
  permissions?: ReactNode;
  /**
   * Home's DashPal slot (the new-phone card and the card of a DashPal ready to pair), under the
   * permission card. It stays mounted while a drive records: it hides its own cards then, and a
   * setup sheet it opened stays to say the drive stopped it.
   */
  dashpal?: ReactNode;
  /** The last 30 days' coaching; its tip card shows only for a Fair or Poor level. */
  coaching?: Coaching | null;
  /** Home's scroll, so it can return to the top when the permission card shows. */
  scrollRef?: RefObject<ScrollView | null>;
};

/**
 * Home, a dashboard in the travel-card mould: the greeting with your avatar on the sky, your streak
 * and points in two pills, then the drive card, the screen's hero, with your level, the Safety
 * Rating in its corner and Start drive. Right under it, the action items, each only when it
 * applies: dangerous weather, streak news, a permission to fix, DashPal, a coaching tip. Then the
 * detail (stats, recent drives, the week's challenges; until 3 scored drives a first-drive prompt
 * instead) and How it works, always last.
 */
export function HomeView({ scrollRef, ...p }: HomeViewProps) {
  const t = useTheme();
  const onSky = useOnSky();
  const units = useUnits();
  // A fresh install, or another phone changed units: the local mirror follows the server.
  useUnitsFromServer(p.summary?.profile.units);
  const firstRun = p.driveCount !== undefined && p.driveCount < FIRST_RUN_DRIVES;
  const full = p.driveCount !== undefined && !firstRun;
  const stats = full && p.week && p.month ? homeStats(p.week, p.month, units) : null;
  const name = p.summary?.profile.username;
  const tip = p.coaching && showsTip(p.coaching) ? (p.coaching as Coaching & { level: Level }) : null;
  // the sky behind the tabs scrolls with Home
  const onScroll = useSkyScrollHandler();

  return (
    <View style={{ flex: 1 }}>
      <Animated.ScrollView
        ref={scrollRef}
        onScroll={onScroll}
        scrollEventThrottle={16}
        testID="home"
        contentContainerStyle={{ paddingHorizontal: t.space.lg, paddingTop: t.space.md, paddingBottom: t.space.xxl, gap: t.space.xl }}
        refreshControl={
          p.onRefresh ? <RefreshControl refreshing={p.refreshing ?? false} onRefresh={p.onRefresh} tintColor={onSky ? t.onSky.text : t.colors.accent} /> : undefined
        }
      >
        <ScreenTitle
          testID="home-greeting"
          trailing={
            name && p.onProfile ? (
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
            ) : null
          }
        >
          {name ? `Hey, ${name}` : 'Home'}
        </ScreenTitle>
        {p.recording ? p.inProgress : null}
        {p.summary ? <ProgressStrip summary={p.summary} /> : null}
        <View style={{ gap: t.space.md }}>
          <HomeHeader
            summary={p.summary}
            loading={p.summaryLoading}
            error={p.summaryError}
            onRating={p.onAnalytics}
            onRetry={p.onRetrySummary}
            start={p.recording ? undefined : <StartDriveButton onStart={p.onStart} starting={p.starting} />}
          />
          {p.recording ? null : <StartNotice refusal={p.refusal} onRefusalAction={p.onRefusalAction} notice={p.dropNotice ?? null} />}
        </View>

        {p.weather}
        {p.streakNews && p.summary ? (
          <StreakCard outcome={p.streakNews.outcome} freezes={p.summary.progress.freezes} onDismiss={p.onDismissStreak ?? (() => {})} />
        ) : null}
        {p.recording ? null : p.permissions}
        {p.dashpal}
        {tip ? <CoachTipCard coaching={tip} onOpen={p.onAnalytics} /> : null}

        {firstRun ? (
          <>
            <FirstRunCard driveCount={p.driveCount ?? 0} />
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

        <HowItWorks onHowPoints={p.onHowPoints} />
      </Animated.ScrollView>
    </View>
  );
}

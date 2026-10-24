import type { StatSums } from '@scoring';
import { useRef, type ReactNode, type RefObject } from 'react';
import { Pressable, RefreshControl, ScrollView, View, type LayoutChangeEvent } from 'react-native';
import Animated from 'react-native-reanimated';

import { useUnits, useUnitsFromServer } from '@/data/queries/units';
import type { MySummary } from '@/data/server/summary';
import type { LocalDrive } from '@/features/drives/model';
import { homeStats } from '@/features/drives/stats';
import { showsTip, type Coaching, type Level } from '@/features/analytics/model';
import type { Conditions } from '@/features/weather/conditions';
import { Avatar, ScreenTitle, useOnSky, useSkyScrollHandler, useTheme } from '@/ui';

import { CoachTipCard } from './ActionCards';
import { homeCopy } from './copy';
import { HomeHeader } from './HomeHeader';
import { FirstRunCard, HowItWorks, RecentDrives, StatsCard, WeeklyGoals } from './HomeSections';
import { StartDriveButton, StartNotice, type StartRefusal } from './StartDrive';
import { goalsDone, WeekPills } from './WeekPills';

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
  /** The recent drives' scores (`useDriveScores`). */
  scores?: ReadonlyMap<string, number>;
  week: StatSums | undefined;
  month: StatSums | undefined;
  /** This calendar week's (from Monday) sums, for the pills; undefined while loading. */
  thisWeek?: StatSums | undefined;
  /** Automatic drives are on (an iPhone with what they need): the auto words. */
  autoDrives?: boolean;
  starting: boolean;
  refusal: StartRefusal | null;
  /**
   * One information line under the drive card until OK (a refusal outranks it): the "Not driving?"
   * acknowledgement, or why the last manual drive was not kept.
   */
  dropNotice?: { message: string; onDismiss: () => void; testID?: string } | null;
  onStart: () => void;
  onRefusalAction: () => void;
  onOpenDrive: (clientTripId: string) => void;
  onSeeAll: () => void;
  /** "All stats" on the stats card: the Analytics tab. */
  onAllStats: () => void;
  onHowScores: () => void;
  /** The rating block and the coaching tip open the Analytics tab. */
  onAnalytics: () => void;
  /** The avatar beside the greeting opens Profile. */
  onProfile?: () => void;
  refreshing?: boolean;
  onRefresh?: () => void;
  /**
   * A drive is recording or a Start is waiting for the car to move (the driver backed out to Home):
   * the strip shows at the top, one tap back to the driving screen, and the drive card carries no Start.
   */
  recording?: boolean;
  inProgress?: ReactNode;
  /** The dangerous-weather card: the first action item under the drive card (it renders nothing when all is well). */
  weather?: ReactNode;
  /** The weather now (°F, icon, words), shown on the drive card above Start drive. */
  conditions?: Conditions | null;
  /** The permission card, an action item under the weather card (never while a drive records). */
  permissions?: ReactNode;
  /**
   * Home's DashPal slot (the new-phone card and the card of a DashPal ready to pair), under the
   * permission card. It stays mounted while a drive records: it hides its own cards then, and a
   * setup sheet it opened stays to say the drive stopped it.
   */
  dashpal?: ReactNode;
  /** The coaching; its tip card shows only for a Fair or Poor level. */
  coaching?: Coaching | null;
  /** Home's scroll, so it can return to the top when the permission card shows. */
  scrollRef?: RefObject<ScrollView | null>;
};

/**
 * Home, a dashboard in the travel-card mould: the greeting with your avatar on the sky, this week's
 * drives, distance and goals in three pills (the goals pill scrolls to the goals section), then the drive card, the screen's hero, with the Safety Rating in
 * its ring and Start drive. Right under it, the action items, each only when it applies: dangerous
 * weather, a permission to fix, DashPal, a coaching tip. Then the detail (stats, recent drives,
 * this week's goals; until 3 scored drives the first-drive prompt and the recent drives come first,
 * then the goals) and How it works, always last.
 */
export function HomeView({ scrollRef: outerRef, ...p }: HomeViewProps) {
  const t = useTheme();
  const onSky = useOnSky();
  const units = useUnits();
  // A fresh install, or another phone changed units: the local mirror follows the server.
  useUnitsFromServer(p.summary?.profile.units);
  const auto = p.autoDrives ?? false;
  const firstRun = p.driveCount !== undefined && p.driveCount < FIRST_RUN_DRIVES;
  const full = p.driveCount !== undefined && !firstRun;
  const stats = full && p.week && p.month ? homeStats(p.week, p.month, units) : null;
  const name = p.summary?.profile.username;
  const tip = p.coaching && showsTip(p.coaching) ? (p.coaching as Coaching & { level: Level }) : null;
  // the sky behind the tabs scrolls with Home
  const onScroll = useSkyScrollHandler();
  // The goals pill scrolls to the goals section: its top in the scroll's content, from its layout.
  const ownRef = useRef<ScrollView>(null);
  const scrollRef = outerRef ?? ownRef;
  const goalsY = useRef<number | null>(null);
  const onGoalsLayout = (e: LayoutChangeEvent) => {
    goalsY.current = e.nativeEvent.layout.y;
  };
  const goals = goalsDone(p.summary?.challenges);
  // The section renders in the first-run Home too (after the card and the recent drives), so the pill is a button whenever it is there.
  const goalsShown = (full || firstRun) && goals !== null;
  const showGoals = () => {
    if (goalsY.current === null) return;
    scrollRef.current?.scrollTo({ y: Math.max(0, goalsY.current - t.space.md), animated: true });
  };

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
          {name ? homeCopy.greeting(name) : 'Home'}
        </ScreenTitle>
        {p.recording ? p.inProgress : null}
        {p.thisWeek ? <WeekPills drives={p.thisWeek.drives} miles={p.thisWeek.miles} units={units} goals={goals} onGoals={goalsShown ? showGoals : undefined} /> : null}
        <View style={{ gap: t.space.md }}>
          <HomeHeader
            summary={p.summary}
            loading={p.summaryLoading}
            error={p.summaryError}
            onRating={p.onAnalytics}
            onRetry={p.onRetrySummary}
            start={p.recording ? undefined : <StartDriveButton onStart={p.onStart} starting={p.starting} />}
            caption={auto ? homeCopy.start.auto : null}
            conditions={p.conditions}
          />
          {p.recording ? null : <StartNotice refusal={p.refusal} onRefusalAction={p.onRefusalAction} notice={p.dropNotice ?? null} />}
        </View>

        {p.weather}
        {p.recording ? null : p.permissions}
        {p.dashpal}
        {tip ? <CoachTipCard coaching={tip} onOpen={p.onAnalytics} /> : null}

        {firstRun ? (
          <>
            <FirstRunCard driveCount={p.driveCount ?? 0} autoDrives={auto} />
            {p.recent && p.recent.length > 0 ? <RecentDrives drives={p.recent} scores={p.scores} onOpen={p.onOpenDrive} onSeeAll={p.onSeeAll} /> : null}
            <WeeklyGoals goals={p.summary?.challenges ?? []} onLayout={onGoalsLayout} />
          </>
        ) : null}

        {full ? (
          <>
            {stats ? <StatsCard stats={stats.stats} window={stats.window} onAllStats={p.onAllStats} /> : null}
            <RecentDrives drives={p.recent ?? []} scores={p.scores} onOpen={p.onOpenDrive} onSeeAll={p.onSeeAll} />
            <WeeklyGoals goals={p.summary?.challenges ?? []} onLayout={onGoalsLayout} />
          </>
        ) : null}

        <HowItWorks onHowScores={p.onHowScores} autoDrives={auto} />
      </Animated.ScrollView>
    </View>
  );
}

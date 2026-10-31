import { Ionicons } from '@expo/vector-icons';
import { View, type LayoutChangeEvent } from 'react-native';

import type { MySummary } from '@/data/server/summary';
import { DriveRow } from '@/features/drives/DriveRow';
import type { LocalDrive } from '@/features/drives/model';
import type { HomeStat } from '@/features/drives/stats';
import { HowItWorksList } from '@/features/howScores/HowItWorksList';
import { Card, Divider, ProgressRing, SectionHeader, StatTile, Text, useTheme } from '@/ui';

import { homeCopy } from './copy';

/**
 * The first-run prompt: "Take your first drive", or how many more until stats unlock. Its line says
 * how drives start on this phone: on their own (automatic drives on), or from Start drive.
 */
export function FirstRunCard({ driveCount, autoDrives }: { driveCount: number; autoDrives: boolean }) {
  const t = useTheme();
  const left = Math.max(0, 3 - driveCount);
  return (
    <Card testID="first-run">
      <View style={{ flexDirection: 'row', gap: t.space.md, alignItems: 'center' }}>
        <View style={{ width: 48, height: 48, borderRadius: 24, alignItems: 'center', justifyContent: 'center', backgroundColor: t.colors.accentFaint }}>
          <Ionicons name="car-sport" size={t.size.iconLg} color={t.colors.accent} />
        </View>
        <View style={{ flex: 1, gap: 2 }}>
          <Text variant="title3">{driveCount === 0 ? homeCopy.firstRun.first : homeCopy.firstRun.more(left)}</Text>
          <Text variant="subhead" tone="muted">
            {driveCount > 0 ? homeCopy.firstRun.keepGoing : autoDrives ? homeCopy.firstRun.auto : homeCopy.firstRun.manual}
          </Text>
        </View>
      </View>
    </Card>
  );
}

/** How it works, last on Home for every driver, with "How scores work" into the full rules. */
export function HowItWorks({ onHowScores, autoDrives }: { onHowScores: () => void; autoDrives: boolean }) {
  const t = useTheme();
  return (
    <View style={{ gap: t.space.sm }}>
      <SectionHeader title={homeCopy.how.title} action={{ label: homeCopy.how.action, onPress: onHowScores }} />
      <Card testID="how-it-works">
        <HowItWorksList autoDrives={autoDrives} />
      </Card>
    </View>
  );
}

/** Home's four stats with arrows against your own 30 days; "All stats" opens Analytics. */
export function StatsCard({ stats, window, onAllStats }: { stats: readonly HomeStat[]; window: '7d' | '30d'; onAllStats: () => void }) {
  const t = useTheme();
  const rows = [stats.slice(0, 2), stats.slice(2, 4)];
  return (
    <View style={{ gap: t.space.sm }} testID="stats-card">
      <SectionHeader title={window === '7d' ? 'Last 7 days' : 'Last 30 days'} action={{ label: 'All stats', onPress: onAllStats }} />
      <Card>
        {rows.map((row, i) => (
          <View key={i} style={{ gap: t.space.md }}>
            {i > 0 ? <Divider /> : null}
            <View style={{ flexDirection: 'row', gap: t.space.lg }}>
              {row.map((s) => (
                <StatTile
                  key={s.id}
                  label={s.label}
                  value={s.value}
                  unit={s.unit}
                  health={s.health}
                  trend={s.trend}
                  higherIsBetter={s.higherIsBetter}
                  style={{ flex: 1 }}
                  testID={`home-stat-${s.id}`}
                />
              ))}
            </View>
          </View>
        ))}
        <Text variant="footnote" tone="subtle">
          {window === '7d' ? 'Compared with your average week in the last 30 days.' : 'No drives in the last 7 days, so these cover the last 30.'}
        </Text>
      </Card>
    </View>
  );
}

/** The last five drives, each with its score, with "See all" into Drive history. */
export function RecentDrives({
  drives,
  scores,
  onOpen,
  onSeeAll,
}: {
  drives: readonly LocalDrive[];
  scores?: ReadonlyMap<string, number>;
  onOpen: (id: string) => void;
  onSeeAll: () => void;
}) {
  const t = useTheme();
  if (drives.length === 0) return null;
  return (
    <View style={{ gap: t.space.sm }} testID="recent-drives">
      <SectionHeader title="Recent drives" action={{ label: 'See all', onPress: onSeeAll }} />
      <Card padded={false}>
        {drives.map((d, i) => (
          <View key={d.clientTripId}>
            {i > 0 ? <Divider inset={16} /> : null}
            <DriveRow drive={d} score={scores?.get(d.clientTripId)} onPress={() => onOpen(d.clientTripId)} testID={`recent-${d.clientTripId}`} />
          </View>
        ))}
      </Card>
    </View>
  );
}

type Goal = MySummary['challenges'][number];

/**
 * This week's three goals, one row each: a ring with the fraction while open, or full with a check
 * when done, then the title and its line. No rewards: they change no score. `onLayout` lets Home
 * scroll to it.
 */
export function WeeklyGoals({ goals, onLayout }: { goals: readonly Goal[]; onLayout?: (e: LayoutChangeEvent) => void }) {
  const t = useTheme();
  if (goals.length === 0) return null;
  return (
    <View style={{ gap: t.space.sm }} onLayout={onLayout} testID="goals">
      <SectionHeader title={homeCopy.goals.title} />
      <Card padded={false}>
        {[...goals]
          .sort((a, b) => a.slot - b.slot)
          .map((g, i) => {
            const value = g.target > 0 ? Math.min(1, g.progress / g.target) : 0;
            const spoken = g.completed
              ? homeCopy.goals.spokenDone(g.title, g.description)
              : homeCopy.goals.spokenOpen(g.title, g.progress, g.target, g.description);
            return (
              <View key={g.id}>
                {i > 0 ? <Divider inset={16} /> : null}
                <View
                  accessible
                  accessibilityLabel={spoken}
                  testID={`goal-${g.id}`}
                  style={{ flexDirection: 'row', alignItems: 'center', gap: t.space.md, padding: t.space.lg }}
                >
                  <View accessibilityElementsHidden importantForAccessibility="no-hide-descendants">
                    <ProgressRing
                      value={g.completed ? 1 : value}
                      size={40}
                      strokeWidth={5}
                      tone={g.completed ? 'clean' : 'primary'}
                      accessibilityLabel={spoken}
                    >
                      {g.completed ? (
                        <Ionicons name="checkmark" size={t.size.icon} color={t.colors.signal.clean.text} testID={`goal-${g.id}-done`} />
                      ) : (
                        <Text variant="caption" numberOfLines={1} adjustsFontSizeToFit minimumFontScale={0.5} style={{ fontWeight: '700', maxWidth: 28, textAlign: 'center' }}>
                          {homeCopy.goals.progress(g.progress, g.target)}
                        </Text>
                      )}
                    </ProgressRing>
                  </View>
                  <View style={{ flex: 1, gap: 2 }}>
                    <Text variant="headline">{g.title}</Text>
                    <Text variant="subhead" tone="muted">
                      {g.description}
                    </Text>
                  </View>
                </View>
              </View>
            );
          })}
        <Text variant="footnote" tone="subtle" style={{ paddingHorizontal: t.space.lg, paddingBottom: t.space.lg }}>
          {homeCopy.goals.footer}
        </Text>
      </Card>
    </View>
  );
}

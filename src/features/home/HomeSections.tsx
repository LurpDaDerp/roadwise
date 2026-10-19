import { Ionicons } from '@expo/vector-icons';
import { ScrollView, View } from 'react-native';

import type { MySummary } from '@/data/server/summary';
import { DriveRow } from '@/features/drives/DriveRow';
import type { LocalDrive } from '@/features/drives/model';
import type { HomeStat } from '@/features/drives/stats';
import { HowItWorksList } from '@/features/howPoints/HowPointsScreen';
import { Card, Divider, ProgressRing, SectionHeader, StatTile, Text, useTheme } from '@/ui';

/** The first-run prompt: "Take your first drive", or how many more until stats unlock. */
export function FirstRunCard({ driveCount }: { driveCount: number }) {
  const t = useTheme();
  const left = Math.max(0, 3 - driveCount);
  return (
    <Card testID="first-run">
      <View style={{ flexDirection: 'row', gap: t.space.md, alignItems: 'center' }}>
        <View style={{ width: 48, height: 48, borderRadius: 24, alignItems: 'center', justifyContent: 'center', backgroundColor: t.colors.accentFaint }}>
          <Ionicons name="car-sport" size={t.size.iconLg} color={t.colors.accent} />
        </View>
        <View style={{ flex: 1, gap: 2 }}>
          <Text variant="title3">{driveCount === 0 ? 'Take your first drive' : `${left} more ${left === 1 ? 'drive' : 'drives'} to unlock your stats`}</Text>
          <Text variant="subhead" tone="muted">
            {driveCount === 0
              ? 'Tap Start drive before you pull out. Put your phone down and go.'
              : 'Keep it up. Your driving stats show up here after 3 drives.'}
          </Text>
        </View>
      </View>
    </Card>
  );
}

/** How it works, last on Home for every driver, with "All the rules" into How points work. */
export function HowItWorks({ onHowPoints }: { onHowPoints: () => void }) {
  const t = useTheme();
  return (
    <View style={{ gap: t.space.sm }}>
      <SectionHeader title="How it works" action={{ label: 'All the rules', onPress: onHowPoints }} />
      <Card testID="how-it-works">
        <HowItWorksList />
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
          {window === '7d' ? 'Arrows compare with your last 30 days.' : 'No drives in 7 days, so these show your last 30.'}
        </Text>
      </Card>
    </View>
  );
}

/** The last five drives, with "See all" into Drive history. */
export function RecentDrives({ drives, onOpen, onSeeAll }: { drives: readonly LocalDrive[]; onOpen: (id: string) => void; onSeeAll: () => void }) {
  const t = useTheme();
  if (drives.length === 0) return null;
  return (
    <View style={{ gap: t.space.sm }} testID="recent-drives">
      <SectionHeader title="Recent drives" action={{ label: 'See all', onPress: onSeeAll }} />
      <Card padded={false}>
        {drives.map((d, i) => (
          <View key={d.clientTripId}>
            {i > 0 ? <Divider inset={16} /> : null}
            <DriveRow drive={d} onPress={() => onOpen(d.clientTripId)} testID={`recent-${d.clientTripId}`} />
          </View>
        ))}
      </Card>
    </View>
  );
}

type Challenge = MySummary['challenges'][number];

/** Completed challenges per Freeze (server: `freeze_progress` 0..2, the third grants one). */
export const CHALLENGES_PER_FREEZE = 3;

/** This week's three challenges as a sideways strip. */
export function ChallengesStrip({ challenges, freezeProgress }: { challenges: readonly Challenge[]; freezeProgress?: number }) {
  const t = useTheme();
  if (challenges.length === 0) return null;
  const toFreeze = Math.max(0, Math.min(CHALLENGES_PER_FREEZE - 1, Math.floor(freezeProgress ?? 0)));
  return (
    <View style={{ gap: t.space.sm }} testID="challenges">
      <SectionHeader title="Weekly challenges" />
      <View
        style={{ flexDirection: 'row', alignItems: 'center', gap: t.space.xs }}
        accessible
        accessibilityLabel={`Each challenge is worth 100 points. ${toFreeze} of ${CHALLENGES_PER_FREEZE} toward a Freeze.`}
        testID="challenges-freeze"
      >
        <Ionicons name="snow" size={t.size.iconSm} color={t.colors.freeze} />
        <Text variant="footnote" tone="muted">
          +100 pts each · {toFreeze}/{CHALLENGES_PER_FREEZE} toward a Freeze
        </Text>
      </View>
      <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={{ gap: t.space.md, paddingRight: t.space.lg }} style={{ marginHorizontal: -t.space.lg }}>
        <View style={{ width: t.space.lg - t.space.md }} />
        {[...challenges]
          .sort((a, b) => a.slot - b.slot)
          .map((c) => {
            const value = c.target > 0 ? Math.min(1, c.progress / c.target) : 0;
            return (
              <Card
                key={c.id}
                testID={`challenge-${c.id}`}
                style={{ width: 220 }}
              >
                <View style={{ flexDirection: 'row', alignItems: 'center', gap: t.space.md }}>
                  <ProgressRing
                    value={c.completed ? 1 : value}
                    size={52}
                    strokeWidth={6}
                    tone={c.completed ? 'clean' : 'primary'}
                    accessibilityLabel={`${c.title}: ${c.completed ? 'done' : `${c.progress} of ${c.target}`}`}
                  >
                    {c.completed ? (
                      <Ionicons name="checkmark" size={t.size.icon} color={t.colors.signal.clean.text} />
                    ) : (
                      <Text variant="footnote" style={{ fontWeight: '700' }}>
                        {Math.min(c.progress, c.target)}/{c.target}
                      </Text>
                    )}
                  </ProgressRing>
                  <View style={{ flex: 1 }}>
                    <Text variant="headline" numberOfLines={2}>
                      {c.title}
                    </Text>
                    <Text variant="footnote" tone={c.completed ? 'success' : 'muted'}>
                      {c.completed ? 'Done · +100 pts' : '+100 pts'}
                    </Text>
                  </View>
                </View>
                <Text variant="footnote" tone="muted" numberOfLines={3}>
                  {c.description}
                </Text>
              </Card>
            );
          })}
      </ScrollView>
    </View>
  );
}


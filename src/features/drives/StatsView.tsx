import { Ionicons } from '@expo/vector-icons';
import { statsFrom, type Stat, type StatSums } from '@scoring';
import { useState } from 'react';
import { ScrollView, View } from 'react-native';

import { Banner, Card, Divider, EmptyState, HEALTH_LABEL, HEALTH_SIGNAL, SegmentedControl, Skeleton, Text, useTheme, type StatHealth } from '@/ui';

import { BackHeader } from './BackHeader';
import { formatRate, formatTotal, STAT_GROUPS, STAT_HINT, STAT_LABEL } from './stats';

export type StatsMode = 'rate' | 'total';
export type StatsWindow = '30d' | 'all';

const GLYPH: Record<StatHealth, 'checkmark' | 'remove' | 'alert'> = { green: 'checkmark', yellow: 'remove', red: 'alert' };

function StatRow({ stat, sums, mode }: { stat: Stat; sums: StatSums; mode: StatsMode }) {
  const t = useTheme();
  const shown = mode === 'rate' ? formatRate(stat) : formatTotal(stat, sums);
  const health = mode === 'rate' ? stat.color : null;
  const sig = health ? t.colors.signal[HEALTH_SIGNAL[health]] : null;
  const hint = STAT_HINT[stat.id];
  const spoken = [STAT_LABEL[stat.id], `${shown.value} ${shown.unit}`, health ? HEALTH_LABEL[health] : null].filter(Boolean).join(', ');
  return (
    <View
      testID={`stat-${stat.id}`}
      accessible
      accessibilityLabel={spoken}
      style={{ flexDirection: 'row', alignItems: 'center', gap: t.space.md, paddingHorizontal: t.space.lg, paddingVertical: t.space.md, minHeight: t.size.touch }}
    >
      <View style={{ flex: 1, gap: 2 }}>
        <Text variant="headline">{STAT_LABEL[stat.id]}</Text>
        {hint ? (
          <Text variant="footnote" tone="subtle">
            {hint}
          </Text>
        ) : null}
      </View>
      <View style={{ alignItems: 'flex-end', gap: 2 }}>
        <View style={{ flexDirection: 'row', alignItems: 'baseline', gap: 4 }}>
          <Text variant="stat" style={sig ? { color: sig.text } : undefined} testID={`stat-${stat.id}-value`}>
            {shown.value}
          </Text>
          <Text variant="footnote" tone="muted">
            {shown.unit}
          </Text>
        </View>
        {health && sig ? (
          <View style={{ flexDirection: 'row', alignItems: 'center', gap: 4 }}>
            <View style={{ width: 16, height: 16, borderRadius: 8, backgroundColor: sig.text, alignItems: 'center', justifyContent: 'center' }}>
              <Ionicons name={GLYPH[health]} size={11} color={t.colors.surface} />
            </View>
            <Text variant="caption" style={{ color: sig.text }}>
              {HEALTH_LABEL[health]}
            </Text>
          </View>
        ) : null}
      </View>
    </View>
  );
}

/** All stats: the full table, per 100 mi or totals, over 30 days or all time. */
export function StatsView({
  month,
  all,
  loading,
  error,
  onBack,
}: {
  month: StatSums | undefined;
  all: StatSums | undefined;
  loading: boolean;
  error: boolean;
  onBack: () => void;
}) {
  const t = useTheme();
  const [mode, setMode] = useState<StatsMode>('rate');
  const [window, setWindow] = useState<StatsWindow>('30d');
  const sums = window === '30d' ? month : all;
  const stats = sums ? statsFrom(sums) : [];

  return (
    <ScrollView contentContainerStyle={{ padding: t.space.lg, gap: t.space.lg }} testID="all-stats">
      <BackHeader title="All stats" onBack={onBack} />
      <SegmentedControl
        accessibilityLabel="Show stats as"
        segments={[
          { value: 'rate', label: 'Per 100 mi' },
          { value: 'total', label: 'Totals' },
        ]}
        value={mode}
        onChange={setMode}
        testID="stats-mode"
      />
      <SegmentedControl
        accessibilityLabel="Time window"
        segments={[
          { value: '30d', label: 'Last 30 days' },
          { value: 'all', label: 'All time' },
        ]}
        value={window}
        onChange={setWindow}
        testID="stats-window"
      />
      {error && sums ? <Banner tone="warning" message="Couldn't refresh. Showing what's saved." /> : null}
      {!sums ? (
        loading ? (
          <Skeleton width="100%" height={240} radius={t.radius.card} />
        ) : (
          <EmptyState title="Couldn't load your stats" body="Something went wrong reading this phone's drives. Try again in a moment." icon="alert-circle-outline" />
        )
      ) : sums.drives === 0 ? (
        <EmptyState
          testID="stats-empty"
          title={window === '30d' ? 'No drives in the last 30 days' : 'No drives yet'}
          body="Your stats fill in as you drive."
          icon="stats-chart-outline"
        />
      ) : (
        <>
          {STAT_GROUPS.map((g) => (
            <View key={g.title} style={{ gap: t.space.sm }}>
              <Text variant="title3" accessibilityRole="header">
                {g.title}
              </Text>
              <Card padded={false}>
                {g.ids.map((id, i) => {
                  const stat = stats.find((s) => s.id === id);
                  if (!stat) return null;
                  return (
                    <View key={id}>
                      {i > 0 ? <Divider inset={16} /> : null}
                      <StatRow stat={stat} sums={sums} mode={mode} />
                    </View>
                  );
                })}
              </Card>
            </View>
          ))}
          <Text variant="footnote" tone="subtle">
            {mode === 'rate'
              ? 'Colors compare you to safe-driving targets: green is good, yellow is okay, red needs work.'
              : 'Totals count every scored drive in the window.'}{' '}
            Drives marked as not driving are left out.
          </Text>
        </>
      )}
    </ScrollView>
  );
}

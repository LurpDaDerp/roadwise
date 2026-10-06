import { useMemo } from 'react';
import { RefreshControl, SectionList, View } from 'react-native';

import { Banner, Chip, Divider, EmptyState, Skeleton, Text, useTheme } from '@/ui';

import { BackHeader } from './BackHeader';
import { DriveRow } from './DriveRow';
import { formatMiles, groupByWeek, signedPoints, type WeekGroup } from './format';
import type { HistoryFilter, LocalDrive } from './model';

const FILTERS: { value: Exclude<HistoryFilter, 'all'>; label: string; icon: 'checkmark-circle-outline' | 'trending-down' | 'person-outline' }[] = [
  { value: 'clean', label: 'Clean', icon: 'checkmark-circle-outline' },
  { value: 'negative', label: 'Negative', icon: 'trending-down' },
  { value: 'passenger', label: 'Passenger', icon: 'person-outline' },
];

const EMPTY: Record<HistoryFilter, { title: string; body: string }> = {
  all: { title: 'No drives yet', body: 'Tap Start drive on Home before you pull out. Every drive shows up here.' },
  clean: { title: 'No clean drives yet', body: 'A drive with zero events counts as clean. Your next one could be it.' },
  negative: { title: 'No negative drives', body: 'Nice. None of your drives went below zero.' },
  passenger: { title: 'No passenger drives', body: "Drives you mark as “Wasn't driving” show up here." },
};

export type HistoryViewProps = {
  drives: readonly LocalDrive[] | undefined;
  loading: boolean;
  error: boolean;
  filter: HistoryFilter;
  onFilter: (f: HistoryFilter) => void;
  onOpen: (clientTripId: string) => void;
  onBack: () => void;
  onHome: () => void;
  onRefresh?: () => void;
  refreshing?: boolean;
  /** Rounded (to the hour) by the caller, so the week grouping is memoised across renders. */
  now: number;
};

function WeekHeader({ group }: { group: WeekGroup }) {
  const t = useTheme();
  const n = group.data.length;
  const summary = `${n} ${n === 1 ? 'drive' : 'drives'} · ${formatMiles(group.miles)} · ${signedPoints(group.points)} pts`;
  return (
    <View
      testID={group.key}
      accessible
      accessibilityRole="header"
      accessibilityLabel={`${group.title}, ${summary.replace(/ · /g, ', ')}`}
      style={{ flexDirection: 'row', alignItems: 'baseline', justifyContent: 'space-between', paddingTop: t.space.xl, paddingBottom: t.space.sm, gap: t.space.sm, backgroundColor: t.colors.bg }}
    >
      <Text variant="title3">{group.title}</Text>
      <Text variant="footnote" tone="muted" style={{ flexShrink: 1, textAlign: 'right' }}>
        {summary}
      </Text>
    </View>
  );
}

/** Drive history: every drive, newest first, grouped by week, with three filters. */
export function HistoryView({ drives, loading, error, filter, onFilter, onOpen, onBack, onHome, onRefresh, refreshing = false, now }: HistoryViewProps) {
  const t = useTheme();
  const sections = useMemo(() => groupByWeek(drives ?? [], now), [drives, now]);

  const header = (
    <View style={{ gap: t.space.md }}>
      <BackHeader title="Your drives" onBack={onBack} />
      <View style={{ flexDirection: 'row', gap: t.space.sm, flexWrap: 'wrap' }} accessibilityLabel="Filter drives">
        {FILTERS.map((f) => (
          <Chip
            key={f.value}
            label={f.label}
            icon={f.icon}
            selected={filter === f.value}
            onPress={() => onFilter(filter === f.value ? 'all' : f.value)}
            testID={`filter-${f.value}`}
          />
        ))}
      </View>
      {error && drives ? <Banner tone="warning" message="Couldn't refresh your drives. Showing what's saved." /> : null}
    </View>
  );

  const empty = () => {
    if (drives === undefined && loading) {
      return (
        <View style={{ gap: t.space.md, paddingTop: t.space.xl }} testID="history-loading">
          {[0, 1, 2].map((i) => (
            <Skeleton key={i} width="100%" height={80} radius={t.radius.card} />
          ))}
        </View>
      );
    }
    if (drives === undefined && error) {
      return <EmptyState title="Couldn't load your drives" body="Something went wrong reading this phone's drives. Try again in a moment." icon="alert-circle-outline" />;
    }
    const e = EMPTY[filter];
    return (
      <View style={{ paddingTop: t.space.xl }} testID={`history-empty-${filter}`}>
        <EmptyState
          title={e.title}
          body={e.body}
          icon="car-outline"
          action={filter === 'all' ? { label: 'Go to Home', onPress: onHome } : { label: 'Show all drives', onPress: () => onFilter('all') }}
        />
      </View>
    );
  };

  return (
    <SectionList
      testID="drive-history"
      style={{ flex: 1, backgroundColor: t.colors.bg }}
      contentContainerStyle={{ paddingHorizontal: t.space.lg, paddingTop: t.space.lg, paddingBottom: t.space.xxxl }}
      sections={sections}
      keyExtractor={(d) => d.clientTripId}
      stickySectionHeadersEnabled={false}
      initialNumToRender={10}
      maxToRenderPerBatch={10}
      windowSize={7}
      removeClippedSubviews
      ListHeaderComponent={header}
      ListEmptyComponent={empty}
      renderSectionHeader={({ section }) => <WeekHeader group={section} />}
      renderItem={({ item, index, section }) => {
        const first = index === 0;
        const last = index === section.data.length - 1;
        return (
          <View
            style={{
              backgroundColor: t.colors.surface,
              borderTopLeftRadius: first ? t.radius.card : 0,
              borderTopRightRadius: first ? t.radius.card : 0,
              borderBottomLeftRadius: last ? t.radius.card : 0,
              borderBottomRightRadius: last ? t.radius.card : 0,
              borderCurve: 'continuous',
              overflow: 'hidden',
            }}
          >
            {first ? null : <Divider inset={16} />}
            <DriveRow drive={item} onPress={() => onOpen(item.clientTripId)} testID={`drive-${item.clientTripId}`} />
          </View>
        );
      }}
      refreshControl={onRefresh ? <RefreshControl refreshing={refreshing} onRefresh={onRefresh} /> : undefined}
      ListFooterComponent={
        sections.length > 0 ? (
          <Text variant="footnote" tone="subtle" style={{ textAlign: 'center', paddingTop: t.space.xl }}>
            Recorded drives can't be deleted.
          </Text>
        ) : null
      }
    />
  );
}


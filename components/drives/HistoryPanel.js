// HistoryPanel — the History tab of the Drives screen: a summary strip, the
// drive list grouped by day, and "Load more" pagination.
import React, { useMemo } from 'react';
import { View, StyleSheet } from 'react-native';
import {
  Button,
  Card,
  EmptyState,
  Eyebrow,
  Section,
  Skeleton,
  StatCell,
  StatDivider,
  useTheme,
} from '../../theme';
import { formatDayHeading, formatDistance, toDate } from '../../utils/format';
import { DriveRow } from './DriveRow';

function dayKey(ts) {
  const d = toDate(ts);
  if (isNaN(d)) return 'unknown';
  return `${d.getFullYear()}-${d.getMonth()}-${d.getDate()}`;
}

function groupByDay(list) {
  const groups = [];
  let current = null;
  for (const drive of list) {
    const key = dayKey(drive.timestamp);
    if (!current || current.key !== key) {
      current = { key, heading: formatDayHeading(drive.timestamp) || 'Earlier', items: [] };
      groups.push(current);
    }
    current.items.push(drive);
  }
  return groups;
}

function SkeletonRow({ first }) {
  const t = useTheme();
  return (
    <View
      style={{
        flexDirection: 'row',
        alignItems: 'center',
        paddingVertical: 16,
        paddingHorizontal: 18,
        borderTopWidth: first ? 0 : StyleSheet.hairlineWidth,
        borderTopColor: t.colors.divider,
      }}
    >
      <Skeleton width={38} height={38} radius={19} />
      <View style={{ flex: 1, marginLeft: 14, gap: 8 }}>
        <Skeleton width="55%" height={13} />
        <Skeleton width="38%" height={11} />
      </View>
      <Skeleton width={34} height={20} radius={999} />
    </View>
  );
}

// drives: the pages loaded so far (server pagination); counts: { total, distracted,
// focused } from count queries, so the summary is right even before every page is in.
export function HistoryPanel({
  drives = [],
  counts = null,
  loading = false,
  hasMore = false,
  loadingMore = false,
  onLoadMore,
  unit = 'mph',
  onSelectDrive,
}) {
  const t = useTheme();

  const total = counts ? counts.total : drives.length;
  const focusedPct = counts && counts.total > 0 ? Math.round((counts.focused / counts.total) * 100) : null;
  const monthMeters = useMemo(() => {
    const now = new Date();
    return drives.reduce((sum, d) => {
      const dt = toDate(d.timestamp);
      if (isNaN(dt) || dt.getFullYear() !== now.getFullYear() || dt.getMonth() !== now.getMonth()) {
        return sum;
      }
      return sum + (Number(d.totalDistance) || 0);
    }, 0);
  }, [drives]);

  const groups = useMemo(() => groupByDay(drives), [drives]);

  if (loading && drives.length === 0) {
    return (
      <Section label="History">
        <Card padded={false}>
          {[0, 1, 2, 3].map((i) => (
            <SkeletonRow key={i} first={i === 0} />
          ))}
        </Card>
      </Section>
    );
  }

  return (
    <View>
      <Section label="Summary">
        <Card>
          <View style={{ flexDirection: 'row' }}>
            <StatCell label="Drives" value={String(total)} size="sm" />
            <StatDivider />
            <StatCell
              label="Focused"
              value={focusedPct === null ? '—' : `${focusedPct}%`}
              size="sm"
              color={t.colors.accent}
            />
            <StatDivider />
            <StatCell label="This month" value={formatDistance(monthMeters, unit)} size="sm" />
          </View>
        </Card>
      </Section>

      <Section label="History">
        {drives.length === 0 ? (
          <Card>
            <EmptyState
              icon="car-outline"
              title="No drives yet"
              body="Start a drive from Home to begin earning points."
            />
          </Card>
        ) : (
          <View style={{ gap: 18 }}>
            {groups.map((group) => (
              <View key={group.key}>
                <Eyebrow tone="muted" style={{ marginBottom: 8, marginLeft: 4 }}>
                  {group.heading}
                </Eyebrow>
                <Card padded={false}>
                  {group.items.map((drive, i) => (
                    <DriveRow
                      key={drive.id || `${group.key}-${i}`}
                      drive={drive}
                      unit={unit}
                      first={i === 0}
                      onPress={() => onSelectDrive && onSelectDrive(drive)}
                    />
                  ))}
                </Card>
              </View>
            ))}
          </View>
        )}

        {hasMore && (
          <View style={{ marginTop: 14 }}>
            <Button
              title={loadingMore ? 'Loading…' : 'Load more'}
              variant="ghost"
              disabled={loadingMore}
              onPress={onLoadMore}
            />
          </View>
        )}
      </Section>
    </View>
  );
}

export default HistoryPanel;

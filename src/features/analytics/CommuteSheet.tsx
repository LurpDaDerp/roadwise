import { Ionicons } from '@expo/vector-icons';
import { Fragment, useMemo, useState, type ComponentProps, type ReactNode } from 'react';
import { View } from 'react-native';

import type { ProblemSpot } from '@/data/queries/spots';
import { useUnits } from '@/data/queries/units';
import { formatDuration, formatWhen } from '@/features/drives/format';
import { spotsCopy } from '@/features/spots/copy';
import { howOften, spotTitle } from '@/features/spots/format';
import { SpotDisc } from '@/features/spots/SpotsCard';
import { BottomSheet, Divider, ListRow, Text, useTheme } from '@/ui';

import { analyticsCopy } from './copy';
import { changeKind, clockOfMinute, COMMUTE_RECENT_DRIVES, commuteText, scoreSpan, spotsOnTheWay, type CommuteRow } from './commuteModel';
import { driveLine } from './DrivesCard';

const c = analyticsCopy.commute;
const s = c.sheet;
const NO_SPOTS: readonly ProblemSpot[] = [];

/** One fact: a muted icon, a headline and a muted line under it. */
function Block({ icon, title, line, testID }: { icon: ComponentProps<typeof Ionicons>['name']; title: string; line: string; testID: string }) {
  const t = useTheme();
  return (
    <View testID={testID} accessible accessibilityLabel={`${title}, ${line}`} style={{ flexDirection: 'row', gap: t.space.md, alignItems: 'flex-start' }}>
      <View style={{ width: 24, alignItems: 'center', paddingTop: 1 }}>
        <Ionicons name={icon} size={20} color={t.colors.textMuted} />
      </View>
      <View style={{ flex: 1, gap: 2 }}>
        <Text variant="headline">{title}</Text>
        <Text variant="subhead" tone="muted">
          {line}
        </Text>
      </View>
    </View>
  );
}

/** A titled group of rows, their text lined up with the sheet's. */
function Group({ title, children, testID }: { title: string; children: ReactNode; testID: string }) {
  const t = useTheme();
  return (
    <View testID={testID} style={{ gap: t.space.xs }}>
      <Text variant="headline" accessibilityRole="header">
        {title}
      </Text>
      <View style={{ marginHorizontal: -t.space.lg }}>{children}</View>
    </View>
  );
}

/**
 * One commute leg up close: its usual drive time, when the driver usually leaves (when they keep
 * to a time), its score and how it moved, the problem spots most of its drives pass (each opening
 * its sheet) and its newest drives (each opening the drive). It keeps the last leg it showed while
 * it slides away. The spots on the way are read only while the sheet is up, and again only when its
 * drives or the spots change.
 */
export function CommuteSheet({
  row,
  visible,
  onClose,
  onDismiss,
  spots = NO_SPOTS,
  onOpenSpot,
  onOpenDrive,
}: {
  row: CommuteRow | null;
  visible: boolean;
  onClose: () => void;
  /** Called once the sheet has left the screen (the spot sheet opens from here). */
  onDismiss?: () => void;
  /** The active problem spots, in rank order. */
  spots?: readonly ProblemSpot[];
  onOpenSpot: (id: string) => void;
  onOpenDrive: (clientTripId: string) => void;
}) {
  const t = useTheme();
  const units = useUnits();
  // The last leg shown stays while the sheet slides away, so its words don't blank on the way out.
  const [last, setLast] = useState<CommuteRow | null>(row);
  if (row !== null && row !== last) setLast(row);
  const shown = row ?? last;
  const legDrives = shown?.drives;
  const open = visible && row !== null;
  // The inputs follow the leg only while the sheet is up; closed, they hold still, so the last answer stays for the slide out and no work is done as the drives or spots change.
  const [seen, setSeen] = useState({ drives: legDrives, spots });
  if (open && (seen.drives !== legDrives || seen.spots !== spots)) setSeen({ drives: legDrives, spots });
  const onTheWay = useMemo(() => (seen.drives === undefined ? NO_SPOTS : spotsOnTheWay(seen.spots, seen.drives)), [seen]);

  if (shown === null) {
    return (
      <BottomSheet visible={false} onClose={onClose} testID="commute-sheet">
        {null}
      </BottomSheet>
    );
  }
  const text = commuteText(shown);
  const span = scoreSpan(shown.scored);
  const recent = shown.drives.slice(0, COMMUTE_RECENT_DRIVES);
  return (
    <BottomSheet
      visible={open}
      onClose={onClose}
      onDismiss={onDismiss}
      title={text.title}
      scroll
      testID="commute-sheet"
      contentStyle={{ gap: t.space.lg }}
    >
      <Block icon="time-outline" title={c.usually(formatDuration(shown.usualS))} line={s.usualLine(shown.drives.length)} testID="commute-usual" />
      {shown.departure !== null ? <Block icon="alarm-outline" title={c.leave(clockOfMinute(shown.departure.minuteOfDay))} line={s.leaveLine} testID="commute-leave" /> : null}
      {shown.score !== null ? (
        <Block icon="speedometer-outline" title={c.score(shown.score)} line={s.scoreLine(span.recent, span.before, changeKind(shown.change), shown.change ?? 0)} testID="commute-score" />
      ) : null}
      {onTheWay.length > 0 ? (
        <Group title={s.spots} testID="commute-spots">
          {onTheWay.map((spot, i) => {
            const title = spotTitle(spot);
            const kind = spotsCopy.kindTitle[spot.kind];
            const often = howOften(spot);
            return (
              <Fragment key={spot.id}>
                {i > 0 ? <Divider inset={t.space.lg} /> : null}
                <ListRow
                  title={title}
                  subtitle={`${kind} · ${often}`}
                  leading={<SpotDisc spot={spot} />}
                  onPress={() => onOpenSpot(spot.id)}
                  accessibilityLabel={`${title}, ${kind}, ${often}`}
                  accessibilityHint={s.spotHint}
                  testID={`commute-spot-${spot.id}`}
                />
              </Fragment>
            );
          })}
        </Group>
      ) : null}
      <Group title={s.recent} testID="commute-drives">
        {recent.map((d, i) => {
          const when = formatWhen(d.startedAt);
          const line = driveLine(d, units);
          return (
            <Fragment key={d.clientTripId}>
              {i > 0 ? <Divider inset={t.space.lg} /> : null}
              <ListRow
                title={when}
                subtitle={line.text}
                onPress={() => onOpenDrive(d.clientTripId)}
                accessibilityLabel={`${when}, ${line.spoken}`}
                accessibilityHint={s.driveHint}
                testID={`commute-drive-${d.clientTripId}`}
              />
            </Fragment>
          );
        })}
      </Group>
    </BottomSheet>
  );
}

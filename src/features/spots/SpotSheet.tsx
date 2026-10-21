import { Ionicons } from '@expo/vector-icons';
import { useState, type ReactNode } from 'react';
import { View } from 'react-native';

import type { ProblemSpot } from '@/data/queries/spots';
import { useUnits } from '@/data/queries/units';
import { EventIcon } from '@/features/drives/EventIcon';
import { formatWhen } from '@/features/drives/format';
import { BottomSheet, Button, Text, useTheme } from '@/ui';

import { spotsCopy } from './copy';
import { dirWord, howOften, progress, spotTitle, whatHappens } from './format';

const s = spotsCopy.sheet;

/** One block of the sheet: a muted icon, a headline and a muted line under it, and an optional action. */
function Block({ icon, title, line, action, testID }: { icon: ReactNode; title: string; line?: string | null; action?: ReactNode; testID?: string }) {
  const t = useTheme();
  return (
    <View testID={testID} style={{ flexDirection: 'row', gap: t.space.md, alignItems: 'flex-start' }}>
      <View accessibilityElementsHidden importantForAccessibility="no-hide-descendants" style={{ width: 24, alignItems: 'center', paddingTop: 1 }}>
        {icon}
      </View>
      <View style={{ flex: 1, gap: 2 }}>
        <Text variant="headline">{title}</Text>
        {line ? (
          <Text variant="subhead" tone="muted">
            {line}
          </Text>
        ) : null}
      </View>
      {action}
    </View>
  );
}

/**
 * One spot up close: what happens there and how often, the last time with a way to that drive,
 * how many clean drives in a row it has and how many more clear it, one tip, and the line the
 * driving screen shows there. The parent closes it when the spot leaves the list; it keeps the
 * last spot it showed while it slides away.
 */
export function SpotSheet({
  spot,
  visible,
  onClose,
  onOpenDrive,
}: {
  spot: ProblemSpot | null;
  visible: boolean;
  onClose: () => void;
  /** Opens a drive's summary (the spot's latest drive with the event). */
  onOpenDrive: (clientTripId: string) => void;
}) {
  const t = useTheme();
  const units = useUnits();
  // The last spot shown stays while the sheet slides away, so its words don't blank on the way out.
  const [last, setLast] = useState<ProblemSpot | null>(spot);
  if (spot !== null && spot !== last) setLast(spot);
  const shown = spot ?? last;
  const muted = t.colors.textMuted;

  if (shown === null) {
    return (
      <BottomSheet visible={false} onClose={onClose} testID="spot-sheet">
        {null}
      </BottomSheet>
    );
  }
  const step = progress(shown);
  const dir = dirWord(shown.headingDeg);
  return (
    <BottomSheet
      visible={visible && spot !== null}
      onClose={onClose}
      title={spotTitle(shown)}
      subtitle={s.subtitle(spotsCopy.kindTitle[shown.kind], dir)}
      scroll
      testID="spot-sheet"
      contentStyle={{ gap: t.space.lg }}
    >
      <Block icon={<EventIcon type={shown.kind} size={20} color={muted} />} title={whatHappens(shown, units)} line={howOften(shown)} testID="spot-what" />
      <Block
        icon={<Ionicons name="time-outline" size={20} color={muted} />}
        title={s.lastTime}
        line={formatWhen(shown.lastHitAt)}
        action={
          <Button
            label={s.openDrive}
            variant="ghost"
            size="sm"
            accessibilityHint={s.openDriveLabel}
            onPress={() => {
              onClose();
              onOpenDrive(shown.lastHitTrip);
            }}
            testID="spot-open-drive"
          />
        }
        testID="spot-last"
      />
      <Block icon={<Ionicons name="trending-up-outline" size={20} color={muted} />} title={step.title} line={step.line} testID="spot-progress" />
      <Text variant="callout" testID="spot-tip">
        {s.tip[shown.kind]}
      </Text>
      <Text variant="footnote" tone="muted" testID="spot-hud-note">
        {s.hudNote(spotsCopy.nudge[shown.kind])}
      </Text>
    </BottomSheet>
  );
}

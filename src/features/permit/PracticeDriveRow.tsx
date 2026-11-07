// The recap's row on a practice drive (in the score card): "Practice drive", then how long, the
// minutes at night and who supervised, with Change (Add supervisor when none is set) opening a
// sheet that sets this drive's supervisor only.
import { Ionicons } from '@expo/vector-icons';
import { useState } from 'react';
import { View } from 'react-native';

import { formatDuration } from '@/features/drives/format';
import { Button, Text, useTheme } from '@/ui';

import { permitCopy } from './copy';
import { NameSheet } from './PermitSheets';
import type { PracticeDriveView } from './usePermit';

const copy = permitCopy.recap;

/** The row's line: "1 h 05 min · 12 min at night · with Dad". */
export const practiceLine = (p: PracticeDriveView): string => copy.line(formatDuration((p.dayMin + p.nightMin) * 60), p.nightMin, p.supervisor);

export function PracticeDriveRow({ practice, onSupervisor }: { practice: PracticeDriveView; onSupervisor: (name: string) => Promise<boolean> }) {
  const t = useTheme();
  const [editing, setEditing] = useState(false);
  const line = practiceLine(practice);
  return (
    <View style={{ flexDirection: 'row', alignItems: 'center', gap: t.space.sm, paddingTop: t.space.sm }} testID="summary-practice">
      <Ionicons name="school-outline" size={t.size.icon} color={t.colors.textMuted} />
      <View style={{ flex: 1, minWidth: 0 }} accessible accessibilityLabel={`${copy.title}. ${line}`}>
        <Text variant="subhead">{copy.title}</Text>
        <Text variant="footnote" tone="muted" testID="summary-practice-line">
          {line}
        </Text>
      </View>
      <Button label={practice.supervisor === null ? copy.add : copy.change} variant="ghost" size="sm" onPress={() => setEditing(true)} testID="summary-practice-change" />
      <NameSheet
        visible={editing}
        copy={{ sheetTitle: copy.sheetTitle, body: copy.body, label: permitCopy.supervisor.label, placeholder: permitCopy.supervisor.placeholder, save: permitCopy.supervisor.save }}
        initial={practice.supervisor}
        onSave={onSupervisor}
        onClose={() => setEditing(false)}
        testID="summary-practice-sheet"
      />
    </View>
  );
}

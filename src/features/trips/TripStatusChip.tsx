import { Ionicons } from '@expo/vector-icons';
import { View } from 'react-native';

import { Text, useTheme } from '@/ui';

import { tripCopy as copy } from './copy';

export type TripStatusChipKind = 'willSync' | 'recovered';

const CHIP: Record<TripStatusChipKind, { icon: keyof typeof Ionicons.glyphMap; text: string }> = {
  willSync: { icon: 'cloud-upload-outline', text: copy.chips.willSync },
  recovered: { icon: 'flag-outline', text: copy.chips.recovered },
};

/**
 * A small printed chip on the card: "Will sync" while the upload is owed (§7.0 offline
 * convention), "Recovered" on a drive crash recovery finalized (§19.1). A glyph and a word, so
 * neither state rides on colour; not a control, so it has no minimum target.
 */
export function TripStatusChip({ kind, testID }: { kind: TripStatusChipKind; testID?: string }) {
  const th = useTheme();
  const { icon, text } = CHIP[kind];
  return (
    <View
      testID={testID}
      accessible
      accessibilityRole="text"
      accessibilityLabel={text}
      style={{
        flexDirection: 'row',
        alignItems: 'center',
        gap: th.space.xs,
        alignSelf: 'flex-start',
        paddingHorizontal: th.space.sm,
        paddingVertical: 2,
        borderRadius: th.radius.pill,
        borderWidth: 1,
        borderColor: th.colors.borderStrong,
        backgroundColor: th.colors.surface,
      }}
    >
      <Ionicons name={icon} size={14} color={th.colors.textMuted} />
      <Text variant="caption" tone="muted">
        {text}
      </Text>
    </View>
  );
}

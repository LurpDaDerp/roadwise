import { Ionicons } from '@expo/vector-icons';
import { Pressable, View } from 'react-native';

import type { Tip } from '@/content/tips';
import { Text, useTheme } from '@/ui';

import { tripCopy as copy } from './copy';

/** The first sentence of a two-or-three-sentence body: enough to decide whether to read on. */
export function firstSentence(body: string): string {
  const match = /^.*?[.!?](?=\s|$)/.exec(body);
  return match ? match[0] : body;
}

/**
 * The one tip card on the card back (§7.D D1 → D6): a drawn mark, the title, the opening
 * sentence and a chevron. It is a button, and says so: "Tip: Leave a three-second gap".
 */
export function TipCard({ tip, onPress, testID }: { tip: Tip; onPress: () => void; testID?: string }) {
  const th = useTheme();
  return (
    <Pressable
      testID={testID}
      accessibilityRole="button"
      accessibilityLabel={`${copy.tip.label}: ${tip.title}`}
      accessibilityHint={copy.tip.hint}
      onPress={onPress}
      style={({ pressed }) => ({
        flexDirection: 'row',
        alignItems: 'center',
        gap: th.space.md,
        minHeight: 64,
        padding: th.space.lg,
        borderRadius: th.radius.md,
        borderWidth: 1,
        borderColor: th.colors.border,
        backgroundColor: pressed ? th.colors.surfaceRaised : th.colors.surface,
      })}
    >
      <Ionicons name="bulb-outline" size={24} color={th.colors.accent} />
      <View style={{ flex: 1, gap: 2 }}>
        <Text variant="headline">{tip.title}</Text>
        <Text variant="subhead" tone="muted">
          {firstSentence(tip.body)}
        </Text>
      </View>
      <Ionicons name="chevron-forward" size={18} color={th.colors.textSubtle} />
    </Pressable>
  );
}

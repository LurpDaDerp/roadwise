import { Ionicons } from '@expo/vector-icons';
import { useState } from 'react';
import { Pressable, View } from 'react-native';

import { Card, Text, useTheme } from '@/ui';

import { hubCopy } from '../copy/hub';

const copy = hubCopy.how;

/**
 * The rules in plain words (§R1–§R5), folded by default: points and what they are not, class,
 * streak and shields, the weekly goal, when a day is confirmed (after which it never changes), and
 * that nothing is earned while driving. No sentence says a later correction changes a confirmed day.
 */
export function HowRewardsWork({ initiallyOpen = false }: { initiallyOpen?: boolean }) {
  const th = useTheme();
  const [open, setOpen] = useState(initiallyOpen);
  return (
    <Card padded={false} testID="hub-how">
      <Pressable
        testID="hub-how-toggle"
        accessibilityRole="button"
        accessibilityLabel={copy.title}
        accessibilityHint={open ? copy.hintClose : copy.hintOpen}
        accessibilityState={{ expanded: open }}
        onPress={() => setOpen((o) => !o)}
        style={({ pressed }) => ({
          minHeight: 56,
          flexDirection: 'row',
          alignItems: 'center',
          gap: th.space.md,
          paddingHorizontal: th.space.lg,
          paddingVertical: th.space.md,
          backgroundColor: pressed ? th.colors.surfaceRaised : 'transparent',
        })}
      >
        <Text variant="headline" style={{ flex: 1 }}>
          {copy.title}
        </Text>
        <Ionicons name={open ? 'chevron-up' : 'chevron-down'} size={18} color={th.colors.accent} />
      </Pressable>
      {open ? (
        <View style={{ gap: th.space.md, paddingHorizontal: th.space.lg, paddingBottom: th.space.lg }} testID="hub-how-body">
          {copy.paragraphs.map((p) => (
            <Text key={p} variant="subhead">
              {p}
            </Text>
          ))}
        </View>
      ) : null}
    </Card>
  );
}

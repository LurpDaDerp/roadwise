import { Pressable, View } from 'react-native';

import { Card, IconButton, Text, useTheme } from '@/ui';

import { dashpalCopy } from '../copy';
import type { CardKind } from '../detector';
import { DashpalIllustration } from './wizard/DashpalIllustration';

const copy = dashpalCopy.wizard.card;

/**
 * Home's DashPal card: a DashPal ready to pair nearby ("Pair DashPal-XXXX?"), or this phone's own
 * DashPal once it no longer knows this phone ("Set up DashPal-XXXX again?"). The card is one button
 * that opens setup; its ✕ is "Not now" (also the screen reader's action).
 */
export function PairCard({ kind, name, onOpen, onNotNow }: { kind: CardKind; name: string; onOpen(): void; onNotNow(): void }) {
  const th = useTheme();
  const words = kind === 'again' ? copy.again : copy.new;
  const title = words.title(name);
  return (
    <Card padded={false} testID="home-dashpal-pair">
      <View style={{ flexDirection: 'row', alignItems: 'center' }}>
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={title}
          accessibilityHint={copy.hint}
          accessibilityActions={[{ name: 'notNow', label: copy.notNow }]}
          onAccessibilityAction={(e) => {
            if (e.nativeEvent.actionName === 'notNow') onNotNow();
          }}
          onPress={onOpen}
          style={({ pressed }) => ({
            flex: 1,
            flexDirection: 'row',
            alignItems: 'center',
            gap: th.space.md,
            padding: th.space.lg,
            paddingRight: th.space.xs,
            opacity: pressed ? 0.7 : 1,
          })}
          testID="home-dashpal-pair-open"
        >
          <DashpalIllustration glyph />
          <View style={{ flex: 1, gap: th.space.xs }}>
            <Text variant="headline" testID="home-dashpal-pair-title">
              {title}
            </Text>
            <Text variant="callout" tone="muted" testID="home-dashpal-pair-subtitle">
              {words.subtitle}
            </Text>
          </View>
        </Pressable>
        <IconButton icon="close" accessibilityLabel={copy.notNow} onPress={onNotNow} style={{ marginRight: th.space.sm }} testID="home-dashpal-pair-not-now" />
      </View>
    </Card>
  );
}
